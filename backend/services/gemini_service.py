import json
import os
import subprocess
import sys
import tempfile
from PIL import Image
import io

from models.schemas import Placeholder


PROMPT_PATH = os.path.join(os.path.dirname(__file__), "..", "prompts", "placeholder_prompt.txt")
BRIDGE_PATH = os.path.join(os.path.dirname(__file__), "gemini_bridge.py")
MIN_DIMENSION = 100


def _load_prompt() -> str:
    with open(PROMPT_PATH) as f:
        return f.read()


def _image_to_bytes(image: Image.Image) -> bytes:
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return buf.getvalue()


def analyze_template(image: Image.Image, original_width: int, original_height: int) -> list[Placeholder]:
    if original_width < MIN_DIMENSION or original_height < MIN_DIMENSION:
        raise ValueError(
            f"Image too small ({original_width}x{original_height}). Minimum is {MIN_DIMENSION}x{MIN_DIMENSION} pixels"
        )

    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise ValueError("GEMINI_API_KEY environment variable is not set")

    prompt = _load_prompt()
    image_bytes = _image_to_bytes(image)

    with tempfile.NamedTemporaryFile(mode="w", suffix=".txt", delete=False) as pf:
        pf.write(prompt)
        prompt_file = pf.name
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as imgf:
        imgf.write(image_bytes)
        image_file = imgf.name

    try:
        result = subprocess.run(
            [sys.executable, BRIDGE_PATH, prompt_file, image_file],
            capture_output=True, text=True, timeout=180,
            env={**os.environ}
        )

        if result.returncode != 0:
            raise RuntimeError(result.stderr.strip() or "Gemini bridge exited with an error")

        raw = result.stdout.strip()

    except subprocess.TimeoutExpired:
        raise RuntimeError("Gemini analysis timed out after 180 seconds")
    finally:
        os.unlink(prompt_file)
        os.unlink(image_file)

    raw = raw.removeprefix("```json").removeprefix("```").removesuffix("```").strip()

    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"Gemini returned invalid JSON: {e}. Raw: {raw[:500]}")

    placeholders_data = data.get("placeholders", [])
    if not isinstance(placeholders_data, list):
        raise RuntimeError("Gemini response 'placeholders' is not an array")

    placeholders = []
    for i, item in enumerate(placeholders_data):
        missing = [k for k in ("x", "y", "width", "height") if k not in item]
        if missing:
            raise RuntimeError(f"Placeholder {i+1} missing required fields: {', '.join(missing)}")

        try:
            placeholders.append(
                Placeholder(
                    id=item.get("id", f"placeholder_{i + 1}"),
                    label=item.get("label", "Image Placeholder"),
                    type=item.get("type", "image"),
                    shape=item.get("shape", "rectangle"),
                    confidence=float(item.get("confidence", 0.5)),
                    rotation=float(item.get("rotation", 0)),
                    x=float(item["x"]),
                    y=float(item["y"]),
                    width=float(item["width"]),
                    height=float(item["height"]),
                )
            )
        except (ValueError, TypeError) as e:
            raise RuntimeError(f"Invalid value in placeholder {i+1}: {e}")

    return placeholders
