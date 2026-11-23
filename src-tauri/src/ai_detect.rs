//! Offline document localisation with a small bundled segmentation model.
//!
//! The model is U²-Netp (Apache-2.0, https://github.com/xuebinqin/U-2-Net), exported to ONNX by
//! rembg (MIT) and rewritten to static shapes / scale-based Resize so the pure-Rust `tract`
//! runtime can execute it. It runs entirely on the device: no image ever leaves the computer.
//! The salient-object mask is turned into a quadrilateral that the user can still adjust.
use image::{imageops::FilterType, DynamicImage, GrayImage, Luma};
use imageproc::{
    contours::{find_contours, BorderType},
    geometry::min_area_rect,
    point::Point,
};
use std::sync::OnceLock;
use tract_onnx::prelude::*;

const MODEL_BYTES: &[u8] = include_bytes!("../models/u2netp.onnx");
const SIZE: u32 = 320;
type Model = std::sync::Arc<TypedRunnableModel>;

fn model() -> Option<&'static Model> {
    static MODEL: OnceLock<Option<Model>> = OnceLock::new();
    MODEL
        .get_or_init(|| {
            tract_onnx::onnx()
                .model_for_read(&mut std::io::Cursor::new(MODEL_BYTES))
                .and_then(|m| m.with_input_fact(0, f32::fact([1, 3, SIZE as usize, SIZE as usize]).into()))
                .and_then(|m| m.into_optimized())
                .and_then(|m| m.into_runnable())
                .ok()
        })
        .as_ref()
}

/// Whether the bundled model loaded successfully on this machine.
pub fn available() -> bool {
    model().is_some()
}

/// Salient-object probability map at SIZE×SIZE, min-max normalised to 0..255.
fn saliency(image: &DynamicImage) -> Option<GrayImage> {
    let model = model()?;
    let resized = image.resize_exact(SIZE, SIZE, FilterType::Triangle).to_rgb8();
    let mean = [0.485f32, 0.456, 0.406];
    let std = [0.229f32, 0.224, 0.225];
    let input: Tensor = tract_ndarray::Array4::from_shape_fn((1, 3, SIZE as usize, SIZE as usize), |(_, c, y, x)| {
        (f32::from(resized.get_pixel(x as u32, y as u32)[c]) / 255. - mean[c]) / std[c]
    })
    .into();
    let outputs = model.run(tvec!(input.into())).ok()?;
    let map = outputs.first()?.to_plain_array_view::<f32>().ok()?;
    let (low, high) = map.iter().fold((f32::MAX, f32::MIN), |(lo, hi), v| (lo.min(*v), hi.max(*v)));
    if !(high - low).is_finite() || high - low < 1e-3 {
        return None;
    }
    Some(GrayImage::from_fn(SIZE, SIZE, |x, y| {
        Luma([(((map[[0, 0, y as usize, x as usize]] - low) / (high - low)) * 255.).round() as u8])
    }))
}

fn polygon_area(points: &[[f32; 2]]) -> f32 {
    let mut area = 0.;
    for i in 0..points.len() {
        let a = points[i];
        let b = points[(i + 1) % points.len()];
        area += a[0] * b[1] - b[0] * a[1];
    }
    area.abs() / 2.
}

/// Corners (TL, TR, BR, BL) in original-image pixels and a 0..1 confidence.
pub fn detect(image: &DynamicImage) -> Option<([[f32; 2]; 4], f32)> {
    let map = saliency(image)?;
    let mask = GrayImage::from_fn(SIZE, SIZE, |x, y| Luma([if map.get_pixel(x, y)[0] >= 128 { 255 } else { 0 }]));
    let total_foreground = mask.pixels().filter(|p| p[0] > 0).count() as f32;
    let contour = find_contours::<i32>(&mask)
        .into_iter()
        .filter(|c| c.border_type == BorderType::Outer && c.points.len() >= 12)
        .max_by(|a, b| {
            let area = |c: &imageproc::contours::Contour<i32>| polygon_area(&c.points.iter().map(|p| [p.x as f32, p.y as f32]).collect::<Vec<_>>());
            area(a).total_cmp(&area(b))
        })?;
    let outline: Vec<[f32; 2]> = contour.points.iter().map(|p| [p.x as f32, p.y as f32]).collect();
    let object_area = polygon_area(&outline);
    let frame = (SIZE * SIZE) as f32;
    if object_area < frame * 0.01 || object_area > frame * 0.97 {
        return None;
    }
    let rect = min_area_rect(&contour.points);
    let initial = crate::scanner::order_corners(rect.iter().map(|p: &Point<i32>| [p.x as f32, p.y as f32]).collect());
    let quad = crate::scanner::refine_quad(initial, &contour.points);
    let quad_area = polygon_area(&quad);
    // Agreement between the mask and the fitted quadrilateral, and dominance of one object.
    let fit = object_area.min(quad_area) / object_area.max(quad_area).max(1.);
    let dominance = (object_area / total_foreground.max(1.)).min(1.);
    let confidence = (fit * dominance).clamp(0., 1.);
    let (sx, sy) = ((image.width() - 1) as f32 / (SIZE - 1) as f32, (image.height() - 1) as f32 / (SIZE - 1) as f32);
    let corners = quad.map(|[x, y]| [
        (x * sx).clamp(0., (image.width() - 1) as f32),
        (y * sy).clamp(0., (image.height() - 1) as f32),
    ]);
    crate::scanner::validate_corners(&corners, image.width(), image.height()).ok()?;
    Some((corners, confidence))
}
