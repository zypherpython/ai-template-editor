import cv2
import numpy as np
from PIL import Image
import io

from models.schemas import Placeholder


def _pil_to_cv2(image: Image.Image) -> np.ndarray:
    arr = np.array(image)
    if arr.shape[-1] == 4:
        arr = cv2.cvtColor(arr, cv2.COLOR_RGBA2BGR)
    else:
        arr = cv2.cvtColor(arr, cv2.COLOR_RGB2BGR)
    return arr


def detect_rectangles(gray: np.ndarray, img_area: int) -> list[Placeholder]:
    h, w = gray.shape
    placeholders = []

    edges = cv2.Canny(gray, 30, 100)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    dilated = cv2.dilate(edges, kernel, iterations=1)

    contours, _ = cv2.findContours(dilated, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    for i, cnt in enumerate(contours):
        epsilon = 0.02 * cv2.arcLength(cnt, True)
        approx = cv2.approxPolyDP(cnt, epsilon, True)

        if len(approx) != 4:
            continue

        area = cv2.contourArea(cnt)
        if area < 0.005 * img_area or area > 0.6 * img_area:
            continue

        x, y, bw, bh = cv2.boundingRect(cnt)

        aspect = bw / bh if bh > 0 else 0
        if aspect < 0.3 or aspect > 3.0:
            continue

        rect_area = bw * bh
        fill_ratio = area / rect_area if rect_area > 0 else 0
        if fill_ratio < 0.3:
            continue

        placeholders.append(Placeholder(
            id=f"placeholder_{len(placeholders) + 1}",
            label="Image Placeholder",
            type="image",
            shape="rectangle",
            confidence=min(1.0, fill_ratio),
            rotation=0,
            x=round(x / w, 4),
            y=round(y / h, 4),
            width=round(bw / w, 4),
            height=round(bh / h, 4),
        ))

    return placeholders


def detect_circles(gray: np.ndarray, img_area: int) -> list[Placeholder]:
    h, w = gray.shape
    placeholders = []

    blurred = cv2.medianBlur(gray, 5)
    circles = cv2.HoughCircles(
        blurred, cv2.HOUGH_GRADIENT, dp=1.2, minDist=int(h * 0.1),
        param1=50, param2=30, minRadius=int(min(h, w) * 0.03),
        maxRadius=int(min(h, w) * 0.4)
    )

    if circles is not None:
        circles = np.round(circles[0, :]).astype(int)
        for i, (cx, cy, r) in enumerate(circles):
            circle_area = np.pi * r * r
            if circle_area < 0.005 * img_area or circle_area > 0.5 * img_area:
                continue

            x = max(0, cx - r)
            y = max(0, cy - r)
            bw = min(2 * r, w - x)
            bh = min(2 * r, h - y)

            placeholders.append(Placeholder(
                id=f"placeholder_{len(placeholders) + 1}",
                label="Profile Picture",
                type="image",
                shape="circle",
                confidence=0.85,
                rotation=0,
                x=round(x / w, 4),
                y=round(y / h, 4),
                width=round(bw / w, 4),
                height=round(bh / h, 4),
            ))

    return placeholders


def detect_placeholders(image: Image.Image) -> list[Placeholder]:
    img = _pil_to_cv2(image)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    img_area = img.shape[0] * img.shape[1]

    rects = detect_rectangles(gray, img_area)
    circles = detect_circles(gray, img_area)

    seen = set()
    combined = []
    for p in rects + circles:
        key = (round(p.x, 2), round(p.y, 2), round(p.width, 2), round(p.height, 2))
        if key not in seen:
            seen.add(key)
            combined.append(p)

    return combined
