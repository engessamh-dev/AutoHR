//! Offline document scanner. No network, OCR, model downloads or external executables.
use crate::services::{AppError, AppResult};
use image::{DynamicImage, ImageDecoder, ImageReader, Rgb, RgbImage};
use imageproc::{
    contours::find_contours,
    edges::canny,
    filter::gaussian_blur_f32,
    geometric_transformations::{warp_into, Border, Interpolation, Projection},
    geometry::{approximate_polygon_dp, arc_length, contour_area, convex_hull},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

#[derive(Clone, Serialize, Deserialize)]
pub struct ScannerSettings {
    pub enabled: bool,
    pub auto_detect: bool,
    pub enhancement: u8,
    pub confidence_threshold: f32,
    pub quality: u8,
}
impl Default for ScannerSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            auto_detect: true,
            enhancement: 0,
            confidence_threshold: 0.65,
            quality: 94,
        }
    }
}
impl ScannerSettings {
    pub fn validate(&self) -> AppResult<()> {
        if self.enhancement > 2
            || !(0.1..=0.95).contains(&self.confidence_threshold)
            || !(60..=100).contains(&self.quality)
        {
            return Err(AppError::Validation("Invalid scanner settings".into()));
        }
        Ok(())
    }
}
/// Release attachments expose manual crop/rotation only, including legacy saved settings.
fn apply_build_policy(mut settings: ScannerSettings, development_build: bool) -> ScannerSettings {
    if !development_build {
        settings.auto_detect = false;
        settings.enhancement = 0;
    }
    settings
}
#[derive(Serialize)]
pub struct ScanPreview {
    pub token: String,
    pub width: u32,
    pub height: u32,
    pub corners: [[f32; 2]; 4],
    pub confidence: f32,
    pub reliable: bool,
    pub automatic_detection_available: bool,
    pub debug: DetectionDebug,
    pub preview: Vec<u8>,
    pub settings: ScannerSettings,
}
struct ScanSession {
    owner: String,
    original: PathBuf,
    image: DynamicImage,
    temp: tempfile::TempDir,
    target: Option<String>,
    settings: ScannerSettings,
    created: Instant,
    rendered: bool,
    deferred_deletes: Vec<String>,
}
static SESSIONS: OnceLock<Mutex<HashMap<String, ScanSession>>> = OnceLock::new();
fn sessions() -> &'static Mutex<HashMap<String, ScanSession>> {
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}
fn error(e: impl std::fmt::Display) -> AppError {
    AppError::Validation(format!("Image processing: {e}"))
}
pub fn ensure_metadata_columns(conn: &rusqlite::Connection) -> rusqlite::Result<()> {
    let columns: Vec<String> = {
        let mut stmt = conn.prepare("PRAGMA table_info(document_metadata)")?;
        let rows = stmt
            .query_map([], |r| r.get(1))?
            .collect::<rusqlite::Result<_>>()?;
        rows
    };
    for column in ["original_path", "processed_path", "parent_path"] {
        if !columns.iter().any(|name| name == column) {
            conn.execute(
                &format!("ALTER TABLE document_metadata ADD COLUMN {column} TEXT"),
                [],
            )?;
        }
    }
    Ok(())
}
pub fn remove_metadata_prefix(conn: &rusqlite::Connection, prefix: &str) -> AppResult<()> {
    conn.execute(
        "DELETE FROM document_metadata WHERE substr(stored_path,1,length(?1))=?1",
        [prefix],
    )?;
    Ok(())
}
/// Write intent before touching image files so interrupted SQLite transactions are recoverable.
pub fn register_pending_files(conn: &rusqlite::Connection, paths: &[String]) -> AppResult<()> {
    use std::io::Write;
    let folder = crate::services::storage_path(conn).join("Temp/ScannerPending");
    std::fs::create_dir_all(&folder).map_err(error)?;
    let pending = folder.join(crate::files::random_filename("pending"));
    let committed = pending.with_extension("json");
    let mut file = std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&pending)
        .map_err(error)?;
    file.write_all(&serde_json::to_vec(paths).map_err(error)?)
        .map_err(error)?;
    file.sync_all().map_err(error)?;
    drop(file);
    std::fs::rename(pending, committed).map_err(error)?;
    Ok(())
}
pub fn recover_pending_files(conn: &rusqlite::Connection) -> AppResult<()> {
    let root = crate::services::storage_path(conn);
    let folder = root.join("Temp/ScannerPending");
    if !folder.is_dir() {
        return Ok(());
    }
    for entry in std::fs::read_dir(&folder).map_err(error)? {
        let entry = entry.map_err(error)?;
        if !entry.file_type().map_err(error)?.is_file()
            || entry.path().extension().and_then(|v| v.to_str()) != Some("json")
        {
            continue;
        }
        let bytes = std::fs::read(entry.path()).map_err(error)?;
        let paths: Vec<String> = serde_json::from_slice(&bytes).map_err(error)?;
        for path in paths {
            let relative = crate::files::safe_relative_path(&path)?;
            let normalized = path.replace('\\', "/");
            let filename = relative.file_stem().and_then(|v| v.to_str()).unwrap_or("");
            if !(normalized.starts_with("Files/") || normalized.starts_with("Branding/"))
                || filename.len() != 32
                || !filename.bytes().all(|b| b.is_ascii_hexdigit())
            {
                return Err(error("Invalid scanner recovery journal"));
            }
            let committed:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM document_metadata WHERE stored_path=?1 OR original_path=?1 OR processed_path=?1)",[&path],|r|r.get(0))?;
            if !committed && root.join(relative).is_file() {
                // Resolve the parent to prevent following a replaced directory outside storage.
                let parent = root
                    .join(relative)
                    .parent()
                    .ok_or(AppError::NotFound)?
                    .canonicalize()
                    .map_err(error)?;
                if !parent.starts_with(root.canonicalize().map_err(error)?) {
                    return Err(error("Unsafe scanner recovery path"));
                }
                std::fs::remove_file(root.join(relative)).map_err(error)?;
            }
        }
        std::fs::remove_file(entry.path()).map_err(error)?;
    }
    Ok(())
}
pub fn load_image(path: &Path) -> AppResult<DynamicImage> {
    let mut reader = ImageReader::open(path)
        .map_err(error)?
        .with_guessed_format()
        .map_err(error)?;
    if !matches!(
        reader.format(),
        Some(image::ImageFormat::Jpeg | image::ImageFormat::Png | image::ImageFormat::WebP)
    ) {
        return Err(error("Only JPEG, PNG and WebP can be processed"));
    }
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(256 * 1024 * 1024);
    limits.max_image_width = Some(16000);
    limits.max_image_height = Some(16000);
    reader.limits(limits);
    let mut decoder = reader.into_decoder().map_err(error)?;
    let (w, h) = decoder.dimensions();
    if w < 16 || h < 16 || u64::from(w) * u64::from(h) > 40_000_000 {
        return Err(error("Image must be 16px–40 megapixels"));
    }
    let orientation = decoder.orientation().map_err(error)?;
    let mut image = DynamicImage::from_decoder(decoder).map_err(error)?;
    image.apply_orientation(orientation);
    // Composite alpha onto white, preserving colour without black transparent regions.
    let rgba = image.to_rgba8();
    let rgb = RgbImage::from_fn(rgba.width(), rgba.height(), |x, y| {
        let p = rgba.get_pixel(x, y).0;
        let a = u32::from(p[3]);
        Rgb(std::array::from_fn(|i| {
            ((u32::from(p[i]) * a + 255 * (255 - a)) / 255) as u8
        }))
    });
    Ok(DynamicImage::ImageRgb8(rgb))
}
pub(crate) fn jpeg(image: &DynamicImage, quality: u8) -> AppResult<Vec<u8>> {
    let mut bytes = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, quality)
        .encode_image(image)
        .map_err(error)?;
    Ok(bytes)
}
pub(crate) fn thumbnail(image: &DynamicImage, max: u32) -> DynamicImage {
    if image.width() <= max && image.height() <= max {
        image.clone()
    } else {
        image.thumbnail(max, max)
    }
}
pub fn full_corners(w: u32, h: u32) -> [[f32; 2]; 4] {
    [
        [0., 0.],
        [(w - 1) as f32, 0.],
        [(w - 1) as f32, (h - 1) as f32],
        [0., (h - 1) as f32],
    ]
}
pub(crate) fn order_corners(points: Vec<[f32; 2]>) -> [[f32; 2]; 4] {
    order(points)
}
pub(crate) fn refine_quad(c: [[f32; 2]; 4], points: &[imageproc::point::Point<i32>]) -> [[f32; 2]; 4] {
    refine_edges(c, points)
}
fn order(mut points: Vec<[f32; 2]>) -> [[f32; 2]; 4] {
    let cx = points.iter().map(|p| p[0]).sum::<f32>() / 4.;
    let cy = points.iter().map(|p| p[1]).sum::<f32>() / 4.;
    points.sort_by(|a, b| {
        (a[1] - cy)
            .atan2(a[0] - cx)
            .total_cmp(&(b[1] - cy).atan2(b[0] - cx))
    });
    let first = (0..4)
        .min_by(|&a, &b| (points[a][0] + points[a][1]).total_cmp(&(points[b][0] + points[b][1])))
        .unwrap();
    std::array::from_fn(|i| points[(first + i) % 4])
}
pub fn validate_corners(c: &[[f32; 2]; 4], w: u32, h: u32) -> AppResult<()> {
    for p in c {
        if !p[0].is_finite()
            || !p[1].is_finite()
            || p[0] < 0.
            || p[1] < 0.
            || p[0] > (w - 1) as f32
            || p[1] > (h - 1) as f32
        {
            return Err(error("Corners outside image"));
        }
    }
    let mut sign = 0.;
    let mut area = 0.;
    for i in 0..4 {
        let a = c[i];
        let b = c[(i + 1) % 4];
        let d = c[(i + 2) % 4];
        let cross = (b[0] - a[0]) * (d[1] - b[1]) - (b[1] - a[1]) * (d[0] - b[0]);
        if cross.abs() < 1. || (sign != 0. && sign * cross < 0.) {
            return Err(error("Corners must form a convex quadrilateral"));
        }
        sign = cross;
        area += a[0] * b[1] - a[1] * b[0];
    }
    if area.abs() / 2. < 256. {
        return Err(error("Selected area too small"));
    }
    Ok(())
}
#[derive(Serialize, Default)]
pub struct DetectionDebug {
    pub original_dimensions: [u32; 2],
    pub detection_dimensions: [u32; 2],
    pub contours: Vec<Vec<[f32; 2]>>,
    pub candidates: Vec<CandidateDebug>,
    pub ai_status: &'static str,
    pub selected: Option<CandidateDebug>,
}
#[derive(Clone, Serialize)]
pub struct CandidateDebug {
    pub corners: [[f32; 2]; 4],
    pub coverage: f32,
    pub edge_support: f32,
    pub separation: f32,
    pub confidence: f32,
    pub rejection: &'static str,
    pub source: &'static str,
    pub side_support: [f32; 4],
}
// Fit physical edge lines and intersect them; polygon simplification alone cuts rounded corners.
fn refine_edges(c: [[f32; 2]; 4], points: &[imageproc::point::Point<i32>]) -> [[f32; 2]; 4] {
    let mut lines = [[0.; 3]; 4];
    for i in 0..4 {
        let a = c[i];
        let b = c[(i + 1) % 4];
        let dx = b[0] - a[0];
        let dy = b[1] - a[1];
        let len = dx.hypot(dy);
        let near: Vec<[f32; 2]> = points
            .iter()
            .map(|p| [p.x as f32, p.y as f32])
            .filter(|p| {
                let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (len * len);
                let distance = ((p[0] - a[0]) * dy - (p[1] - a[1]) * dx).abs() / len;
                t > 0.1 && t < 0.9 && distance < (len * 0.06).clamp(8., 24.)
            })
            .collect();
        if near.len() < 10 {
            return c;
        }
        let mx = near.iter().map(|p| p[0]).sum::<f32>() / near.len() as f32;
        let my = near.iter().map(|p| p[1]).sum::<f32>() / near.len() as f32;
        let xx = near.iter().map(|p| (p[0] - mx).powi(2)).sum::<f32>();
        let yy = near.iter().map(|p| (p[1] - my).powi(2)).sum::<f32>();
        let xy = near.iter().map(|p| (p[0] - mx) * (p[1] - my)).sum::<f32>();
        let angle = 0.5 * (2. * xy).atan2(xx - yy);
        let nx = -angle.sin();
        let ny = angle.cos();
        lines[i] = [nx, ny, nx * mx + ny * my];
    }
    let mut result = c;
    for i in 0..4 {
        let a = lines[(i + 3) % 4];
        let b = lines[i];
        let det = a[0] * b[1] - a[1] * b[0];
        if det.abs() < 0.1 {
            return c;
        }
        let p = [
            (a[2] * b[1] - a[1] * b[2]) / det,
            (a[0] * b[2] - a[2] * b[0]) / det,
        ];
        if (p[0] - c[i][0]).hypot(p[1] - c[i][1]) > 35. {
            return c;
        }
        result[i] = p;
    }
    result
}
#[cfg(test)]
pub fn detect(image: &DynamicImage) -> ([[f32; 2]; 4], f32) {
    let (c, confidence, _) = detect_debug(image);
    (c, confidence)
}
pub fn detect_debug(image: &DynamicImage) -> ([[f32; 2]; 4], f32, DetectionDebug) {
    let reduced = thumbnail(image, 1000);
    let small = reduced.to_luma8();
    let rgb = reduced.to_rgb8();
    // Chroma separates coloured plastic from neutral texture even at equal luminance.
    // No document colour or position is assumed.
    let chroma = image::GrayImage::from_fn(rgb.width(), rgb.height(), |x, y| {
        let p = rgb.get_pixel(x, y).0;
        image::Luma([p.iter().max().unwrap() - p.iter().min().unwrap()])
    });
    // Signed opponent channels retain colour differences that luminance and unsigned
    // saturation lose (e.g. cool card and warm fabric with similar saturation).
    let blue = image::GrayImage::from_fn(rgb.width(), rgb.height(), |x, y| {
        let p = rgb.get_pixel(x, y).0;
        image::Luma([(128 + p[2] as i32 - (p[0] as i32 + p[1] as i32) / 2).clamp(0, 255) as u8])
    });
    let red_green = image::GrayImage::from_fn(rgb.width(), rgb.height(), |x, y| {
        let p = rgb.get_pixel(x, y).0;
        image::Luma([(128 + p[0] as i32 - p[1] as i32).clamp(0, 255) as u8])
    });
    let blue_inverse = image::GrayImage::from_fn(rgb.width(), rgb.height(), |x, y| {
        image::Luma([255 - blue.get_pixel(x, y)[0]])
    });
    let red_green_inverse = image::GrayImage::from_fn(rgb.width(), rgb.height(), |x, y| {
        image::Luma([255 - red_green.get_pixel(x, y)[0]])
    });
    let mut colour_cache = HashMap::<&str, (image::GrayImage, image::GrayImage)>::new();
    let mut debug = DetectionDebug {
        original_dimensions: [image.width(), image.height()],
        detection_dimensions: [small.width(), small.height()],
        ai_status: "Not installed: classical CPU imageproc detector; no AI inference",
        ..Default::default()
    };
    let map = |p: [f32; 2]| {
        [
            p[0] * (image.width() - 1) as f32 / (small.width() - 1) as f32,
            p[1] * (image.height() - 1) as f32 / (small.height() - 1) as f32,
        ]
    };
    let mut accepted = Vec::<CandidateDebug>::new();
    // Geometric evidence is validated against the channel that generated a candidate.
    for (source, channel, sigma, low, high, threshold) in [
        ("luminance", &small, 1.2, 7., 18., None),
        ("luminance", &small, 1.2, 18., 45., None),
        ("luminance", &small, 2.4, 25., 65., None),
        ("blue-opponent", &blue, 1.2, 5., 12., Some(130)),
        ("blue-opponent", &blue, 1.2, 5., 12., Some(132)),
        (
            "blue-opponent-inverse",
            &blue_inverse,
            1.2,
            5.,
            12.,
            Some(130),
        ),
        (
            "blue-opponent-inverse",
            &blue_inverse,
            1.2,
            5.,
            12.,
            Some(132),
        ),
        ("red-green-opponent", &red_green, 1.2, 5., 12., Some(130)),
        ("red-green-opponent", &red_green, 1.2, 5., 12., Some(132)),
        (
            "red-green-opponent-inverse",
            &red_green_inverse,
            1.2,
            5.,
            12.,
            Some(130),
        ),
        (
            "red-green-opponent-inverse",
            &red_green_inverse,
            1.2,
            5.,
            12.,
            Some(132),
        ),
        ("chroma", &chroma, 1.2, 5., 12., Some(12)),
        ("chroma", &chroma, 1.2, 5., 12., Some(20)),
        ("chroma", &chroma, 1.2, 5., 12., Some(28)),
        ("blue-opponent", &blue, 1.2, 5., 12., Some(136)),
        ("blue-opponent", &blue, 1.2, 5., 12., Some(144)),
        (
            "blue-opponent-inverse",
            &blue_inverse,
            1.2,
            5.,
            12.,
            Some(136),
        ),
        (
            "blue-opponent-inverse",
            &blue_inverse,
            1.2,
            5.,
            12.,
            Some(144),
        ),
        ("red-green-opponent", &red_green, 1.2, 5., 12., Some(136)),
        ("red-green-opponent", &red_green, 1.2, 5., 12., Some(144)),
        (
            "red-green-opponent-inverse",
            &red_green_inverse,
            1.2,
            5.,
            12.,
            Some(136),
        ),
        (
            "red-green-opponent-inverse",
            &red_green_inverse,
            1.2,
            5.,
            12.,
            Some(144),
        ),
    ] {
        if threshold.is_some_and(|level| channel.pixels().all(|p| p[0] < level)) {
            continue;
        }
        let (blurred, edges) = if threshold.is_some() {
            let prepared = colour_cache.entry(source).or_insert_with(|| {
                let blurred = gaussian_blur_f32(channel, sigma);
                let edges = canny(&blurred, low, high);
                (blurred, edges)
            });
            (prepared.0.clone(), prepared.1.clone())
        } else {
            let blurred = gaussian_blur_f32(channel, sigma);
            let edges = canny(&blurred, low, high);
            (blurred, edges)
        };
        let contour_image = match threshold {
            Some(level) => {
                let mask = image::GrayImage::from_fn(blurred.width(), blurred.height(), |x, y| {
                    image::Luma([if blurred.get_pixel(x, y)[0] >= level {
                        255
                    } else {
                        0
                    }])
                });
                imageproc::morphology::close(&mask, imageproc::distance_transform::Norm::LInf, 3)
            }
            None => edges.clone(),
        };
        for contour in find_contours::<i32>(&contour_image) {
            if contour.points.len() < 20 {
                continue;
            }
            if cfg!(debug_assertions) && debug.contours.len() < 200 {
                let step = (contour.points.len() / 100).max(1);
                debug.contours.push(
                    contour
                        .points
                        .iter()
                        .step_by(step)
                        .map(|p| map([p.x as f32, p.y as f32]))
                        .collect(),
                );
            }
            let hull = convex_hull(contour.points.clone());
            let perimeter = arc_length(&hull, true);
            for epsilon in [0.012, 0.025, 0.04] {
                let polygon = approximate_polygon_dp(&hull, perimeter * epsilon, true);
                if polygon.len() != 4 {
                    continue;
                }
                let area = contour_area(&polygon).abs();
                let fraction = (area / (small.width() * small.height()) as f64) as f32;
                if fraction < 0.015 {
                    continue;
                }
                let c = refine_edges(
                    order(polygon.iter().map(|p| [p.x as f32, p.y as f32]).collect()),
                    &contour.points,
                );
                if validate_corners(&c, small.width(), small.height()).is_err() {
                    continue;
                }
                let plausible_angles = (0..4).all(|i| {
                    let a = c[(i + 3) % 4];
                    let b = c[i];
                    let d = c[(i + 1) % 4];
                    let ux = a[0] - b[0];
                    let uy = a[1] - b[1];
                    let vx = d[0] - b[0];
                    let vy = d[1] - b[1];
                    let angle = ((ux * vx + uy * vy) / (ux.hypot(uy) * vx.hypot(vy)))
                        .clamp(-1., 1.)
                        .acos()
                        .to_degrees();
                    (30. ..=150.).contains(&angle)
                });
                let mut support = [0.; 4];
                let mut separation = [0.; 4];
                for i in 0..4 {
                    let a = c[i];
                    let b = c[(i + 1) % 4];
                    let dx = b[0] - a[0];
                    let dy = b[1] - a[1];
                    let len = dx.hypot(dy);
                    let nx = -dy / len;
                    let ny = dx / len;
                    for t in 1..=40 {
                        let f = t as f32 / 41.;
                        let x = a[0] + dx * f;
                        let y = a[1] + dy * f;
                        let mut hit = false;
                        for oy in -2..=2 {
                            for ox in -2..=2 {
                                let xx = x.round() as i32 + ox;
                                let yy = y.round() as i32 + oy;
                                if xx >= 0
                                    && yy >= 0
                                    && xx < small.width() as i32
                                    && yy < small.height() as i32
                                    && edges.get_pixel(xx as u32, yy as u32)[0] > 0
                                    && xx > 0
                                        && yy > 0
                                        && xx + 1 < small.width() as i32
                                        && yy + 1 < small.height() as i32
                                    {
                                        let gx = blurred.get_pixel((xx + 1) as u32, yy as u32)[0]
                                            as f32
                                            - blurred.get_pixel((xx - 1) as u32, yy as u32)[0]
                                                as f32;
                                        let gy = blurred.get_pixel(xx as u32, (yy + 1) as u32)[0]
                                            as f32
                                            - blurred.get_pixel(xx as u32, (yy - 1) as u32)[0]
                                                as f32;
                                        let magnitude = gx.hypot(gy);
                                        if magnitude > 1.
                                            && (gx * nx + gy * ny).abs() / magnitude >= 0.75
                                        {
                                            hit = true;
                                        }
                                    }
                            }
                        }
                        if hit {
                            support[i] += 1. / 40.;
                        }
                        let sample = |offset: f32| -> Option<f32> {
                            let xx = (x + nx * offset).round() as i32;
                            let yy = (y + ny * offset).round() as i32;
                            if xx < 0
                                || yy < 0
                                || xx >= small.width() as i32
                                || yy >= small.height() as i32
                            {
                                None
                            } else {
                                Some(blurred.get_pixel(xx as u32, yy as u32)[0] as f32)
                            }
                        };
                        if let (Some(inside), Some(outside)) = (sample(5.), sample(-5.)) {
                            separation[i] += (inside - outside).abs() / 40.;
                        }
                    }
                }
                let edge = support.iter().sum::<f32>() / 4.;
                let sep = separation.iter().sum::<f32>() / 4.;
                let weakest = support.iter().copied().fold(1., f32::min);
                let fill = (area / contour_area(&hull).abs().max(1.)).min(1.) as f32;
                let confidence = 0.65 * edge + 0.2 * fill + 0.15 * (sep / 35.).min(1.);
                let rejection = if !plausible_angles {
                    "Implausible corner angles"
                } else if weakest < 0.5 || edge < 0.7 {
                    "Insufficient support on all four edges"
                } else if sep < 8. {
                    "Weak document/background separation"
                } else {
                    ""
                };
                let original = c.map(map);
                let record = CandidateDebug {
                    corners: original,
                    coverage: fraction,
                    edge_support: edge,
                    separation: sep,
                    confidence,
                    rejection,
                    source,
                    side_support: support,
                };
                if cfg!(debug_assertions) && debug.candidates.len() < 300 {
                    debug.candidates.push(record.clone());
                }
                if rejection.is_empty() {
                    accepted.push(record);
                }
            }
        }
    }
    // Suppress an internal picture/text region only when an evidence-valid enclosing
    // boundary has comparable confidence. This is containment, not largest-contour ranking.
    let area = |c: &[[f32; 2]; 4]| {
        (0..4)
            .map(|i| c[i][0] * c[(i + 1) % 4][1] - c[(i + 1) % 4][0] * c[i][1])
            .sum::<f32>()
            .abs()
            / 2.
    };
    let contains = |outer: &[[f32; 2]; 4], p: [f32; 2]| {
        (0..4).all(|i| {
            let a = outer[i];
            let b = outer[(i + 1) % 4];
            (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) >= 0.
        })
    };
    let best = accepted
        .iter()
        .filter(|inner| {
            !accepted.iter().any(|outer| {
                outer.confidence + 0.08 >= inner.confidence
                    && area(&outer.corners) > area(&inner.corners) * 1.25
                    && inner.corners.iter().all(|&p| contains(&outer.corners, p))
            })
        })
        .max_by(|a, b| a.confidence.total_cmp(&b.confidence))
        .cloned();
    let corners = best
        .as_ref()
        .map(|c| c.corners)
        .unwrap_or_else(|| full_corners(image.width(), image.height()));
    let confidence = best.as_ref().map(|c| c.confidence).unwrap_or(0.);
    debug.selected = best;
    (corners, confidence, debug)
}

