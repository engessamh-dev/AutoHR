# Bundled model: u2netp.onnx

On-device document localisation for the attachment editor (`src-tauri/src/ai_detect.rs`).
Images are processed locally only; nothing is sent over the network.

- Model: U²-Netp, the small 4.7 MB variant of U²-Net. From Qin et al., "U²-Net: Going Deeper with
  Nested U-Structure for Salient Object Detection" (Pattern Recognition, 2020).
  Source and weights: https://github.com/xuebinqin/U-2-Net (Apache License 2.0).
- ONNX export: rembg, https://github.com/danielgatis/rembg (MIT License),
  release asset `u2netp.onnx` (sha256 309c8469…74ddd8).
- Local changes, needed for the pure-Rust `tract` runtime (weights are unchanged):
  1. Resize `coordinate_transformation_mode` changed from `pytorch_half_pixel` to `half_pixel`.
     The two are identical for these upsampling sizes.
  2. The graph was simplified to a static 1×3×320×320 input with onnx-simplifier.
  3. Each Resize uses constant `scales` instead of computed `sizes`.
  The output matches the original under ONNX Runtime (mean 0.118242 for both).
- Resulting file sha256: 4e6c69f28de41ac6e454fcb31155241719ae153d012de66553b0b21990f7c168
