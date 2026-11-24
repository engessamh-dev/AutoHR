//! Offline text reading for identity documents (national card, passport).
//!
//! Two small PaddleOCR PP-OCRv5 models (Apache-2.0, see models/NOTICE.md) run on the device with
//! the pure-Rust `tract` runtime: a text-line detector and an Arabic-script recogniser that also
//! reads Latin letters and digits. No image or text ever leaves the computer, and nothing read
//! here is stored: the caller shows the values to the user, who confirms them.
use image::{imageops::FilterType, DynamicImage, GrayImage, Luma, RgbImage};
use imageproc::{geometry::min_area_rect, point::Point, region_labelling::{connected_components, Connectivity}};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
};
use tract_onnx::prelude::*;

const DET_BYTES: &[u8] = include_bytes!("../models/ocr_det.onnx");
const REC_BYTES: &[u8] = include_bytes!("../models/ocr_rec_ar.onnx");
const DICT: &str = include_str!("../models/ocr_ar_dict.txt");
/// The detector runs on a fixed square canvas (tract cannot optimise its graph with free sizes).
const DET_SIZE: usize = 1024;
const REC_HEIGHT: usize = 48;
/// Recogniser input widths; a line is padded to the next one. Each is optimised once, on first use.
const REC_WIDTHS: [usize; 6] = [160, 320, 640, 960, 1280, 1920];

type Model = Arc<TypedRunnableModel>;

/// One line of text as read, with its position in the (orientation-corrected) image.
#[derive(Debug, Clone)]
pub struct Line {
    /// Text in logical (reading) order: Arabic right-to-left runs reversed, digits and Latin kept.
    pub text: String,
    /// Mean probability of the recognised characters, 0..1.
    pub confidence: f32,
    /// Bounding box: left, top, right, bottom in image pixels.
    pub bbox: [f32; 4],
}

impl Line {
    pub fn center_y(&self) -> f32 { (self.bbox[1] + self.bbox[3]) / 2. }
    pub fn height(&self) -> f32 { self.bbox[3] - self.bbox[1] }
}

fn det_model() -> Option<&'static Model> {
    static MODEL: OnceLock<Option<Model>> = OnceLock::new();
    MODEL
        .get_or_init(|| {
            tract_onnx::onnx()
                .model_for_read(&mut std::io::Cursor::new(DET_BYTES))
                .and_then(|m| m.with_input_fact(0, f32::fact([1, 3, DET_SIZE, DET_SIZE]).into()))
                .and_then(|m| m.into_optimized())
                .and_then(|m| m.into_runnable())
                .ok()
        })
        .as_ref()
}

fn rec_model(width: usize) -> Option<Model> {
    static PARSED: OnceLock<Option<InferenceModel>> = OnceLock::new();
    static BUILT: OnceLock<Mutex<HashMap<usize, Model>>> = OnceLock::new();
    let built = BUILT.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(model) = built.lock().ok()?.get(&width) {
        return Some(model.clone());
    }
    let parsed = PARSED
        .get_or_init(|| tract_onnx::onnx().model_for_read(&mut std::io::Cursor::new(REC_BYTES)).ok())
        .as_ref()?
        .clone();
    let model: Model = parsed
        .with_input_fact(0, f32::fact([1, 3, REC_HEIGHT, width]).into())
        .and_then(|m| m.into_optimized())
        .and_then(|m| m.into_runnable())
        .ok()?;
    built.lock().ok()?.insert(width, model.clone());
    Some(model)
}

fn charset() -> &'static [String] {
    static CHARS: OnceLock<Vec<String>> = OnceLock::new();
    CHARS.get_or_init(|| {
        // CTC: index 0 is the blank, then the dictionary, then a space.
        let mut chars = vec![String::new()];
        chars.extend(DICT.lines().map(str::to_owned));
        chars.push(" ".into());
        chars
    })
}

/// Whether both bundled models load on this machine.
pub fn available() -> bool {
    det_model().is_some() && rec_model(REC_WIDTHS[1]).is_some()
}