/// ISO/IEC 7810 ID-1 card ratio (85.60 × 53.98 mm): national cards, badges and residence cards.
pub const CARD_ASPECT: f32 = 85.60 / 53.98;

/// Optional image clean-up chosen in the attachment editor. Every field defaults to "no change".
#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq)]
#[serde(default)]
pub struct Adjustments {
    pub auto_levels: bool,
    /// -60..=60, added to every channel.
    pub brightness: i8,
    /// -50..=50, percent contrast change.
    pub contrast: i8,
    /// 0..=3 unsharp-mask strength.
    pub sharpness: u8,
    pub grayscale: bool,
    /// Force the ID-1 card aspect ratio for the corrected output.
    pub card_aspect: bool,
}

impl Adjustments {
    pub fn validate(&self) -> AppResult<()> {
        if !(-60..=60).contains(&self.brightness) || !(-50..=50).contains(&self.contrast) || self.sharpness > 3 {
            return Err(error("Invalid image adjustments"));
        }
        Ok(())
    }
}

/// Stretch the luminance range between the 1st and 99th percentiles to the full 0..255 range.
fn auto_levels(image: &mut RgbImage) {
    let mut histogram = [0u64; 256];
    for pixel in image.pixels() {
        let [r, g, b] = pixel.0;
        let luma = (0.2126 * f32::from(r) + 0.7152 * f32::from(g) + 0.0722 * f32::from(b)).round() as usize;
        histogram[luma.min(255)] += 1;
    }
    let total: u64 = histogram.iter().sum();
    if total == 0 {
        return;
    }
    let percentile = |fraction: f64| {
        let target = (total as f64 * fraction) as u64;
        let mut seen = 0;
        for (value, count) in histogram.iter().enumerate() {
            seen += count;
            if seen > target {
                return value as f32;
            }
        }
        255.
    };
    let (low, high) = (percentile(0.01), percentile(0.99));
    if high - low < 16. {
        return;
    }
    let scale = 255. / (high - low);
    for pixel in image.pixels_mut() {
        for channel in pixel.0.iter_mut() {
            *channel = ((f32::from(*channel) - low) * scale).round().clamp(0., 255.) as u8;
        }
    }
}

