import cv2
import numpy as np
from PIL import Image

from models.schemas import Placeholder


def _pil_to_cv2(image: Image.Image) -> np.ndarray:
    arr = np.array(image)
    if arr.shape[-1] == 4:
        arr = cv2.cvtColor(arr, cv2.COLOR_RGBA2BGR)
    else:
        arr = cv2.cvtColor(arr, cv2.COLOR_RGB2BGR)
    return arr


def _iou(a, b):
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    xi1, yi1 = max(ax1, bx1), max(ay1, by1)
    xi2, yi2 = min(ax2, bx2), min(ay2, by2)
    inter = max(0, xi2 - xi1) * max(0, yi2 - yi1)
    u = (ax2 - ax1) * (ay2 - ay1) + (bx2 - bx1) * (by2 - by1) - inter
    return inter / u if u > 0 else 0


def _nms(rects, iou_thresh=0.4):
    rects = sorted(rects, key=lambda r: r[-1], reverse=True)
    keep = []
    while rects:
        best = rects.pop(0)
        keep.append(best)
        rects = [r for r in rects if _iou(best[:4], r[:4]) < iou_thresh]
    return keep


def detect_placeholders(image: Image.Image) -> list[Placeholder]:
    img = _pil_to_cv2(image)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    h, w = img.shape[:2]
    img_area = h * w
    candidates = []

    # Strategy 1: edge-based rectangle detection
    blur = cv2.GaussianBlur(gray, (5, 5), 0)
    edge = cv2.Canny(blur, 30, 100)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    closed = cv2.morphologyEx(edge, cv2.MORPH_CLOSE, kernel, iterations=2)

    contours, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    for cnt in contours:
        area = cv2.contourArea(cnt)
        if area < 0.008 * img_area or area > 0.5 * img_area:
            continue

        x, y, bw, bh = cv2.boundingRect(cnt)
        aspect = bw / bh if bh > 0 else 0
        if aspect < 0.4 or aspect > 2.5:
            continue

        rect_area = bw * bh
        fill = area / rect_area if rect_area > 0 else 0
        if fill < 0.35:
            continue

        roi = gray[max(0, y):min(h, y + bh), max(0, x):min(w, x + bw)]
        if roi.size == 0:
            continue

        mean_b = roi.mean()
        std_b = roi.std()
        if mean_b < 40 or std_b > 80:
            continue

        candidates.append((x, y, bw, bh, 0.8))

    # Strategy 2: adaptive threshold for light regions
    thresh = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 31, 5)
    inv = cv2.bitwise_not(thresh)
    kernel2 = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
    cleaned = cv2.morphologyEx(inv, cv2.MORPH_CLOSE, kernel2)

    contours2, _ = cv2.findContours(cleaned, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    for cnt in contours2:
        area = cv2.contourArea(cnt)
        if area < 0.02 * img_area or area > 0.5 * img_area:
            continue

        x, y, bw, bh = cv2.boundingRect(cnt)
        aspect = bw / bh if bh > 0 else 0
        if aspect < 0.4 or aspect > 2.5:
            continue

        rect_area = bw * bh
        fill = area / rect_area if rect_area > 0 else 0
        if fill < 0.5:
            continue

        roi = gray[max(0, y):min(h, y + bh), max(0, x):min(w, x + bw)]
        if roi.size == 0:
            continue

        mean_b = roi.mean()
        std_b = roi.std()
        if mean_b < 60 or std_b > 80:
            continue

        candidates.append((x, y, bw, bh, 0.7))

    if not candidates:
        return []

    nms_input = [(x, y, x + bw, y + bh, c) for x, y, bw, bh, c in candidates]
    kept = _nms(nms_input)

    seen = set()
    result = []
    for x, y, x2, y2, conf in kept:
        bw = x2 - x
        bh = y2 - y
        key = (round(x / w, 1), round(y / h, 1))
        if key in seen:
            continue
        seen.add(key)

        shape = "rectangle"
        label = "Image Placeholder"

        result.append(Placeholder(
            id=f"placeholder_{len(result) + 1}",
            label=label,
            type="image",
            shape=shape,
            confidence=round(min(1.0, conf), 2),
            rotation=0,
            x=round(x / w, 4),
            y=round(y / h, 4),
            width=round(bw / w, 4),
            height=round(bh / h, 4),
        ))

    return result