/// Text-line probability map for the image, scaled into the fixed detector canvas.
/// Returns the map and the scale from canvas to image pixels.
fn probability_map(image: &RgbImage) -> Option<(GrayImage, f32)> {
    let model = det_model()?;
    let (w, h) = image.dimensions();
    let scale = DET_SIZE as f32 / w.max(h) as f32;
    let (nw, nh) = (((w as f32 * scale).round() as u32).clamp(1, DET_SIZE as u32), ((h as f32 * scale).round() as u32).clamp(1, DET_SIZE as u32));
    let resized = image::imageops::resize(image, nw, nh, FilterType::Triangle);
    let mean = [0.485f32, 0.456, 0.406];
    let std = [0.229f32, 0.224, 0.225];
    let input: Tensor = tract_ndarray::Array4::from_shape_fn((1, 3, DET_SIZE, DET_SIZE), |(_, c, y, x)| {
        if x as u32 >= nw || y as u32 >= nh {
            return 0.;
        }
        // The model was trained on BGR input.
        (f32::from(resized.get_pixel(x as u32, y as u32)[2 - c]) / 255. - mean[c]) / std[c]
    })
    .into();
    let outputs = model.run(tvec!(input.into())).ok()?;
    let map = outputs.first()?.to_plain_array_view::<f32>().ok()?;
    let prob = GrayImage::from_fn(nw, nh, |x, y| Luma([(map[[0, 0, y as usize, x as usize]].clamp(0., 1.) * 255.) as u8]));
    Some((prob, 1. / scale))
}

/// Text boxes as rotated rectangles (TL, TR, BR, BL) in image pixels.
fn detect_boxes(image: &RgbImage) -> Vec<[[f32; 2]; 4]> {
    let Some((prob, scale)) = probability_map(image) else { return Vec::new() };
    let mask = GrayImage::from_fn(prob.width(), prob.height(), |x, y| Luma([if prob.get_pixel(x, y)[0] >= 77 { 255 } else { 0 }]));
    let labels = connected_components(&mask, Connectivity::Eight, Luma([0u8]));
    let mut regions: HashMap<u32, (Vec<Point<i32>>, u64)> = HashMap::new();
    for (x, y, label) in labels.enumerate_pixels() {
        if label[0] == 0 {
            continue;
        }
        let entry = regions.entry(label[0]).or_default();
        entry.0.push(Point::new(x as i32, y as i32));
        entry.1 += u64::from(prob.get_pixel(x, y)[0]);
    }
    let mut boxes = Vec::new();
    for (points, total) in regions.values() {
        if points.len() < 12 || (*total as f32 / points.len() as f32) < 0.6 * 255. {
            continue;
        }
        let rect = min_area_rect(points);
        let corners = crate::scanner::order_corners(rect.iter().map(|p| [p.x as f32, p.y as f32]).collect());
        let width = dist(corners[0], corners[1]);
        let height = dist(corners[0], corners[3]);
        if width.min(height) < 3. {
            continue;
        }
        // DB "unclip": grow the shrunk text kernel back by area * 1.5 / perimeter.
        let grow = width * height * 1.5 / (2. * (width + height));
        boxes.push(expand(corners, grow).map(|[x, y]| [x * scale, y * scale]));
    }
    boxes
}

fn dist(a: [f32; 2], b: [f32; 2]) -> f32 { ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2)).sqrt() }

fn expand(c: [[f32; 2]; 4], by: f32) -> [[f32; 2]; 4] {
    let unit = |a: [f32; 2], b: [f32; 2]| {
        let d = dist(a, b).max(1e-3);
        [(b[0] - a[0]) / d, (b[1] - a[1]) / d]
    };
    let ux = unit(c[0], c[1]);
    let uy = unit(c[0], c[3]);
    let shift = |p: [f32; 2], sx: f32, sy: f32| [p[0] + (ux[0] * sx + uy[0] * sy) * by, p[1] + (ux[1] * sx + uy[1] * sy) * by];
    [shift(c[0], -1., -1.), shift(c[1], 1., -1.), shift(c[2], 1., 1.), shift(c[3], -1., 1.)]
}

