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

export function createLivePreview(image, width, height) {
  const source = document.createElement("canvas");
  const scale = Math.min(1, 900 / Math.max(image.naturalWidth, image.naturalHeight));
  source.width = Math.max(1, Math.round(image.naturalWidth * scale));
  source.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const ctx = source.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, source.width, source.height);
  const pixels = ctx.getImageData(0, 0, source.width, source.height).data;
  const crop = document.createElement("canvas"), output = document.createElement("canvas");
  return (corners, rotation) => {
    const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    const w = Math.max(distance(corners[0], corners[1]), distance(corners[3], corners[2]));
    const h = Math.max(distance(corners[0], corners[3]), distance(corners[1], corners[2]));
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
    crop.getContext("2d").putImageData(buffer, 0, 0);
    output.width = rotation % 180 ? crop.height : crop.width;
    output.height = rotation % 180 ? crop.width : crop.height;
    const result = output.getContext("2d");
    result.translate(output.width / 2, output.height / 2); result.rotate(rotation * Math.PI / 180);
    result.drawImage(crop, -crop.width / 2, -crop.height / 2);
    return output.toDataURL("image/jpeg", .85);
  };
}