pub fn apply_adjustments(image: DynamicImage, adjustments: &Adjustments) -> DynamicImage {
    let mut result = image;
    if adjustments.auto_levels {
        let mut rgb = result.to_rgb8();
        auto_levels(&mut rgb);
        result = DynamicImage::ImageRgb8(rgb);
    }
    if adjustments.brightness != 0 {
        result = result.brighten(i32::from(adjustments.brightness));
    }
    if adjustments.contrast != 0 {
        result = result.adjust_contrast(f32::from(adjustments.contrast));
    }
    if adjustments.sharpness > 0 {
        let sigma = [0., 0.8, 1.2, 1.8][usize::from(adjustments.sharpness)];
        result = result.unsharpen(sigma, 2);
    }
    if adjustments.grayscale {
        result = DynamicImage::ImageRgb8(DynamicImage::ImageLuma8(result.to_luma8()).to_rgb8());
    }
    result
}

/// Only the tests call this directly.
#[cfg(test)]
pub fn transform(
    image: &DynamicImage,
    c: [[f32; 2]; 4],
    rotation: u16,
    enhancement: u8,
) -> AppResult<DynamicImage> {
    transform_with(image, c, rotation, enhancement, false)
}

pub fn transform_with(
    image: &DynamicImage,
    c: [[f32; 2]; 4],
    rotation: u16,
    enhancement: u8,
    card_aspect: bool,
) -> AppResult<DynamicImage> {
    validate_corners(&c, image.width(), image.height())?;
    if ![0, 90, 180, 270].contains(&rotation) || enhancement > 2 {
        return Err(error("Invalid rotation/enhancement"));
    }
    let distance =
        |a: [f32; 2], b: [f32; 2]| ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2)).sqrt();
    let mut w = distance(c[0], c[1]).max(distance(c[3], c[2])).round() as u32 + 1;
    let mut h = distance(c[0], c[3]).max(distance(c[1], c[2])).round() as u32 + 1;
    if card_aspect {
        // Keep the longer measured side and derive the other from the card ratio.
        if w >= h {
            h = (w as f32 / CARD_ASPECT).round() as u32;
        } else {
            w = (h as f32 / CARD_ASPECT).round() as u32;
        }
    }
    if w < 16 || h < 16 || w > 16000 || h > 16000 || u64::from(w) * u64::from(h) > 40_000_000 {
        return Err(error("Output too large"));
    }
    // Closed-form quadrilateral homography avoids an unbounded iterative SVD solver.
    let dx1 = c[1][0] - c[2][0];
    let dx2 = c[3][0] - c[2][0];
    let dx3 = c[0][0] - c[1][0] + c[2][0] - c[3][0];
    let dy1 = c[1][1] - c[2][1];
    let dy2 = c[3][1] - c[2][1];
    let dy3 = c[0][1] - c[1][1] + c[2][1] - c[3][1];
    let denominator = dx1 * dy2 - dx2 * dy1;
    if denominator.abs() < 1e-6 {
        return Err(error("Degenerate perspective"));
    }
    let g = (dx3 * dy2 - dx2 * dy3) / denominator;
    let k = (dx1 * dy3 - dx3 * dy1) / denominator;
    let x = (w - 1) as f32;
    let y = (h - 1) as f32;
    let projection = Projection::from_matrix([
        (c[1][0] - c[0][0] + g * c[1][0]) / x,
        (c[3][0] - c[0][0] + k * c[3][0]) / y,
        c[0][0],
        (c[1][1] - c[0][1] + g * c[1][1]) / x,
        (c[3][1] - c[0][1] + k * c[3][1]) / y,
        c[0][1],
        g / x,
        k / y,
        1.,
    ])
    .ok_or_else(|| error("Degenerate perspective"))?
    .invert();
    let mut out = RgbImage::new(w, h);
    warp_into(
        &image.to_rgb8(),
        projection,
        Interpolation::Bilinear,
        Border::Constant(Rgb([255, 255, 255])),
        &mut out,
    );
    let result = DynamicImage::ImageRgb8(out);
    let result = match rotation {
        90 => result.rotate90(),
        180 => result.rotate180(),
        270 => result.rotate270(),
        _ => result,
    };
    Ok(if enhancement == 0 {
        result
    } else {
        result.adjust_contrast(if enhancement == 1 { 8. } else { 16. })
    })
}
pub fn prepare(
    owner: String,
    source: &Path,
    settings: ScannerSettings,
    target: Option<String>,
) -> AppResult<ScanPreview> {
    settings.validate()?;
    let settings = apply_build_policy(settings, cfg!(debug_assertions));
    if !settings.enabled {
        return Err(error("Scanner disabled"));
    }
    // Reject capacity before allocating another large decoded image.
    let mut sessions = sessions().lock().unwrap();
    sessions.retain(|_, s| s.created.elapsed() < Duration::from_secs(1800));
    if sessions.len() >= 2 {
        return Err(error("Close the previous scanner first"));
    }
    crate::files::validate_upload(
        source.to_str().ok_or_else(|| error("Invalid path"))?,
        false,
        true,
        crate::files::MAX_DOCUMENT_SIZE,
    )?;
    let temp = tempfile::tempdir().map_err(error)?;
    let original_dir = temp.path().join("original");
    std::fs::create_dir(&original_dir).map_err(error)?;
    let original = original_dir.join(
        source
            .file_name()
            .ok_or_else(|| error("Invalid filename"))?,
    );
    std::fs::copy(source, &original).map_err(error)?;
    let image = load_image(&original)?;
    let ai = crate::ai_detect::detect(&image);
    let (corners, confidence, debug) = if let Some((corners, confidence)) = ai.filter(|(_, c)| *c >= settings.confidence_threshold) {
        (
            corners,
            confidence,
            DetectionDebug {
                original_dimensions: [image.width(), image.height()],
                ai_status: "Bundled on-device model (U2-Netp)",
                ..Default::default()
            },
        )
    } else if settings.auto_detect {
        detect_debug(&image)
    } else if let Some((corners, confidence)) = ai {
        // Low-confidence model output is still a better manual starting point than the full frame.
        (
            corners,
            confidence,
            DetectionDebug {
                original_dimensions: [image.width(), image.height()],
                ai_status: "Bundled on-device model (low confidence)",
                ..Default::default()
            },
        )
    } else {
        (
            full_corners(image.width(), image.height()),
            0.,
            DetectionDebug {
                original_dimensions: [image.width(), image.height()],
                ai_status: "Not installed; automatic detection disabled",
                ..Default::default()
            },
        )
    };
    let token = crate::files::random_filename("scan");
    let result = ScanPreview {
        token: token.clone(),
        width: image.width(),
        height: image.height(),
        corners,
        confidence,
        reliable: confidence >= settings.confidence_threshold,
        automatic_detection_available: cfg!(debug_assertions) || crate::ai_detect::available(),
        debug,
        preview: jpeg(&thumbnail(&image, 1400), 90)?,
        settings: settings.clone(),
    };
    sessions.insert(
        token,
        ScanSession {
            owner,
            original,
            image,
            temp,
            target,
            settings,
            created: Instant::now(),
            rendered: false,
            deferred_deletes: Vec::new(),
        },
    );
    Ok(result)
}
pub fn render(
    owner: &str,
    token: &str,
    corners: [[f32; 2]; 4],
    rotation: u16,
    adjustments: Adjustments,
) -> AppResult<Vec<u8>> {
    adjustments.validate()?;
    let mut sessions = sessions().lock().unwrap();
    let s = sessions.get_mut(token).ok_or(AppError::NotFound)?;
    if s.owner != owner {
        return Err(AppError::Unauthorized);
    }
    let result = transform_with(&s.image, corners, rotation, s.settings.enhancement, adjustments.card_aspect)?;
    let result = apply_adjustments(result, &adjustments);
    let bytes = jpeg(&result, s.settings.quality)?;
    if bytes.len() > crate::files::MAX_DOCUMENT_SIZE as usize {
        return Err(error("Output exceeds attachment limit"));
    }
    std::fs::write(s.temp.path().join("processed.jpg"), &bytes).map_err(error)?;
    drop(result);
    // Show the actual saved JPEG quality, rather than a pristine pre-encoding image.
    let encoded =
        image::load_from_memory_with_format(&bytes, image::ImageFormat::Jpeg).map_err(error)?;
    let preview = if encoded.width() <= 1400 && encoded.height() <= 1400 {
        bytes
    } else {
        jpeg(&thumbnail(&encoded, 1400), 94)?
    };
    s.rendered = true;
    Ok(preview)
}
pub fn stage(owner: &str, token: &str) -> AppResult<String> {
    let sessions = sessions().lock().unwrap();
    let s = sessions.get(token).ok_or(AppError::NotFound)?;
    if s.owner != owner {
        return Err(AppError::Unauthorized);
    }
    if !s.rendered {
        return Err(error("Preview before saving"));
    }
    Ok(s.temp
        .path()
        .join("processed.jpg")
        .to_string_lossy()
        .into_owned())
}
pub fn original_for_stage(path: &str) -> Option<(PathBuf, String)> {
    let sessions = sessions().lock().unwrap();
    sessions
        .values()
        .find(|s| s.rendered && s.temp.path().join("processed.jpg") == Path::new(path))
        .map(|s| (s.original.clone(), s.owner.clone()))
}
pub fn release(owner: &str, token: &str) -> AppResult<()> {
    let mut sessions = sessions().lock().unwrap();
    if sessions.get(token).is_some_and(|s| s.owner != owner) {
        return Err(AppError::Unauthorized);
    }
    sessions.remove(token);
    Ok(())
}
pub fn clear_owner(owner: &str) {
    sessions().lock().unwrap().retain(|_, s| s.owner != owner);
}