/// Samples the (rotated) rectangle into an upright crop of the given height, bilinear.
fn crop_line(image: &RgbImage, c: &[[f32; 2]; 4], out_h: u32) -> RgbImage {
    let width = dist(c[0], c[1]).max(1.);
    let height = dist(c[0], c[3]).max(1.);
    let out_w = ((width / height) * out_h as f32).round().max(4.) as u32;
    let (iw, ih) = (image.width() as f32 - 1., image.height() as f32 - 1.);
    RgbImage::from_fn(out_w, out_h, |x, y| {
        let u = (x as f32 + 0.5) / out_w as f32;
        let v = (y as f32 + 0.5) / out_h as f32;
        let px = c[0][0] + u * (c[1][0] - c[0][0]) + v * (c[3][0] - c[0][0]);
        let py = c[0][1] + u * (c[1][1] - c[0][1]) + v * (c[3][1] - c[0][1]);
        let (px, py) = (px.clamp(0., iw), py.clamp(0., ih));
        let (x0, y0) = (px.floor(), py.floor());
        let (fx, fy) = (px - x0, py - y0);
        let (x0, y0) = (x0 as u32, y0 as u32);
        let (x1, y1) = ((x0 + 1).min(iw as u32), (y0 + 1).min(ih as u32));
        let p = |x, y| image.get_pixel(x, y).0;
        let (a, b, cc, d) = (p(x0, y0), p(x1, y0), p(x0, y1), p(x1, y1));
        image::Rgb(std::array::from_fn(|i| {
            let top = f32::from(a[i]) * (1. - fx) + f32::from(b[i]) * fx;
            let bottom = f32::from(cc[i]) * (1. - fx) + f32::from(d[i]) * fx;
            (top * (1. - fy) + bottom * fy).round() as u8
        }))
    })
}

/// Characters of one upright line crop with their x position (crop pixels), left to right.
fn recognize_chars(crop: &RgbImage) -> Option<(Vec<(f32, String, f32)>, usize, f32)> {
    recognize_chars_in(crop, None)
}

/// Characters of machine-readable lines (MRZ and the like).
fn mrz_char(c: &str) -> bool { c.len() == 1 && c.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '<') }

/// Like `recognize_chars`, but only characters accepted by `allowed` can be emitted.
fn recognize_chars_in(crop: &RgbImage, allowed: Option<fn(&str) -> bool>) -> Option<(Vec<(f32, String, f32)>, usize, f32)> {
    let scale = REC_HEIGHT as f32 / crop.height() as f32;
    let mut width = ((crop.width() as f32 * scale).round() as usize).max(8);
    let max = *REC_WIDTHS.last().unwrap();
    width = width.min(max);
    let bucket = *REC_WIDTHS.iter().find(|w| **w >= width).unwrap_or(&max);
    let resized = image::imageops::resize(crop, width as u32, REC_HEIGHT as u32, FilterType::Triangle);
    let input: Tensor = tract_ndarray::Array4::from_shape_fn((1, 3, REC_HEIGHT, bucket), |(_, c, y, x)| {
        if x >= width {
            return 0.;
        }
        (f32::from(resized.get_pixel(x as u32, y as u32)[2 - c]) / 255. - 0.5) / 0.5
    })
    .into();
    let outputs = rec_model(bucket)?.run(tvec!(input.into())).ok()?;
    let probs = outputs.first()?.to_plain_array_view::<f32>().ok()?;
    let chars = charset();
    let frames = probs.shape()[1].min(width.div_ceil(8) + 1);
    let frame_px = crop.width() as f32 / frames as f32;
    let mut out = Vec::new();
    let mut last = 0usize;
    for t in 0..frames {
        let frame = probs.slice(tract_ndarray::s![0, t, ..]);
        let (mut best, mut p) = (0usize, f32::MIN);
        for (k, v) in frame.iter().enumerate() {
            if *v > p {
                best = k;
                p = *v;
            }
        }
        // Restricted: a frame whose best character is not allowed takes the most likely allowed
        // character instead (not the blank, which would drop it).
        if let Some(ok) = allowed {
            if best != 0 && !chars.get(best).is_some_and(|c| ok(c)) {
                (best, p) = (0, f32::MIN);
                for (k, v) in frame.iter().enumerate() {
                    if k != 0 && *v > p && chars.get(k).is_some_and(|c| ok(c)) {
                        best = k;
                        p = *v;
                    }
                }
            }
        }
        if best != 0 && best != last {
            if let Some(ch) = chars.get(best) {
                out.push(((t as f32 + 0.5) * frame_px, ch.clone(), p));
            }
        }
        last = best;
    }
    Some((out, frames, frame_px))
}

