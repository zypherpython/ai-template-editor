interface Placeholder {
  id: string;
  label: string;
  type: string;
  shape: string;
  confidence: number;
  rotation: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface AnalysisResult {
  placeholders: Placeholder[];
  template_width: number;
  template_height: number;
}

function grayscale(data: Uint8ClampedArray): Uint8Array {
  const gray = new Uint8Array(data.length / 4);
  for (let i = 0; i < gray.length; i++) {
    const j = i * 4;
    gray[i] = (76 * data[j] + 150 * data[j + 1] + 29 * data[j + 2]) >> 8;
  }
  return gray;
}

function sobelEdgeStrength(gray: Uint8Array, w: number, h: number): Float32Array {
  const edges = new Float32Array(gray.length);
  for (let y = 1; y < h - 1; y++) {
    const rowAbove = (y - 1) * w;
    const row = y * w;
    const rowBelow = (y + 1) * w;
    for (let x = 1; x < w - 1; x++) {
      const gx =
        -gray[rowAbove + x - 1] + gray[rowAbove + x + 1]
        - 2 * gray[row + x - 1] + 2 * gray[row + x + 1]
        - gray[rowBelow + x - 1] + gray[rowBelow + x + 1];
      const gy =
        -gray[rowAbove + x - 1] - 2 * gray[rowAbove + x] - gray[rowAbove + x + 1]
        + gray[rowBelow + x - 1] + 2 * gray[rowBelow + x] + gray[rowBelow + x + 1];
      edges[row + x] = Math.sqrt(gx * gx + gy * gy);
    }
  }
  return edges;
}

function buildIntegral(data: Float32Array | Uint8Array, w: number, h: number): Float64Array {
  const integral = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    const rowOut = (y + 1) * (w + 1) + 1;
    const rowIn = y * w;
    const rowAbove = y * (w + 1) + 1;
    for (let x = 0; x < w; x++) {
      integral[rowOut + x] = data[rowIn + x] + integral[rowAbove + x] + integral[rowOut + x - 1] - integral[rowAbove + x - 1];
    }
  }
  return integral;
}

function sumRect(integral: Float64Array, w: number, x1: number, y1: number, x2: number, y2: number): number {
  const stride = w + 1;
  return integral[y2 * stride + x2] - integral[y1 * stride + x2] - integral[y2 * stride + x1] + integral[y1 * stride + x1];
}

function mergeOverlapping(
  rects: { x: number; y: number; bw: number; bh: number; score: number }[]
): { x: number; y: number; bw: number; bh: number; score: number }[] {
  if (rects.length === 0) return [];
  function iou(a: typeof rects[0], b: typeof rects[0]) {
    const xi1 = Math.max(a.x, b.x);
    const yi1 = Math.max(a.y, b.y);
    const xi2 = Math.min(a.x + a.bw, b.x + b.bw);
    const yi2 = Math.min(a.y + a.bh, b.y + b.bh);
    const inter = Math.max(0, xi2 - xi1) * Math.max(0, yi2 - yi1);
    const u = a.bw * a.bh + b.bw * b.bh - inter;
    return u > 0 ? inter / u : 0;
  }
  const sorted = [...rects].sort((a, b) => b.score - a.score);
  const kept: typeof rects = [];
  for (const r of sorted) {
    let overlap = false;
    for (const k of kept) {
      if (iou(r, k) > 0.3) { overlap = true; break; }
    }
    if (!overlap) kept.push(r);
  }
  return kept;
}

export function detectPlaceholders(
  imageData: ImageData,
  origW: number,
  origH: number
): AnalysisResult {
  const w = imageData.width;
  const h = imageData.height;
  const imgArea = w * h;
  const gray = grayscale(imageData.data);
  const edges = sobelEdgeStrength(gray, w, h);

  const grayInt = buildIntegral(gray, w, h);
  const edgeInt = buildIntegral(edges, w, h);

  const candidates: { x: number; y: number; bw: number; bh: number; score: number }[] = [];
  const minDim = Math.min(w, h);

  const sizes = [0.04, 0.06, 0.08, 0.10, 0.12, 0.15, 0.18, 0.22, 0.26, 0.30, 0.35, 0.40];
  for (const sizeFrac of sizes) {
    const bw = Math.round(sizeFrac * w);
    const bh = Math.round(sizeFrac * h);
    if (bw < 10 || bh < 10) continue;
    const area = bw * bh;
    if (area < 0.005 * imgArea || area > 0.5 * imgArea) continue;

    const step = Math.max(1, Math.round(Math.min(bw, bh) * 0.15));
    for (let y = 0; y + bh <= h; y += step) {
      for (let x = 0; x + bw <= w; x += step) {
        const perimCount = 2 * (bw + bh);
        const perimEdge = (
          sumRect(edgeInt, w, x, y, x + bw, y + 1) +
          sumRect(edgeInt, w, x, y + bh - 1, x + bw, y + bh) +
          sumRect(edgeInt, w, x, y, x + 1, y + bh) +
          sumRect(edgeInt, w, x + bw - 1, y, x + bw, y + bh)
        ) / perimCount;

        const interiorCount = (bh - 2) * (bw - 2);
        if (interiorCount <= 0) continue;
        const avgEdge = sumRect(edgeInt, w, x + 1, y + 1, x + bw - 1, y + bh - 1) / interiorCount;
        const avgBright = sumRect(grayInt, w, x + 1, y + 1, x + bw - 1, y + bh - 1) / interiorCount;

        const edgeScore = Math.min(1, perimEdge / 80);
        const brightScore = Math.min(1, avgBright / 200);
        const interiorEdgeScore = Math.max(0, 1 - avgEdge / 80);

        const score = edgeScore * 0.4 + brightScore * 0.3 + interiorEdgeScore * 0.3;
        if (score > 0.45) {
          candidates.push({
            x: x * origW / w,
            y: y * origH / h,
            bw: bw * origW / w,
            bh: bh * origH / h,
            score,
          });
        }
      }
    }
  }

  const merged = mergeOverlapping(candidates);
  const top = merged.sort((a, b) => b.score - a.score).slice(0, 10);

  return {
    placeholders: top.map((c, i) => ({
      id: `placeholder_${i + 1}`,
      label: "Image Placeholder",
      type: "image",
      shape: "rectangle",
      confidence: Math.round(c.score * 100) / 100,
      rotation: 0,
      x: Math.round((c.x / origW) * 10000) / 10000,
      y: Math.round((c.y / origH) * 10000) / 10000,
      width: Math.round((c.bw / origW) * 10000) / 10000,
      height: Math.round((c.bh / origH) * 10000) / 10000,
    })),
    template_width: origW,
    template_height: origH,
  };
}
