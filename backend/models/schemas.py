from pydantic import BaseModel, Field


class Placeholder(BaseModel):
    id: str
    label: str
    type: str
    shape: str
    confidence: float = Field(ge=0.0, le=1.0)
    rotation: float
    x: float = Field(ge=0.0, le=1.0)
    y: float = Field(ge=0.0, le=1.0)
    width: float = Field(ge=0.0, le=1.0)
    height: float = Field(ge=0.0, le=1.0)


class AnalysisResponse(BaseModel):
    placeholders: list[Placeholder]
    template_width: int
    template_height: int