pub fn settings(conn: &rusqlite::Connection) -> AppResult<ScannerSettings> {
    use rusqlite::OptionalExtension;
    let value: Option<String> = conn
        .query_row(
            "SELECT value FROM app_settings WHERE key='document_scanner'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    let settings: ScannerSettings = value
        .map(|v| serde_json::from_str(&v).map_err(error))
        .transpose()?
        .unwrap_or_default();
    settings.validate()?;
    Ok(apply_build_policy(settings, cfg!(debug_assertions)))
}
pub fn set_settings(
    conn: &rusqlite::Connection,
    owner: &str,
    value: ScannerSettings,
) -> AppResult<()> {
    value.validate()?;
    let value = apply_build_policy(value, cfg!(debug_assertions));
    crate::services::assert_permission(conn, owner, "settings.manage")?;
    let tx = conn.unchecked_transaction()?;
    tx.execute("INSERT INTO app_settings(key,value) VALUES('document_scanner',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[serde_json::to_string(&value).map_err(error)?])?;
    audit_processing_action(&tx, owner, "UPDATE_SCANNER_SETTINGS", None)?;
    tx.commit()?;
    Ok(())
}
fn audit_processing_action(
    conn: &rusqlite::Connection,
    owner: &str,
    action: &str,
    path: Option<&str>,
) -> AppResult<()> {
    let (id, role): (i64, String) = conn.query_row(
        "SELECT id,role FROM users WHERE username=?1",
        [owner],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    conn.execute("INSERT INTO activity_log(user_id,username,role,action,target_type,target_name,result,details) VALUES(?1,?2,?3,?4,'document',?5,'Success','offline-scanner-v1; original preserved')",rusqlite::params![id,owner,role,action,path])?;
    Ok(())
}
pub fn audit_processing(conn: &rusqlite::Connection, owner: &str, path: &str) -> AppResult<()> {
    audit_processing_action(conn, owner, "PROCESS_DOCUMENT", Some(path))
}
pub fn audit_upload(
    conn: &rusqlite::Connection,
    owner: &str,
    command: &str,
    id: Option<i64>,
    path: &str,
    details: Option<&str>,
) -> AppResult<()> {
    let (action, subject) = match command {
        "cmd_upload_general_doc_file" => ("UPLOAD_DOCUMENT".to_string(), "general_doc"),
        "cmd_upload_outgoing_doc_file" => ("UPLOAD_DOCUMENT".to_string(), "outgoing_doc"),
        "cmd_upload_employee_photo" => ("UPLOAD_DOCUMENT".to_string(), "employee"),
        _ => (
            command.trim_start_matches("cmd_").to_uppercase(),
            "employee",
        ),
    };
    conn.query_row("SELECT 1 FROM users WHERE username=?1", [owner], |_| Ok(()))?;
    crate::services::try_log_audit(conn, Some(owner), &action, Some(subject), id, Some(path), "Success", details)
}

/// Resolve only current attachment associations, never grant access merely from a metadata row.
pub fn associated_path(
    conn: &rusqlite::Connection,
    owner: &str,
    relative: &str,
    write: bool,
) -> AppResult<PathBuf> {
    use crate::services::assert_permission;
    let permission = if write {
        "documents.upload"
    } else {
        "documents.view"
    };
    let is_photo: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM employees WHERE photo_path=?1)",
        [relative],
        |r| r.get(0),
    )?;
    let is_logo: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM company_config WHERE logo_path=?1)",
        [relative],
        |r| r.get(0),
    )?;
    if is_logo {
        assert_permission(conn, owner, "settings.manage")?;
    } else if is_photo {
        assert_permission(
            conn,
            owner,
            if write {
                "employees.edit"
            } else {
                "employees.view"
            },
        )?;
    } else {
        assert_permission(conn, owner, permission)?;
    }
    let linked:bool=conn.query_row("SELECT EXISTS(
        SELECT 1 FROM employee_attachments WHERE file_path=?1 UNION ALL
        SELECT 1 FROM general_doc_attachments WHERE file_path=?1 UNION ALL
        SELECT 1 FROM outgoing_doc_attachments WHERE file_path=?1 UNION ALL
        SELECT 1 FROM employee_family_members WHERE national_card_front_path=?1 OR national_card_back_path=?1 UNION ALL
        SELECT 1 FROM employee_spouses WHERE national_card_front_path=?1 OR national_card_back_path=?1 UNION ALL
        SELECT 1 FROM employee_vehicles WHERE annual_front_path=?1 OR annual_back_path=?1 UNION ALL
        SELECT 1 FROM employees WHERE photo_path=?1 OR civil_id_front_path=?1 OR civil_id_back_path=?1 OR residence_card_front_path=?1 OR residence_card_back_path=?1 OR airport_badge_front_path=?1 OR airport_badge_back_path=?1 OR ministry_badge_front_path=?1 OR ministry_badge_back_path=?1 UNION ALL
        SELECT 1 FROM company_config WHERE logo_path=?1)",[relative],|r|r.get(0))?;
    if !linked {
        return Err(AppError::NotFound);
    }
    disk_path(conn, relative)
}
fn disk_path(conn: &rusqlite::Connection, relative: &str) -> AppResult<PathBuf> {
    let path = crate::files::safe_relative_path(relative)?;
    if !relative.replace('\\', "/").starts_with("Files/")
        && !relative.replace('\\', "/").starts_with("Branding/")
    {
        return Err(AppError::NotFound);
    }
    let root = crate::services::storage_path(conn)
        .canonicalize()
        .map_err(error)?;
    let full = root
        .join(path)
        .canonicalize()
        .map_err(|_| AppError::NotFound)?;
    if !full.starts_with(root) || !full.is_file() {
        return Err(AppError::NotFound);
    }
    Ok(full)
}
pub fn original_path(conn: &rusqlite::Connection, relative: &str) -> AppResult<PathBuf> {
    use rusqlite::OptionalExtension;
    let original: Option<String> = conn
        .query_row(
            "SELECT original_path FROM document_metadata WHERE stored_path=?1",
            [relative],
            |r| r.get(0),
        )
        .optional()?
        .flatten();
    disk_path(conn, original.as_deref().unwrap_or(relative))
}
pub fn effective_path(conn: &rusqlite::Connection, relative: &str) -> AppResult<PathBuf> {
    use rusqlite::OptionalExtension;
    let processed: Option<String> = conn
        .query_row(
            "SELECT processed_path FROM document_metadata WHERE stored_path=?1",
            [relative],
            |r| r.get(0),
        )
        .optional()?
        .flatten();
    disk_path(conn, processed.as_deref().unwrap_or(relative))
}
pub fn export_name(conn: &rusqlite::Connection, relative: &str) -> AppResult<String> {
    let source = effective_path(conn, relative)?;
    let original = Path::new(relative).file_name().ok_or(AppError::NotFound)?;
    let mut name = PathBuf::from(original);
    if let Some(extension) = source.extension() {
        name.set_extension(extension);
    }
    Ok(name.to_string_lossy().into_owned())
}
pub fn save_existing(
    conn: &rusqlite::Connection,
    owner: &str,
    token: &str,
    relative: &str,
) -> AppResult<()> {
    let result = save_existing_inner(conn, owner, token, relative);
    // A committed save must never be reported as failed because post-commit cleanup failed.
    // Durable journals are retained for the next startup/recovery attempt.
    let _ = recover_pending_files(conn);
    result
}
fn save_existing_inner(
    conn: &rusqlite::Connection,
    owner: &str,
    token: &str,
    relative: &str,
) -> AppResult<()> {
    validate_target(owner, token, Some(relative))?;
    let source = associated_path(conn, owner, relative, true)?;
    let staged = stage(owner, token)?;
    // New random version and metadata pointer; current attachment association never changes.
    let parent = source.parent().ok_or(AppError::NotFound)?;
    let prefix = Path::new(relative)
        .parent()
        .and_then(|p| p.to_str())
        .ok_or(AppError::NotFound)?;
    let tx = conn.unchecked_transaction()?;
    let meta = crate::files::validate_upload(
        source.to_str().ok_or(AppError::NotFound)?,
        false,
        true,
        crate::files::MAX_DOCUMENT_SIZE,
    )?;
    let limit = if relative.starts_with("Branding/") || relative.contains("/Photo/") {
        crate::files::MAX_IMAGE_SIZE
    } else {
        crate::files::MAX_DOCUMENT_SIZE
    };
    let version =
        crate::files::copy_validated_upload(&tx, &staged, parent, prefix, false, true, limit)?;
    let result = (|| -> AppResult<()> {
        tx.execute(
            "UPDATE document_metadata SET parent_path=?1 WHERE stored_path=?2",
            rusqlite::params![relative, version],
        )?;
        tx.execute("INSERT INTO document_metadata(stored_path,original_name,mime_type,size_bytes,processed_path) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(stored_path) DO UPDATE SET processed_path=excluded.processed_path",rusqlite::params![relative,meta.original_name,meta.mime_type,meta.size as i64,version])?;
        // copy_validated_upload records one checked PROCESS_DOCUMENT event in this transaction.
        Ok(())
    })();
    if let Err(e) = result {
        cleanup_metadata_file(&tx, &version);
        return Err(e);
    }
    let original: Option<String> = tx
        .query_row(
            "SELECT original_path FROM document_metadata WHERE stored_path=?1",
            [&version],
            |r| r.get(0),
        )
        .ok()
        .flatten();
    if let Err(e) = tx.commit() {
        for p in std::iter::once(version).chain(original) {
            std::fs::remove_file(crate::services::storage_path(conn).join(p)).ok();
        }
        return Err(e.into());
    }
    Ok(())
}
pub fn validate_target(owner: &str, token: &str, target: Option<&str>) -> AppResult<()> {
    let sessions = sessions().lock().unwrap();
    let s = sessions.get(token).ok_or(AppError::NotFound)?;
    if s.owner != owner || s.target.as_deref() != target {
        return Err(AppError::Unauthorized);
    }
    Ok(())
}
#[derive(Serialize)]
pub struct Detection {
    pub corners: [[f32; 2]; 4],
    pub confidence: f32,
    pub reliable: bool,
    pub debug: DetectionDebug,
}
pub fn redetect(owner: &str, token: &str) -> AppResult<Detection> {
    let sessions = sessions().lock().unwrap();
    let s = sessions.get(token).ok_or(AppError::NotFound)?;
    if s.owner != owner {
        return Err(AppError::Unauthorized);
    }
    let (corners, confidence, debug) = match crate::ai_detect::detect(&s.image) {
        Some((corners, confidence)) => (
            corners,
            confidence,
            DetectionDebug {
                original_dimensions: [s.image.width(), s.image.height()],
                ai_status: "Bundled on-device model (U2-Netp)",
                ..Default::default()
            },
        ),
        None if cfg!(debug_assertions) => detect_debug(&s.image),
        None => {
            return Err(error("Automatic detection could not find the document; use manual corners"))
        }
    };
    Ok(Detection {
        corners,
        confidence,
        reliable: confidence >= s.settings.confidence_threshold,
        debug,
    })
}
#[derive(Serialize)]
pub struct Versions {
    pub original: Vec<u8>,
    pub processed: Vec<u8>,
}
#[cfg(test)]
pub fn versions(conn: &rusqlite::Connection, owner: &str, relative: &str) -> AppResult<Versions> {
    associated_path(conn, owner, relative, false)?;
    preview_versions(
        original_path(conn, relative)?,
        effective_path(conn, relative)?,
    )
}
pub fn preview_versions(original: PathBuf, processed: PathBuf) -> AppResult<Versions> {
    let preview =
        |path: PathBuf| -> AppResult<Vec<u8>> { jpeg(&thumbnail(&load_image(&path)?, 1800), 94) };
    Ok(Versions {
        original: preview(original)?,
        processed: preview(processed)?,
    })
}
pub fn cleanup_metadata_file(conn: &rusqlite::Connection, relative: &str) {
    let mut queue = vec![relative.to_string()];
    let mut seen = std::collections::HashSet::new();
    while let Some(path) = queue.pop() {
        if !seen.insert(path.clone()) {
            continue;
        }
        if let Ok((original, processed)) = conn.query_row(
            "SELECT original_path,processed_path FROM document_metadata WHERE stored_path=?1",
            [&path],
            |r| {
                Ok((
                    r.get::<_, Option<String>>(0)?,
                    r.get::<_, Option<String>>(1)?,
                ))
            },
        ) {
            queue.extend(original);
            queue.extend(processed);
        }
        if let Ok(mut stmt) =
            conn.prepare("SELECT stored_path FROM document_metadata WHERE parent_path=?1")
        {
            if let Ok(rows) = stmt.query_map([&path], |r| r.get::<_, String>(0)) {
                queue.extend(rows.filter_map(Result::ok));
            }
        }
        if let Ok(p) = crate::files::safe_relative_path(&path) {
            std::fs::remove_file(crate::services::storage_path(conn).join(p)).ok();
        }
        conn.execute(
            "DELETE FROM document_metadata WHERE stored_path=?1",
            [&path],
        )
        .ok();
    }
}
pub fn remove_replaced(conn: &rusqlite::Connection, source: &str, relative: &Path) {
    let mut sessions = sessions().lock().unwrap();
    if let Some(s) = sessions
        .values_mut()
        .find(|s| s.temp.path().join("processed.jpg") == Path::new(source))
    {
        s.deferred_deletes
            .push(relative.to_string_lossy().into_owned());
    } else {
        cleanup_metadata_file(conn, &relative.to_string_lossy());
    }
}
pub fn finish_upload(conn: &rusqlite::Connection, token: &str) {
    let paths = sessions()
        .lock()
        .unwrap()
        .get_mut(token)
        .map(|s| std::mem::take(&mut s.deferred_deletes))
        .unwrap_or_default();
    for path in paths {
        cleanup_metadata_file(conn, &path);
    }
}

