// Map the preview rectangle to the selected quadrilateral in source coordinates.
function projection(points) {
  const rows = [];
  [[0, 0], [1, 0], [1, 1], [0, 1]].forEach(([u, v], i) => {
    const [x, y] = points[i];
    rows.push([u, v, 1, 0, 0, 0, -u * x, -v * x, x]);
    rows.push([0, 0, 0, u, v, 1, -u * y, -v * y, y]);
  });
  for (let col = 0; col < 8; col++) {
    let pivot = col;
    for (let row = col + 1; row < 8; row++) if (Math.abs(rows[row][col]) > Math.abs(rows[pivot][col])) pivot = row;
    [rows[col], rows[pivot]] = [rows[pivot], rows[col]];
    const divisor = rows[col][col];
    if (Math.abs(divisor) < 1e-9) return null;
    for (let j = col; j < 9; j++) rows[col][j] /= divisor;
    for (let row = 0; row < 8; row++) {
      if (row === col) continue;
      const factor = rows[row][col];
      for (let j = col; j < 9; j++) rows[row][j] -= factor * rows[col][j];
    }
  }
  return rows.map(row => row[8]);
}

export const CARD_ASPECT = 85.60 / 53.98;

/** Output size of the corrected image, mirroring scanner::transform_with in Rust. */
export function outputSize(corners, cardAspect = false) {
  const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  let w = Math.round(Math.max(distance(corners[0], corners[1]), distance(corners[3], corners[2]))) + 1;
  let h = Math.round(Math.max(distance(corners[0], corners[3]), distance(corners[1], corners[2]))) + 1;
  if (cardAspect) {
    if (w >= h) h = Math.round(w / CARD_ASPECT);
    else w = Math.round(h / CARD_ASPECT);
  }
  return { w, h };
}

/** Same order and maths as scanner::apply_adjustments, applied to the small preview. */
export function applyAdjustments(imageData, adjustments = {}) {
  const data = imageData.data;
  const clamp = value => value < 0 ? 0 : value > 255 ? 255 : value;
  if (adjustments.auto_levels) {
    const histogram = new Uint32Array(256);
    for (let i = 0; i < data.length; i += 4) histogram[Math.min(255, Math.round(0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]))]++;
    const total = data.length / 4;
    const percentile = fraction => { const target = Math.floor(total * fraction); let seen = 0; for (let v = 0; v < 256; v++) { seen += histogram[v]; if (seen > target) return v; } return 255; };
    const low = percentile(0.01), high = percentile(0.99);
    if (high - low >= 16) {
      const scale = 255 / (high - low);
      for (let i = 0; i < data.length; i += 4) for (let c = 0; c < 3; c++) data[i + c] = clamp(Math.round((data[i + c] - low) * scale));
    }
  }
  if (adjustments.brightness) for (let i = 0; i < data.length; i += 4) for (let c = 0; c < 3; c++) data[i + c] = clamp(data[i + c] + adjustments.brightness);
  if (adjustments.contrast) {
    const percent = ((100 + adjustments.contrast) / 100) ** 2;
    for (let i = 0; i < data.length; i += 4) for (let c = 0; c < 3; c++) data[i + c] = clamp(((data[i + c] / 255 - 0.5) * percent + 0.5) * 255);
  }
  if (adjustments.sharpness) {
    const amount = [0, 0.5, 0.8, 1.2][adjustments.sharpness];
    const { width, height } = imageData, copy = new Uint8ClampedArray(data);
    for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
      const i = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) {
        const blur = (copy[i + c - 4] + copy[i + c + 4] + copy[i + c - width * 4] + copy[i + c + width * 4] + copy[i + c]) / 5;
        data[i + c] = clamp(copy[i + c] + amount * (copy[i + c] - blur));
      }
    }
  }
  if (adjustments.grayscale) for (let i = 0; i < data.length; i += 4) {
    const luma = clamp(Math.round(0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]));
    data[i] = data[i + 1] = data[i + 2] = luma;
  }
  return imageData;
}

export function createLivePreview(image, width, height) {
  const source = document.createElement("canvas");
  const scale = Math.min(1, 900 / Math.max(image.naturalWidth, image.naturalHeight));
  source.width = Math.max(1, Math.round(image.naturalWidth * scale));
  source.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const ctx = source.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, source.width, source.height);
  const pixels = ctx.getImageData(0, 0, source.width, source.height).data;
  const crop = document.createElement("canvas"), output = document.createElement("canvas");
  return (corners, rotation, adjustments = {}) => {
    const { w, h } = outputSize(corners, adjustments.card_aspect);
    const size = Math.min(1, 480 / Math.max(w, h));
    crop.width = Math.max(2, Math.round(w * size)); crop.height = Math.max(2, Math.round(h * size));
    const matrix = projection(corners.map(([x, y]) => [x / (width - 1) * (source.width - 1), y / (height - 1) * (source.height - 1)]));
    if (!matrix) return null;
    const buffer = new ImageData(crop.width, crop.height), data = buffer.data;
    const [a, b, c, d, e, f, g, k] = matrix;
    for (let y = 0; y < crop.height; y++) for (let x = 0; x < crop.width; x++) {
      const u = x / (crop.width - 1), v = y / (crop.height - 1), denominator = g * u + k * v + 1;
      const sx = Math.max(0, Math.min(source.width - 1, Math.round((a * u + b * v + c) / denominator)));
      const sy = Math.max(0, Math.min(source.height - 1, Math.round((d * u + e * v + f) / denominator)));
      const from = (sy * source.width + sx) * 4, to = (y * crop.width + x) * 4;
      data[to] = pixels[from]; data[to + 1] = pixels[from + 1]; data[to + 2] = pixels[from + 2]; data[to + 3] = 255;
    }
    crop.getContext("2d").putImageData(applyAdjustments(buffer, adjustments), 0, 0);
    output.width = rotation % 180 ? crop.height : crop.width;
    output.height = rotation % 180 ? crop.width : crop.height;
    const result = output.getContext("2d");
    result.translate(output.width / 2, output.height / 2); result.rotate(rotation * Math.PI / 180);
    result.drawImage(crop, -crop.width / 2, -crop.height / 2);
    return output.toDataURL("image/jpeg", .85);
  };
}
