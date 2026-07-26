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

function buildIntegralU8(data: Uint8Array, w: number, h: number): Float64Array {
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

function buildIntegralF32(data: Float32Array, w: number, h: number): Float64Array {
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

function rectOverlap(a: { x: number; y: number; bw: number; bh: number }, b: { x: number; y: number; bw: number; bh: number }): number {
  const xi1 = Math.max(a.x, b.x);
  const yi1 = Math.max(a.y, b.y);
  const xi2 = Math.min(a.x + a.bw, b.x + b.bw);
  const yi2 = Math.min(a.y + a.bh, b.y + b.bh);
  const inter = Math.max(0, xi2 - xi1) * Math.max(0, yi2 - yi1);
  const u = a.bw * a.bh + b.bw * b.bh - inter;
  return u > 0 ? inter / u : 0;
}

function nms(rects: { x: number; y: number; bw: number; bh: number; score: number }[], iouThresh: number = 0.35): typeof rects {
  if (rects.length === 0) return [];
  const sorted = [...rects].sort((a, b) => b.score - a.score);
  const kept: typeof rects = [];
  for (const r of sorted) {
    let overlap = false;
    for (const k of kept) {
      if (rectOverlap(r, k) > iouThresh) { overlap = true; break; }
    }
    if (!overlap) kept.push(r);
  }
  return kept;
}

function findLines(projection: Float32Array, length: number, threshold: number, minGap: number, minLength: number): { start: number; end: number; strength: number }[] {
  const lines: { start: number; end: number; strength: number }[] = [];
  let inLine = false, start = 0, maxVal = 0;
  for (let i = 0; i < length; i++) {
    if (projection[i] >= threshold) {
      if (!inLine) { start = i; maxVal = 0; inLine = true; }
      if (projection[i] > maxVal) maxVal = projection[i];
    } else if (inLine) {
      if (i - start >= minLength) lines.push({ start, end: i - 1, strength: maxVal });
      inLine = false;
    }
  }
  if (inLine && length - start >= minLength) lines.push({ start, end: length - 1, strength: maxVal });
  if (lines.length < 2) return lines;
  const merged: typeof lines = [];
  let cur = lines[0];
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].start - cur.end <= minGap) {
      cur = { start: cur.start, end: lines[i].end, strength: Math.max(cur.strength, lines[i].strength) };
    } else { merged.push(cur); cur = lines[i]; }
  }
  merged.push(cur);
  return merged;
}