/// Opt-in production-binary diagnostic. Uses generated documents and never opens the application DB.
pub fn production_self_test() -> AppResult<()> {
    let directory = tempfile::tempdir().map_err(error)?;
    let mut pixels = RgbImage::from_pixel(600, 500, Rgb([25, 35, 45]));
    imageproc::drawing::draw_polygon_mut(
        &mut pixels,
        &[
            imageproc::point::Point::new(100, 65),
            imageproc::point::Point::new(520, 105),
            imageproc::point::Point::new(490, 425),
            imageproc::point::Point::new(70, 390),
        ],
        Rgb([235, 235, 230]),
    );
    let image = DynamicImage::ImageRgb8(pixels);
    for extension in ["png", "jpg", "webp"] {
        let path = directory.path().join(format!("synthetic.{extension}"));
        image.save(&path).map_err(error)?;
        let original = std::fs::read(&path).map_err(error)?;
        let input = prepare(
            "scanner-self-test".into(),
            &path,
            ScannerSettings::default(),
            None,
        )?;
        let result = (|| -> AppResult<()> {
            let corners = if input.automatic_detection_available {
                if !input.reliable {
                    return Err(error("Synthetic document detection failed"));
                }
                input.corners
            } else {
                if input.reliable || input.corners != full_corners(input.width, input.height) {
                    return Err(error("Production must start with manual full-image bounds"));
                }
                [[100., 65.], [520., 105.], [490., 425.], [70., 390.]]
            };
            render("scanner-self-test", &input.token, corners, 90, Adjustments { auto_levels: true, sharpness: 1, ..Default::default() })?;
            let processed = load_image(Path::new(&stage("scanner-self-test", &input.token)?))?;
            if !(300..=350).contains(&processed.width())
                || !(400..=450).contains(&processed.height())
            {
                return Err(error("Unexpected corrected dimensions"));
            }
            if std::fs::read(&path).map_err(error)? != original {
                return Err(error("Original was modified"));
            }
            Ok(())
        })();
        release("scanner-self-test", &input.token)?;
        result?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn detects_synthetic_document_and_corrects_perspective() {
        let mut img = RgbImage::from_pixel(600, 500, Rgb([25, 35, 45]));
        imageproc::drawing::draw_polygon_mut(
            &mut img,
            &[
                imageproc::point::Point::new(100, 65),
                imageproc::point::Point::new(520, 105),
                imageproc::point::Point::new(490, 425),
                imageproc::point::Point::new(70, 390),
            ],
            Rgb([235, 235, 230]),
        );
        let image = DynamicImage::ImageRgb8(img);
        let (corners, confidence) = detect(&image);
        assert!(confidence > 0.65, "confidence={confidence}");
        let out = transform(&image, corners, 0, 0).unwrap();
        assert!(out.width() > 400 && out.width() < 450);
        assert!(out.height() > 310 && out.height() < 345);
        assert!(out.to_rgb8().get_pixel(200, 150).0[0] > 220);
        let enlarged = image.resize_exact(1800, 1500, image::imageops::FilterType::Nearest);
        let (mapped, confidence) = detect(&enlarged);
        assert!(confidence > 0.65);
        for (a, b) in mapped.iter().zip(corners.iter()) {
            assert!(
                (a[0] - b[0] * 3.).hypot(a[1] - b[1] * 3.) < 10.,
                "thumbnail to original mapping"
            );
        }
        let corrected = transform(&enlarged, mapped, 0, 0).unwrap();
        assert!(corrected.width() > 1200 && corrected.width() < 1350);
    }
    #[test]
    fn coloured_document_contains_internal_high_contrast_region() {
        use imageproc::point::Point;
        let mut img = RgbImage::from_fn(400, 700, |x, y| {
            let v = (155 + ((x / 3 + y / 5) % 3) * 10) as u8;
            Rgb([v, v, v])
        });
        let truth = [[45., 210.], [350., 218.], [375., 390.], [30., 388.]];
        imageproc::drawing::draw_polygon_mut(
            &mut img,
            &truth.map(|p| Point::new(p[0] as i32, p[1] as i32)),
            Rgb([160, 165, 200]),
        );
        imageproc::drawing::draw_polygon_mut(
            &mut img,
            &[
                Point::new(80, 245),
                Point::new(130, 245),
                Point::new(160, 340),
                Point::new(65, 340),
            ],
            Rgb([25, 25, 25]),
        );
        let (corners, confidence, debug) = detect_debug(&DynamicImage::ImageRgb8(img));
        let error = corners
            .iter()
            .zip(truth.iter())
            .map(|(a, b)| (a[0] - b[0]).hypot(a[1] - b[1]))
            .sum::<f32>()
            / 4.;
        assert!(
            confidence >= 0.65 && error < 8.,
            "Must select coloured outer document, not internal content: {confidence}, {error}"
        );
        assert!(debug.selected.is_some());
    }
    #[test]
    fn production_policy_overrides_legacy_automatic_settings() {
        let requested = ScannerSettings {
            auto_detect: true,
            enhancement: 2,
            ..Default::default()
        };
        let production = apply_build_policy(requested.clone(), false);
        assert!(!production.auto_detect);
        assert_eq!(production.enhancement, 0);
        assert_eq!(production.enabled, requested.enabled);
        assert_eq!(production.quality, requested.quality);
        let development = apply_build_policy(requested, true);
        assert!(development.auto_detect);
        assert_eq!(development.enhancement, 2);
    }
    // Opt-in private image test; source path is supplied at runtime and never committed.
    #[test]
    #[ignore]
    fn actual_photo_localization() {
        use sha2::Digest;
        let source =
            std::env::var_os("SCANNER_TEST_IMAGE").expect("SCANNER_TEST_IMAGE is required");
        let image = load_image(Path::new(&source)).unwrap();
        let original_hash = sha2::Sha256::digest(std::fs::read(Path::new(&source)).unwrap());
        let (corners, confidence, debug) = detect_debug(&image);
        let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("../.scanner-local");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(
            folder.join("actual-debug.json"),
            serde_json::to_vec_pretty(&debug).unwrap(),
        )
        .unwrap();
        let mut overlay = image.to_rgb8();
        for i in 0..4 {
            imageproc::drawing::draw_line_segment_mut(
                &mut overlay,
                (corners[i][0], corners[i][1]),
                (corners[(i + 1) % 4][0], corners[(i + 1) % 4][1]),
                Rgb([90, 255, 30]),
            );
            imageproc::drawing::draw_hollow_circle_mut(
                &mut overlay,
                (corners[i][0].round() as i32, corners[i][1].round() as i32),
                8,
                Rgb([90, 255, 30]),
            );
        }
        overlay.save(folder.join("actual-overlay.png")).unwrap();
        if confidence >= 0.65 {
            transform(&image, corners, 0, 0)
                .unwrap()
                .save(folder.join("actual-crop.png"))
                .unwrap();
        }
        println!(
            "dimensions={}x{}, confidence={confidence}, candidates={}, corners={corners:?}",
            image.width(),
            image.height(),
            debug.candidates.len()
        );
        let annotation = std::env::var_os("SCANNER_TEST_ANNOTATION")
            .expect("SCANNER_TEST_ANNOTATION is required");
        let truth: [[f32; 2]; 4] =
            serde_json::from_slice(&std::fs::read(annotation).unwrap()).unwrap();
        let error = corners
            .iter()
            .zip(truth.iter())
            .map(|(a, b)| (a[0] - b[0]).hypot(a[1] - b[1]))
            .sum::<f32>()
            / 4.;
        let mut expected = image::GrayImage::new(image.width(), image.height());
        let mut actual = image::GrayImage::new(image.width(), image.height());
        imageproc::drawing::draw_polygon_mut(
            &mut expected,
            &truth.map(|p| imageproc::point::Point::new(p[0].round() as i32, p[1].round() as i32)),
            image::Luma([255]),
        );
        imageproc::drawing::draw_polygon_mut(
            &mut actual,
            &corners
                .map(|p| imageproc::point::Point::new(p[0].round() as i32, p[1].round() as i32)),
            image::Luma([255]),
        );
        let mut intersection = 0;
        let mut union = 0;
        for (a, b) in expected.pixels().zip(actual.pixels()) {
            if a[0] > 0 && b[0] > 0 {
                intersection += 1;
            }
            if a[0] > 0 || b[0] > 0 {
                union += 1;
            }
        }
        let iou = intersection as f32 / union as f32;
        std::fs::write(folder.join("actual-metrics.json"),serde_json::to_vec_pretty(&serde_json::json!({"mean_corner_error_px":error,"iou":iou,"confidence":confidence,"corners":corners,"dimensions":[image.width(),image.height()]})).unwrap()).unwrap();
        println!("manual_annotation: mean_corner_error_px={error:.3}, IoU={iou:.4}");
        assert!(
            confidence >= 0.65 && error < 12. && iou > 0.94,
            "Actual physical document localization failed"
        );
        assert_eq!(
            original_hash,
            sha2::Sha256::digest(std::fs::read(Path::new(&source)).unwrap()),
            "Source image must remain unchanged"
        );
    }
    #[test]
    fn annotated_detection_suite() {
        use imageproc::point::Point;
        // Synthetic localization fixtures. No personal images or production storage.
        let cases = [
            (
                "fabric",
                [[160, 260], [470, 260], [470, 450], [160, 450]],
                0,
            ),
            ("wood", [[140, 120], [490, 120], [490, 340], [140, 340]], 1),
            ("border", [[8, 150], [320, 150], [320, 350], [8, 350]], 0),
            ("small", [[380, 340], [520, 340], [520, 425], [380, 425]], 0),
            (
                "rotated",
                [[230, 60], [475, 230], [355, 410], [110, 240]],
                1,
            ),
            (
                "perspective",
                [[100, 65], [520, 105], [490, 425], [70, 390]],
                0,
            ),
            ("a4", [[190, 35], [430, 35], [430, 465], [190, 465]], 1),
            (
                "complex",
                [[160, 260], [470, 260], [470, 450], [160, 450]],
                2,
            ),
            (
                "low-contrast",
                [[160, 260], [470, 260], [470, 450], [160, 450]],
                3,
            ),
            ("near-full", [[7, 7], [592, 7], [592, 492], [7, 492]], 0),
        ];
        for (name, truth, background) in cases {
            let mut img = RgbImage::from_fn(600, 500, |x, y| {
                let value = match background {
                    0 => 45 + ((x / 3 + y / 3) % 2) * 22,
                    1 => 60 + ((x / 5 + y / 40) % 4) * 9,
                    2 => 40 + ((x * 17 + y * 31) % 100),
                    _ => 175 + ((x / 3 + y / 3) % 2) * 4,
                } as u8;
                Rgb([value, value, value])
            });
            let color = if background == 3 { 195 } else { 230 };
            imageproc::drawing::draw_polygon_mut(
                &mut img,
                &truth.map(|p| Point::new(p[0], p[1])),
                Rgb([color, color, color]),
            );
            let image = DynamicImage::ImageRgb8(img);
            let (corners, confidence, debug) = detect_debug(&image);
            let gt = order(truth.iter().map(|p| [p[0] as f32, p[1] as f32]).collect());
            let error = corners
                .iter()
                .zip(gt.iter())
                .map(|(a, b)| (a[0] - b[0]).hypot(a[1] - b[1]))
                .sum::<f32>()
                / 4.;
            // Measure polygon IoU by rasterization, independent of the detector's score.
            let mut expected = image::GrayImage::new(600, 500);
            let mut actual = image::GrayImage::new(600, 500);
            imageproc::drawing::draw_polygon_mut(
                &mut expected,
                &gt.map(|p| Point::new(p[0] as i32, p[1] as i32)),
                image::Luma([255]),
            );
            imageproc::drawing::draw_polygon_mut(
                &mut actual,
                &corners.map(|p| Point::new(p[0].round() as i32, p[1].round() as i32)),
                image::Luma([255]),
            );
            let mut intersection = 0;
            let mut union = 0;
            for (a, b) in expected.pixels().zip(actual.pixels()) {
                if a[0] > 0 && b[0] > 0 {
                    intersection += 1;
                }
                if a[0] > 0 || b[0] > 0 {
                    union += 1;
                }
            }
            let iou = intersection as f32 / union as f32;
            println!("{name}: confidence={confidence:.3}, corner_error_px={error:.2}, IoU={iou:.3}, candidates={}",debug.candidates.len());
            if confidence < 0.65 {
                println!(
                    "diagnostics={}",
                    serde_json::to_string(&debug.candidates).unwrap()
                );
            }
            assert!(
                confidence >= 0.65 && error < 8. && iou > 0.9,
                "{name}: confidence={confidence}, error={error}, IoU={iou}"
            );
            if std::env::var_os("SCANNER_TEST_ARTIFACTS").is_some() {
                let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("../scanner-verification");
                std::fs::create_dir_all(&folder).unwrap();
                let mut overlay = image.to_rgb8();
                for i in 0..4 {
                    imageproc::drawing::draw_line_segment_mut(
                        &mut overlay,
                        (corners[i][0], corners[i][1]),
                        (corners[(i + 1) % 4][0], corners[(i + 1) % 4][1]),
                        Rgb([90, 255, 30]),
                    );
                    imageproc::drawing::draw_hollow_circle_mut(
                        &mut overlay,
                        (corners[i][0].round() as i32, corners[i][1].round() as i32),
                        5,
                        Rgb([90, 255, 30]),
                    );
                }
                overlay
                    .save(folder.join(format!("{name}-overlay.png")))
                    .unwrap();
                std::fs::write(
                    folder.join(format!("{name}-debug.json")),
                    serde_json::to_vec_pretty(&debug).unwrap(),
                )
                .unwrap();
                transform(&image, corners, 0, 0)
                    .unwrap()
                    .save(folder.join(format!("{name}-crop.png")))
                    .unwrap();
            }
            let out = transform(&image, corners, 0, 0).unwrap();
            assert!(out.width() > 16 && out.height() > 16);
        }
        let texture = DynamicImage::ImageRgb8(RgbImage::from_fn(600, 500, |x, y| {
            let v = (40 + ((x * 17 + y * 31) % 100)) as u8;
            Rgb([v, v, v])
        }));
        assert_eq!(
            detect(&texture).1,
            0.,
            "Texture alone must not become a document"
        );
    }
    #[test]
    fn blank_requires_manual_and_invalid_corners_are_rejected() {
        let image = DynamicImage::ImageRgb8(RgbImage::from_pixel(320, 240, Rgb([90, 90, 90])));
        assert_eq!(detect(&image).1, 0.);
        assert!(transform(
            &image,
            [[0., 0.], [319., 239.], [319., 0.], [0., 239.]],
            0,
            0
        )
        .is_err());
        let out = transform(&image, full_corners(320, 240), 90, 0).unwrap();
        assert_eq!((out.width(), out.height()), (240, 320));
    }
}