/// Recognises one upright line crop. Returns the characters left to right (visual order).
///
/// The recogniser tends to drop a run of digits that shares a line with Arabic text (the dates
/// on the back of the card). Wide stretches of the line where it emitted nothing are read again
/// on their own and the result is inserted in place.
fn recognize(crop: &RgbImage) -> Option<(String, f32)> {
    let (mut pieces, frames, frame_px) = recognize_chars(crop)?;
    let positions: Vec<usize> = pieces.iter().filter(|p| p.1 != " ").map(|p| (p.0 / frame_px) as usize).collect();
    let mut edges = vec![-1i64];
    edges.extend(positions.iter().map(|p| *p as i64));
    edges.push(frames as i64);
    let mut extra = Vec::new();
    for pair in edges.windows(2) {
        if pair[1] - pair[0] < 7 {
            continue;
        }
        let x0 = (((pair[0] + 1) as f32 * frame_px) - 4.).max(0.) as u32;
        let x1 = ((pair[1] as f32 * frame_px) + 4.).min(crop.width() as f32) as u32;
        if x1 <= x0 + crop.height() / 2 {
            continue;
        }
        let sub = image::imageops::crop_imm(crop, x0, 0, x1 - x0, crop.height()).to_image();
        if let Some((found, _, _)) = recognize_chars(&sub) {
            if found.iter().any(|p| p.2 > 0.5 && p.1 != " ") {
                extra.push((x0 as f32, " ".to_string(), 1.));
                extra.extend(found.into_iter().map(|(x, c, p)| (x0 as f32 + x, c, p)));
                extra.push((x1 as f32, " ".to_string(), 1.));
            }
        }
    }
    pieces.extend(extra);
    pieces.sort_by(|a, b| a.0.total_cmp(&b.0));
    let text: String = pieces.iter().map(|p| p.1.as_str()).collect();
    let real: Vec<f32> = pieces.iter().filter(|p| p.1 != " ").map(|p| p.2).collect();
    let confidence = if real.is_empty() { 0. } else { real.iter().sum::<f32>() / real.len() as f32 };
    Some((text, confidence))
}

fn is_arabic(c: char) -> bool { ('\u{0600}'..='\u{06FF}').contains(&c) && !('\u{0660}'..='\u{0669}').contains(&c) && !('\u{06F0}'..='\u{06F9}').contains(&c) }

fn is_ltr_run_char(c: char) -> bool { c.is_ascii_alphanumeric() || matches!(c, '/' | '.' | '-' | '+' | '<' | ':') || c.is_numeric() }

