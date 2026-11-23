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

# Bundled models: ocr_det.onnx, ocr_rec_ar.onnx, ocr_ar_dict.txt

On-device text reading for national cards and passports (`src-tauri/src/ocr.rs`). Images and the
text read from them stay on the computer; nothing is sent over the network and nothing read is
stored until the user confirms it in the form.

- Models: PaddleOCR PP-OCRv5 mobile text detector and PP-OCRv5 mobile Arabic-script recogniser
  (reads Arabic, Kurdish, Persian letters, Latin letters and digits).
  Source and weights: https://github.com/PaddlePaddle/PaddleOCR (Apache License 2.0).
- ONNX export: oar-ocr release v0.3.0, https://github.com/GreatV/oar-ocr (Apache License 2.0),
  release assets `pp-ocrv5_mobile_det.onnx` (sha256 1eb7b4f7…a8e4a039),
  `arabic_pp-ocrv5_mobile_rec.onnx` (sha256 2768206d…a9dc0384) and `ppocrv5_arabic_dict.txt`.
- Local change, needed for the pure-Rust `tract` runtime (weights are unchanged): the stored
  intermediate and output shape annotations (`value_info`, symbolic output dims) were removed so
  tract infers shapes from the fixed input size the app sets (1×3×1024×1024 for the detector,
  1×3×48×W for the recogniser).
- Resulting files sha256:
  - ocr_det.onnx    f3d6e10d1c0474035fcce1315369836832cb4d26de99a23d11d5164d27543ddd
  - ocr_rec_ar.onnx 11a63615dd83a379a0023cec3799143c877e36ecb1ffc9f1f7ca014f75ba1934
  - ocr_ar_dict.txt 7f92f7dbb9b75a4787a83bfb4f6d14a8ab515525130c9d40a9036f61cf6999e9
