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
    gray[i] = 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2];
  }
  return gray;
}

function sobelEdgeStrength(gray: Uint8Array, w: number, h: number): Float32Array {
  const edges = new Float32Array(gray.length);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx =
        -gray[i - w - 1] + gray[i - w + 1]
        - 2 * gray[i - 1] + 2 * gray[i + 1]
        - gray[i + w - 1] + gray[i + w + 1];
      const gy =
        -gray[i - w - 1] - 2 * gray[i - w] - gray[i - w + 1]
        + gray[i + w - 1] + 2 * gray[i + w] + gray[i + w + 1];
      edges[i] = Math.sqrt(gx * gx + gy * gy);
    }
  }
  return edges;
}

export function detectPlaceholders(
  imageData: ImageData,
  origW: number,
  origH: number
): AnalysisResult {
  const w = imageData.width;
  const h = imageData.height;
  const scaleX = origW / w;
  const scaleY = origH / h;
  const imgArea = w * h;
  const gray = grayscale(imageData.data);
  const edges = sobelEdgeStrength(gray, w, h);

  const candidates: { x: number; y: number; bw: number; bh: number; score: number }[] = [];
  const step = Math.max(1, Math.floor(Math.min(w, h) / 100));
  const minArea = 0.01 * imgArea;
  const maxArea = 0.5 * imgArea;

  for (let y = 0; y < h - step; y += step) {
    for (let x = 0; x < w - step; x += step) {
      let maxBw = 0, maxBh = 0;
      for (let bw = step; x + bw <= w && bw < w * 0.5; bw += step) {
        for (let bh = step; y + bh <= h && bh < h * 0.5; bh += step) {
          const area = bw * bh;
          if (area < minArea || area > maxArea) continue;

          const aspect = bw / bh;
          if (aspect < 0.4 || aspect > 2.5) continue;

          let edgeSum = 0, edgeCount = 0;
          for (let py = y; py < y + bh; py++) {
            for (let px = x; px < x + bw; px++) {
              edgeSum += edges[py * w + px];
              edgeCount++;
            }
          }
          const avgEdge = edgeSum / edgeCount;

          let interiorSum = 0, interiorCount = 0;
          for (let py = y + step; py < y + bh - step; py++) {
            for (let px = x + step; px < x + bw - step; px++) {
              interiorSum += gray[py * w + px];
              interiorCount++;
            }
          }
          const avgBright = interiorCount > 0 ? interiorSum / interiorCount : 0;

          let perimSum = 0, perimCount = 0;
          for (let px = x; px < x + bw; px++) {
            perimSum += edges[y * w + px] + edges[(y + bh - 1) * w + px];
            perimCount += 2;
          }
          for (let py = y; py < y + bh; py++) {
            perimSum += edges[py * w + x] + edges[py * w + (x + bw - 1)];
            perimCount += 2;
          }
          const perimEdge = perimSum / perimCount;

          const edgeScore = Math.min(1, perimEdge / 60);
          const brightScore = Math.min(1, avgBright / 200);
          const interiorEdgeScore = Math.max(0, 1 - avgEdge / 80);

          const score = edgeScore * 0.4 + brightScore * 0.3 + interiorEdgeScore * 0.3;
          if (score > 0.5 && bw > bh * 0.5 && bh > bw * 0.5) {
            if (bw > maxBw || bh > maxBh) {
              maxBw = bw;
              maxBh = bh;
            }
          }
        }
      }
      if (maxBw > 0) {
        candidates.push({
          x: x * scaleX,
          y: y * scaleY,
          bw: maxBw * scaleX,
          bh: maxBh * scaleY,
          score: 1,
        });
      }
    }
  }

  const merged = mergeOverlapping(candidates);
  const sorted = merged.sort((a, b) => b.score - a.score);
  const top = sorted.slice(0, 8);

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
      if (iou(r, k) > 0.3) {
        overlap = true;
        break;
      }
    }
    if (!overlap) kept.push(r);
  }

  return kept;
}