function detectByLines(
  gx: Float32Array, gy: Float32Array, edgeInt: Float64Array, grayInt: Float64Array,
  w: number, h: number, origW: number, origH: number, imgArea: number
): { x: number; y: number; bw: number; bh: number; score: number }[] {
  const edgeMean = sumRect(edgeInt, w, 0, 0, w, h) / imgArea;
  const threshold = edgeMean * 1.2 + 3;
  const horizontalProjection = new Float32Array(h);
  const verticalProjection = new Float32Array(w);
  for (let y = 0; y < h; y++) {
    let sum = 0;
    for (let x = 0; x < w; x++) sum += gy[y * w + x];
    horizontalProjection[y] = sum / w;
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = 0; y < h; y++) sum += gx[y * w + x];
    verticalProjection[x] = sum / h;
  }
  const minLineLen = Math.round(Math.min(w, h) * 0.03);
  const gap = Math.round(Math.min(w, h) * 0.015);
  const hLines = findLines(horizontalProjection, h, threshold, gap, minLineLen);
  const vLines = findLines(verticalProjection, w, threshold, gap, minLineLen);
  const candidates: { x: number; y: number; bw: number; bh: number; score: number }[] = [];
  for (let hi = 0; hi < hLines.length; hi++) {
    for (let hj = hi + 1; hj < hLines.length; hj++) {
      for (let vi = 0; vi < vLines.length; vi++) {
        for (let vj = vi + 1; vj < vLines.length; vj++) {
          const y1 = hLines[hi].start, y2 = hLines[hj].end;
          const x1 = vLines[vi].start, x2 = vLines[vj].end;
          let bh = y2 - y1 + 1, bw = x2 - x1 + 1;
          if (bh < 5 || bw < 5) continue;
          const area = bw * bh;
          if (area < 0.003 * imgArea || area > 0.7 * imgArea) continue;
          const aspect = bw / bh;
          if (aspect < 0.3 || aspect > 4) continue;
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
          const ox1 = Math.max(0, x1 - 3), oy1 = Math.max(0, y1 - 3);
          const ox2 = Math.min(w, x2 + 4), oy2 = Math.min(h, y2 + 4);
          let borderContrast = 0;
          if ((ox2 - ox1) > bw + 2 && (oy2 - oy1) > bh + 2) {
            const outArea = (ox2 - ox1) * (oy2 - oy1);
            const innerArea = bw * bh;
            if (outArea > innerArea) {
              const outSum = sumRect(grayInt, w, ox1, oy1, ox2, oy2);
              const innerSum = sumRect(grayInt, w, x1, y1, x2 + 1, y2 + 1);
              const bgBright = (outSum - innerSum) / (outArea - innerArea);
              borderContrast = bgBright > 0 ? Math.abs(avgBright - bgBright) / Math.max(avgBright, bgBright, 1) : 0;
            }
          }
          const hEdge = Math.max(hLines[hi].strength, hLines[hj].strength);
          const vEdge = Math.max(vLines[vi].strength, vLines[vj].strength);
          const lineScore = Math.min(1, hEdge / 30) * Math.min(1, vEdge / 30);
          const edgeScore = Math.min(1, perimEdge / 80);
          const interiorEdgePenalty = Math.max(0, 1 - avgEdge / 120);
          const contrastScore = Math.min(1, borderContrast * 3);
          const score = lineScore * 0.25 + edgeScore * 0.25 + interiorEdgePenalty * 0.20 + contrastScore * 0.30;
          if (score > 0.20) {
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
  return candidates;
}

function detectByContent(
  data: Uint8ClampedArray, edgeInt: Float64Array,
  w: number, h: number, origW: number, origH: number, imgArea: number
): { x: number; y: number; bw: number; bh: number; score: number }[] {
  const channels = [
    { sum: new Float64Array((w + 1) * (h + 1)), sumSq: new Float64Array((w + 1) * (h + 1)) },
    { sum: new Float64Array((w + 1) * (h + 1)), sumSq: new Float64Array((w + 1) * (h + 1)) },
    { sum: new Float64Array((w + 1) * (h + 1)), sumSq: new Float64Array((w + 1) * (h + 1)) },
  ];
  const stride = w + 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const idx = (y + 1) * stride + (x + 1);
      const above = y * stride + (x + 1);
      const left = (y + 1) * stride + x;
      const diag = y * stride + x;
      for (let c = 0; c < 3; c++) {
        const val = data[i + c];
        channels[c].sum[idx] = val + channels[c].sum[above] + channels[c].sum[left] - channels[c].sum[diag];
        channels[c].sumSq[idx] = val * val + channels[c].sumSq[above] + channels[c].sumSq[left] - channels[c].sumSq[diag];
      }
    }
  }
  function varRect(x1: number, y1: number, x2: number, y2: number): number {
    const area = Math.max(1, (x2 - x1) * (y2 - y1));
    let totalVar = 0;
    for (let c = 0; c < 3; c++) {
      const s = channels[c].sum[y2 * stride + x2] - channels[c].sum[y1 * stride + x2] - channels[c].sum[y2 * stride + x1] + channels[c].sum[y1 * stride + x1];
      const sq = channels[c].sumSq[y2 * stride + x2] - channels[c].sumSq[y1 * stride + x2] - channels[c].sumSq[y2 * stride + x1] + channels[c].sumSq[y1 * stride + x1];
      const mean = s / area;
      totalVar += sq / area - mean * mean;
    }
    return totalVar / 3;
  }

  const cellW = Math.max(8, Math.round(w * 0.04));
  const cellH = Math.max(8, Math.round(h * 0.04));
  const cols = Math.floor(w / cellW);
  const rows = Math.floor(h / cellH);
  const scores: number[][] = [];

  for (let r = 0; r < rows; r++) {
    scores[r] = [];
    for (let c = 0; c < cols; c++) {
      const x1 = c * cellW, y1 = r * cellH, x2 = Math.min(w, x1 + cellW), y2 = Math.min(h, y1 + cellH);
      const variance = varRect(x1, y1, x2, y2);
      const edgeDensity = sumRect(edgeInt, w, x1, y1, x2, y2) / ((x2 - x1) * (y2 - y1));
      scores[r][c] = Math.min(1, variance / 2000) * Math.min(1, edgeDensity / 60);
    }
  }

  const thresh = 0.08;
  const visited = new Uint8Array(rows * cols);
  const clusters: { x1: number; y1: number; x2: number; y2: number }[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (visited[r * cols + c] || scores[r][c] < thresh) continue;
      let minR = r, maxR = r, minC = c, maxC = c;
      const stack = [[r, c]];
      visited[r * cols + c] = 1;
      while (stack.length > 0) {
        const [cr, cc] = stack.pop()!;
        minR = Math.min(minR, cr); maxR = Math.max(maxR, cr);
        minC = Math.min(minC, cc); maxC = Math.max(maxC, cc);
        for (const [dr, dc] of [[-1,0],[1,0],[0,-1],[0,1]]) {
          const nr = cr + dr, nc = cc + dc;
          if (nr >= 0 && nr < rows && nc >= 0 && nc < cols && !visited[nr * cols + nc] && scores[nr][nc] >= thresh) {
            visited[nr * cols + nc] = 1;
            stack.push([nr, nc]);
          }
        }
      }
      clusters.push({
        x1: minC * cellW, y1: minR * cellH,
        x2: Math.min(w, (maxC + 1) * cellW), y2: Math.min(h, (maxR + 1) * cellH),
      });
    }
  }

  const candidates: { x: number; y: number; bw: number; bh: number; score: number }[] = [];
  for (const cl of clusters) {
    const bw = cl.x2 - cl.x1, bh = cl.y2 - cl.y1;
    const area = bw * bh;
    if (area < 0.003 * imgArea || area > 0.7 * imgArea) continue;
    const aspect = bw / bh;
    if (aspect < 0.3 || aspect > 4) continue;
    const avgScore = scores.map((row, r) => row.map((s, c) => {
      const cx = c * cellW, cy = r * cellH;
      if (cx >= cl.x1 && cx < cl.x2 && cy >= cl.y1 && cy < cl.y2) return s;
      return 0;
    }).reduce((a, b) => a + b, 0)).reduce((a, b) => a + b, 0);
    const count = Math.max(1, ((cl.x2 - cl.x1) / cellW) * ((cl.y2 - cl.y1) / cellH));
    const score = Math.min(1, avgScore / count * 3);
    if (score > 0.15) {
      candidates.push({
        x: cl.x1 * origW / w, y: cl.y1 * origH / h,
        bw: bw * origW / w, bh: bh * origH / h,
        score,
      });
    }
  }
  return candidates;
}

export function detectPlaceholders(imageData: ImageData, origW: number, origH: number): AnalysisResult {
  const w = imageData.width, h = imageData.height;
  const imgArea = w * h;
  const data = imageData.data;
  const gray = grayscale(data);
  const { gx, gy, mag } = sobelSeparated(gray, w, h);
  const edgeInt = buildIntegralF32(mag, w, h);
  const grayInt = buildIntegralU8(gray, w, h);

  const lineCandidates = detectByLines(gx, gy, edgeInt, grayInt, w, h, origW, origH, imgArea);
  const contentCandidates = detectByContent(data, edgeInt, w, h, origW, origH, imgArea);

  const all = [...lineCandidates, ...contentCandidates];
  const merged = nms(all, 0.35).sort((a, b) => b.score - a.score).slice(0, 12);

  return {
    placeholders: merged.map((c, i) => ({
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
