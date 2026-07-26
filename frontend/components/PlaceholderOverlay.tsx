"use client";

import { useRef, useState, useEffect, ChangeEvent } from "react";

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

interface PlaceholderOverlayProps {
  imageUrl: string;
  placeholders: Placeholder[];
  imageWidth: number;
  imageHeight: number;
  filledImages: Record<string, string>;
  onFill: (placeholderId: string, dataUrl: string) => void;
}

export default function PlaceholderOverlay({
  imageUrl,
  placeholders,
  imageWidth,
  imageHeight,
  filledImages,
  onFill,
}: PlaceholderOverlayProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [displayWidth, setDisplayWidth] = useState(0);
  const [displayHeight, setDisplayHeight] = useState(0);
  const [pickingFor, setPickingFor] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width } = entry.contentRect;
        const aspect = imageWidth / imageHeight;
        let w = width;
        let h = w / aspect;
        if (h > window.innerHeight * 0.6) {
          h = window.innerHeight * 0.6;
          w = h * aspect;
        }
        setDisplayWidth(w);
        setDisplayHeight(h);
      }
    });
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [imageWidth, imageHeight]);

  const handlePlaceholderClick = (id: string) => {
    setPickingFor(id);
    fileInputRef.current?.click();
  };

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !pickingFor) return;
    const reader = new FileReader();
    reader.onload = () => {
      onFill(pickingFor, reader.result as string);
      setPickingFor(null);
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  };

  return (
    <div ref={containerRef} className="relative inline-block" style={{ width: displayWidth, height: displayHeight }}>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        onChange={handleFileChange}
        className="hidden"
      />

      <img
        src={imageUrl}
        alt="Template"
        className="w-full h-full object-contain"
        style={{ width: displayWidth, height: displayHeight }}
      />

      {placeholders.map((p) => {
        const left = p.x * displayWidth;
        const top = p.y * displayHeight;
        const w = p.width * displayWidth;
        const h = p.height * displayHeight;
        const filled = filledImages[p.id];

        return (
          <div key={p.id}>
            {filled && (
              <img
                src={filled}
                alt={p.label}
                className="absolute object-cover cursor-pointer"
                style={{
                  left, top, width: w, height: h,
                  borderRadius: p.shape === "circle" ? "50%" : undefined,
                }}
                onClick={() => handlePlaceholderClick(p.id)}
              />
            )}
            <div
              className={`absolute border-2 cursor-pointer transition-colors ${
                filled ? "border-transparent hover:border-white/60" : "border-blue-500 bg-blue-500/10 hover:bg-blue-500/20"
              }`}
              style={{ left, top, width: w, height: h, borderRadius: p.shape === "circle" ? "50%" : undefined }}
              onClick={() => handlePlaceholderClick(p.id)}
            >
              {!filled && (
                <div className="flex items-center justify-center w-full h-full">
                  <span className="text-blue-500 text-2xl font-bold opacity-60">+</span>
                </div>
              )}
            </div>
            <span
              className="absolute bg-blue-500 text-white text-xs px-1 py-0.5 rounded pointer-events-none whitespace-nowrap"
              style={{ left, top: top - 20 }}
            >
              {p.label} ({Math.round(p.confidence * 100)}%)
            </span>
          </div>
        );
      })}
    </div>
  );
}
