"use client";

import { useState } from "react";
import ImageUploader from "@/components/ImageUploader";
import PlaceholderOverlay from "@/components/PlaceholderOverlay";

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

export default function Home() {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filledImages, setFilledImages] = useState<Record<string, string>>({});

  const handleImageSelect = async (file: File) => {
    setError(null);
    setAnalysis(null);
    setFilledImages({});
    setImageUrl(URL.createObjectURL(file));

    setLoading(true);
    try {
      const formData = new FormData();
      formData.append("image", file);

      const res = await fetch("http://localhost:8000/api/analyze-template", {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const detail = (await res.json()).detail ?? "Analysis failed";
        throw new Error(detail);
      }

      const data: AnalysisResult = await res.json();
      setAnalysis(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  };

  const handleFillPlaceholder = (id: string, dataUrl: string) => {
    setFilledImages((prev) => ({ ...prev, [id]: dataUrl }));
  };

  const handleDownload = async () => {
    if (!analysis || !imageUrl) return;

    const canvas = document.createElement("canvas");
    canvas.width = analysis.template_width;
    canvas.height = analysis.template_height;
    const ctx = canvas.getContext("2d")!;

    const template = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = imageUrl;
    });

    ctx.drawImage(template, 0, 0);

    const placeholders = analysis.placeholders;

    for (const p of placeholders) {
      const dataUrl = filledImages[p.id];
      if (!dataUrl) continue;

      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = reject;
        i.src = dataUrl;
      });

      const x = p.x * analysis.template_width;
      const y = p.y * analysis.template_height;
      const w = p.width * analysis.template_width;
      const h = p.height * analysis.template_height;

      ctx.save();
      if (p.shape === "circle") {
        ctx.beginPath();
        ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
        ctx.clip();
      }
      ctx.drawImage(img, x, y, w, h);
      ctx.restore();
    }

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "template-edited.png";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex flex-col flex-1 items-center gap-8 p-8">
      <h1 className="text-2xl font-bold">AI Template Editor</h1>

      <div className="w-full max-w-2xl">
        <ImageUploader onImageSelect={handleImageSelect} disabled={loading} />
      </div>

      {loading && <p className="text-gray-500">Analyzing template with AI...</p>}

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-4 w-full max-w-2xl">
          {error}
        </div>
      )}

      {analysis && imageUrl && analysis.placeholders.length === 0 && (
        <div className="bg-amber-50 border border-amber-200 text-amber-700 rounded-lg p-4 w-full max-w-2xl text-center">
          No image placeholders detected in this template. Try a different design with photo frames, profile pictures, or image boxes.
        </div>
      )}

      {analysis && imageUrl && analysis.placeholders.length > 0 && (
        <div className="flex flex-col items-center gap-6 w-full">
          <PlaceholderOverlay
            imageUrl={imageUrl}
            placeholders={analysis.placeholders}
            imageWidth={analysis.template_width}
            imageHeight={analysis.template_height}
            filledImages={filledImages}
            onFill={handleFillPlaceholder}
          />

          {Object.keys(filledImages).length > 0 && (
            <button
              onClick={handleDownload}
              className="bg-green-600 hover:bg-green-700 text-white font-medium py-2 px-6 rounded-lg transition-colors"
            >
              Download Edited Template
            </button>
          )}

          <details className="w-full max-w-2xl">
            <summary className="cursor-pointer text-sm text-gray-500 font-medium">
              Raw JSON Response
            </summary>
            <pre className="mt-2 bg-gray-100 rounded-lg p-4 text-xs overflow-x-auto">
              {JSON.stringify(analysis, null, 2)}
            </pre>
          </details>
        </div>
      )}
    </div>
  );
}
