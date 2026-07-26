import json
import os
from google import genai
from google.genai import types
from PIL import Image
import io

from models.schemas import Placeholder


PROMPT_PATH = os.path.join(os.path.dirname(__file__), "..", "prompts", "placeholder_prompt.txt")
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
        raise ValueError(f"Image too small ({original_width}x{original_height}). Minimum is {MIN_DIMENSION}x{MIN_DIMENSION} pixels")

    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise ValueError("GEMINI_API_KEY environment variable is not set")

    client = genai.Client(api_key=api_key)

    prompt = _load_prompt()
    image_bytes = _image_to_bytes(image)

    try:
        response = client.models.generate_content(
            model="gemini-2.0-flash",
            contents=[
                prompt,
                types.Part.from_bytes(data=image_bytes, mime_type="image/png"),
            ],
        )
    except Exception as e:
        raise RuntimeError(f"Gemini API request failed: {str(e)}")

    if not response.text:
        raise RuntimeError("Gemini returned an empty response (request may have been blocked)")

    raw = response.text.strip()
    raw = raw.removeprefix("```json").removeprefix("```").removeprefix("```json\n").removesuffix("```").strip()

    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"Gemini returned invalid JSON: {e}. Raw response: {raw[:500]}")

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
