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

function sobelSeparated(gray: Uint8Array, w: number, h: number): { gx: Float32Array; gy: Float32Array; mag: Float32Array } {
  const gx = new Float32Array(gray.length);
  const gy = new Float32Array(gray.length);
  const mag = new Float32Array(gray.length);
  for (let y = 1; y < h - 1; y++) {
    const ra = (y - 1) * w, r = y * w, rb = (y + 1) * w;
    for (let x = 1; x < w - 1; x++) {
      gx[r + x] =
        -gray[ra + x - 1] + gray[ra + x + 1]
        - 2 * gray[r + x - 1] + 2 * gray[r + x + 1]
        - gray[rb + x - 1] + gray[rb + x + 1];
      gy[r + x] =
        -gray[ra + x - 1] - 2 * gray[ra + x] - gray[ra + x + 1]
        + gray[rb + x - 1] + 2 * gray[rb + x] + gray[rb + x + 1];
      mag[r + x] = Math.sqrt(gx[r + x] * gx[r + x] + gy[r + x] * gy[r + x]);
    }
  }
  return { gx, gy, mag };
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

function findLines(
  projection: Float32Array,
  length: number,
  threshold: number,
  minGap: number,
  minLength: number
): { start: number; end: number; strength: number }[] {
  const lines: { start: number; end: number; strength: number }[] = [];
  let inLine = false;
  let start = 0;
  let maxVal = 0;
  for (let i = 0; i < length; i++) {
    if (projection[i] >= threshold) {
      if (!inLine) { start = i; maxVal = 0; inLine = true; }
      if (projection[i] > maxVal) maxVal = projection[i];
    } else if (inLine) {
      if (i - start >= minLength) {
        lines.push({ start, end: i - 1, strength: maxVal });
      }
      inLine = false;
    }
  }
  if (inLine && length - start >= minLength) {
    lines.push({ start, end: length - 1, strength: maxVal });
  }

  if (lines.length < 2) return lines;

  const merged: typeof lines = [];
  let cur = lines[0];
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].start - cur.end <= minGap) {
      cur = { start: cur.start, end: lines[i].end, strength: Math.max(cur.strength, lines[i].strength) };
    } else {
      merged.push(cur);
      cur = lines[i];
    }
  }
  merged.push(cur);
  return merged;
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
  const { gx, gy, mag } = sobelSeparated(gray, w, h);

  const edgeInt = buildIntegral(mag, w, h);
  const grayInt = buildIntegral(gray, w, h);

  const edgeMean = sumRect(edgeInt, w, 0, 0, w, h) / imgArea;

  const hThreshold = edgeMean * 1.5 + 5;
  const vThreshold = edgeMean * 1.5 + 5;

  const horizProjection = new Float32Array(h);
  const vertProjection = new Float32Array(w);
  for (let y = 0; y < h; y++) {
    let sum = 0;
    for (let x = 0; x < w; x++) sum += gy[y * w + x];
    horizProjection[y] = sum / w;
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = 0; y < h; y++) sum += gx[y * w + x];
    vertProjection[x] = sum / h;
  }

  const minLineLen = Math.round(Math.min(w, h) * 0.04);
  const gap = Math.round(Math.min(w, h) * 0.02);

  const hLines = findLines(horizProjection, h, hThreshold, gap, minLineLen);
  const vLines = findLines(vertProjection, w, vThreshold, gap, minLineLen);

  const candidates: { x: number; y: number; bw: number; bh: number; score: number }[] = [];

  for (let hi = 0; hi < hLines.length; hi++) {
    for (let hj = hi + 1; hj < hLines.length; hj++) {
      for (let vi = 0; vi < vLines.length; vi++) {
        for (let vj = vi + 1; vj < vLines.length; vj++) {
          const y1 = hLines[hi].start, y2 = hLines[hj].end;
          const x1 = vLines[vi].start, x2 = vLines[vj].end;

          let bh = y2 - y1 + 1;
          let bw = x2 - x1 + 1;
          if (bh < 5 || bw < 5) continue;
          const area = bw * bh;
          if (area < 0.005 * imgArea || area > 0.7 * imgArea) continue;
          const aspect = bw / bh;
          if (aspect < 0.3 || aspect > 3.5) continue;

          const perimCount = 2 * (bw + bh);
          const perimEdge = (
            sumRect(edgeInt, w, x1, y1, x2 + 1, y1 + 1) +
            sumRect(edgeInt, w, x1, y2, x2 + 1, y2 + 1) +
            sumRect(edgeInt, w, x1, y1, x1 + 1, y2 + 1) +
            sumRect(edgeInt, w, x2, y1, x2 + 1, y2 + 1)
          ) / perimCount;

          const interiorCount = Math.max(1, (bh - 2) * (bw - 2));
          const avgEdge = sumRect(edgeInt, w, x1 + 1, y1 + 1, x2, y2) / interiorCount;
          const avgBright = sumRect(grayInt, w, x1 + 1, y1 + 1, x2, y2) / interiorCount;

          const borderOutsideCount = 2 * ((bw + 4) + (bh + 4));
          let borderOutside = 0;
          const ox1 = Math.max(0, x1 - 2), oy1 = Math.max(0, y1 - 2);
          const ox2 = Math.min(w, x2 + 3), oy2 = Math.min(h, y2 + 3);
          const outW = ox2 - ox1, outH = oy2 - oy1;
          if (outW > bw + 2 && outH > bh + 2) {
            const outArea = outW * outH;
            const innerArea = (Math.min(x2, ox2 - 1) - Math.max(x1, ox1) + 1) * (Math.min(y2, oy2 - 1) - Math.max(y1, oy1) + 1);
            if (outArea > innerArea) {
              const outSum = sumRect(grayInt, w, ox1, oy1, ox2, oy2);
              const innerSum = sumRect(grayInt, w, Math.max(x1, ox1), Math.max(y1, oy1), Math.min(x2, ox2 - 1) + 1, Math.min(y2, oy2 - 1) + 1);
              borderOutside = (outSum - innerSum) / (outArea - innerArea);
            }
          }
          const borderContrast = borderOutside > 0 ? Math.abs(avgBright - borderOutside) / Math.max(avgBright, borderOutside, 1) : 0;

          const hEdge = hLines[hi].strength > hLines[hj].strength ? hLines[hi].strength : hLines[hj].strength;
          const vEdge = vLines[vi].strength > vLines[vj].strength ? vLines[vi].strength : vLines[vj].strength;

          const edgeScore = Math.min(1, perimEdge / 100) * Math.min(1, hEdge / 40) * Math.min(1, vEdge / 40);
          const brightScore = avgBright > 100 ? Math.min(1, avgBright / 220) : 0;
          const interiorScore = Math.max(0, 1 - avgEdge / 100);
          const contrastScore = Math.min(1, borderContrast * 4);

          const score = edgeScore * 0.30 + brightScore * 0.25 + interiorScore * 0.20 + contrastScore * 0.25;
          if (score > 0.30) {
            candidates.push({
              x: x1 * origW / w, y: y1 * origH / h,
              bw: bw * origW / w, bh: bh * origH / h,
              score,
            });
          }
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