/// The recogniser reads left to right. Arabic text is reversed into reading order while runs of
/// digits and Latin letters (dates, numbers) keep their own order.
pub fn logical_order(visual: &str) -> String {
    if !visual.chars().any(is_arabic) {
        return visual.trim().to_owned();
    }
    let reversed: Vec<char> = visual.chars().rev().collect();
    let mut out = String::with_capacity(visual.len());
    let mut i = 0;
    while i < reversed.len() {
        if is_ltr_run_char(reversed[i]) && reversed[i] != ':' {
            let mut j = i;
            while j < reversed.len() && (is_ltr_run_char(reversed[j]) || (reversed[j] == ' ' && j + 1 < reversed.len() && reversed[j + 1].is_ascii_digit() && reversed[j - 1].is_ascii_digit())) {
                j += 1;
            }
            out.extend(reversed[i..j].iter().rev());
            i = j;
        } else {
            out.push(reversed[i]);
            i += 1;
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn rotate(image: &RgbImage, quarter_turns: u8) -> RgbImage {
    match quarter_turns % 4 {
        1 => image::imageops::rotate90(image),
        2 => image::imageops::rotate180(image),
        3 => image::imageops::rotate270(image),
        _ => image.clone(),
    }
}

fn rotate_quad(c: [[f32; 2]; 4], quarter_turns: u8, w: f32, h: f32) -> [[f32; 2]; 4] {
    let map = |[x, y]: [f32; 2]| match quarter_turns % 4 {
        1 => [h - 1. - y, x],
        2 => [w - 1. - x, h - 1. - y],
        3 => [y, w - 1. - x],
        _ => [x, y],
    };
    let mapped = c.map(map);
    crate::scanner::order_corners(mapped.to_vec())
}

/// How much text the recogniser finds on the longest boxes when the page is turned.
fn orientation_score(image: &RgbImage, boxes: &[[[f32; 2]; 4]], quarter_turns: u8) -> f32 {
    let (w, h) = (image.width() as f32, image.height() as f32);
    let turned = rotate(image, quarter_turns);
    let mut longest: Vec<_> = boxes.iter().map(|b| rotate_quad(*b, quarter_turns, w, h)).collect();
    longest.sort_by(|a, b| dist(b[0], b[1]).total_cmp(&dist(a[0], a[1])));
    longest
        .iter()
        .filter(|b| dist(b[0], b[1]) > dist(b[0], b[3]))
        .take(6)
        .filter_map(|b| recognize(&crop_line(&turned, b, REC_HEIGHT as u32)))
        .map(|(text, confidence)| confidence * text.chars().count().min(30) as f32)
        .sum()
}

/// Reads all text lines of a document photo or scan, turning it upright first.
pub fn read_lines(image: &DynamicImage) -> Option<Vec<Line>> {
    if !available() {
        return None;
    }
    let mut rgb = image.to_rgb8();
    // Very large photos only slow things down: the detector sees at most 1024 px anyway.
    let longest = rgb.width().max(rgb.height());
    if longest > 2400 {
        let s = 2400. / longest as f32;
        rgb = image::imageops::resize(&rgb, (rgb.width() as f32 * s) as u32, (rgb.height() as f32 * s) as u32, FilterType::Triangle);
    }
    let mut boxes = detect_boxes(&rgb);
    let tall = boxes.iter().filter(|b| dist(b[0], b[3]) > 2. * dist(b[0], b[1])).count();
    let wide = boxes.iter().filter(|b| dist(b[0], b[1]) > 2. * dist(b[0], b[3])).count();
    let candidates: [u8; 2] = if tall > wide { [1, 3] } else { [0, 2] };
    let turns = if orientation_score(&rgb, &boxes, candidates[0]) >= orientation_score(&rgb, &boxes, candidates[1]) { candidates[0] } else { candidates[1] };
    if turns != 0 {
        rgb = rotate(&rgb, turns);
        boxes = detect_boxes(&rgb);
    }
    let mut lines: Vec<Line> = boxes
        .iter()
        .filter_map(|b| {
            let crop = crop_line(&rgb, b, REC_HEIGHT as u32);
            let (visual, confidence) = recognize(&crop)?;
            let mut text = logical_order(&visual);
            let mut confidence = confidence;
            // A long run of fillers read as Arabic-Indic digits ("V<V…<<<<" → "٧٢٧…٢٢٢٢"):
            // read the line again with the machine-readable alphabet only.
            if looks_machine_readable(&visual) {
                if let Some((pieces, _, _)) = recognize_chars_in(&crop, Some(mrz_char)) {
                    let mrz: String = pieces.iter().map(|p| p.1.as_str()).collect();
                    if mrz.matches('<').count() >= 5 {
                        confidence = pieces.iter().map(|p| p.2).sum::<f32>() / pieces.len().max(1) as f32;
                        text = mrz;
                    }
                }
            }
            if text.is_empty() {
                return None;
            }
            let xs = b.map(|p| p[0]);
            let ys = b.map(|p| p[1]);
            Some(Line {
                text,
                confidence,
                bbox: [
                    xs.iter().copied().fold(f32::MAX, f32::min),
                    ys.iter().copied().fold(f32::MAX, f32::min),
                    xs.iter().copied().fold(f32::MIN, f32::max),
                    ys.iter().copied().fold(f32::MIN, f32::max),
                ],
            })
        })
        .collect();
    lines.sort_by(|a, b| a.center_y().total_cmp(&b.center_y()));
    Some(lines)
}

/// Many filler-like characters in one line: '<' itself, or the Arabic-Indic digits the
/// recogniser reads it as.
fn looks_machine_readable(text: &str) -> bool {
    let fillers = text.chars().filter(|c| matches!(c, '<' | '٢' | '٧' | '٨' | '«')).count();
    fillers >= 8 && fillers * 2 >= text.chars().filter(|c| !c.is_whitespace()).count()
}

/// Contents of the QR codes on the image (the electronic ration card carries its number in one).
pub fn read_qr_codes(image: &DynamicImage) -> Vec<String> {
    let mut gray = image.to_luma8();
    let longest = gray.width().max(gray.height());
    if longest > 2000 {
        let s = 2000. / longest as f32;
        gray = image::imageops::resize(&gray, (gray.width() as f32 * s) as u32, (gray.height() as f32 * s) as u32, FilterType::Triangle);
    }
    let mut prepared = rqrr::PreparedImage::prepare_from_greyscale(gray.width() as usize, gray.height() as usize, |x, y| gray.get_pixel(x as u32, y as u32)[0]);
    prepared
        .detect_grids()
        .into_iter()
        .filter_map(|grid| grid.decode().ok().map(|(_, content)| content.trim().to_owned()))
        .filter(|content| !content.is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn logical_order_keeps_numbers() {
        assert_eq!(logical_order("2020/02/06 نوجرد"), "درجون 2020/02/06");
        assert_eq!(logical_order("ABC<<12"), "ABC<<12");
    }

    #[test]
    fn models_load() {
        assert!(available());
    }

    /// Local tuning aid: `OCR_SAMPLES=/dir cargo test --lib ocr::tests::dump -- --ignored --nocapture`.
    /// Sample images are personal documents and must never be committed.
    #[test]
    #[ignore]
    fn dump() {
        let dir = std::env::var("OCR_SAMPLES").expect("OCR_SAMPLES");
        let only = std::env::var("OCR_ONLY").ok();
        let mut paths: Vec<_> = std::fs::read_dir(dir).unwrap().filter_map(|e| e.ok()).map(|e| e.path()).collect();
        paths.sort();
        for path in paths {
            let name = path.file_name().unwrap().to_string_lossy().to_string();
            if only.as_deref().is_some_and(|o| !name.starts_with(o)) { continue; }
            let image = crate::scanner::load_image(&path).unwrap();
            let t = std::time::Instant::now();
            let lines = read_lines(&image).unwrap();
            println!("== {name} ({:?})", t.elapsed());
            if std::env::var("OCR_LINES").is_ok() {
                for l in &lines { println!("  {:.2} {}", l.confidence, l.text); }
            }
            let codes = read_qr_codes(&image);
            println!("  qr codes: {}", codes.len());
            let result = crate::ocr_parse::parse_with_codes(&lines, &codes);
            println!("  doc={} {:?}", result.document, result.warnings);
            for f in &result.fields { println!("  {:<14} {:.2} {:<5} {}", f.key, f.confidence, f.source, f.value); }
        }
    }
}
