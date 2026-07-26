import os
from fastapi import APIRouter, UploadFile, File, HTTPException
from PIL import Image
import io

from models.schemas import AnalysisResponse
from services.gemini_service import analyze_template as analyze_gemini
from detectors.opencv_detector import detect_placeholders as analyze_opencv

router = APIRouter()

MAX_FILE_SIZE = 10 * 1024 * 1024
ALLOWED_TYPES = {"image/jpeg", "image/png", "image/webp"}

DETECTOR = os.environ.get("DETECTOR", "opencv").lower()


def _analyze(image: Image.Image, w: int, h: int):
    if DETECTOR == "gemini":
        return analyze_gemini(image, w, h)
    return analyze_opencv(image)


@router.post("/api/analyze-template", response_model=AnalysisResponse)
async def analyze_template_endpoint(image: UploadFile = File(...)):
    if image.content_type not in ALLOWED_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file type '{image.content_type}'. Allowed: JPEG, PNG, WebP",
        )

    contents = await image.read()
    if len(contents) > MAX_FILE_SIZE:
        raise HTTPException(
            status_code=400,
            detail=f"File too large. Maximum size is {MAX_FILE_SIZE // (1024 * 1024)} MB",
        )

    try:
        pil_image = Image.open(io.BytesIO(contents))
    except Exception:
        raise HTTPException(status_code=400, detail="Could not decode image file. Upload a valid JPEG, PNG, or WebP image.")

    original_width, original_height = pil_image.size

    try:
        placeholders = _analyze(pil_image, original_width, original_height)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Analysis failed: {str(e)}")

    return AnalysisResponse(
        placeholders=placeholders,
        template_width=original_width,
        template_height=original_height,
    )
