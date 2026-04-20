"use client";

import { useEffect, useRef, useState } from "react";
import * as d3 from "d3-contour";

type UploadedImage = {
  url: string;
  file: File;
};

const BOX_SIZE = 300;

export default function PrototypeContourPage() {
  const [uploadedImage, setUploadedImage] = useState<UploadedImage | null>(
    null,
  );
  const [threshold, setThreshold] = useState(0.5);

  const imageCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const outlineCanvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!uploadedImage) return;

    const img = new Image();
    img.onload = () => {
      const imageCanvas = imageCanvasRef.current;
      const outlineCanvas = outlineCanvasRef.current;
      if (!imageCanvas || !outlineCanvas) return;

      const iw = img.width;
      const ih = img.height;
      const scale = Math.min(BOX_SIZE / iw, BOX_SIZE / ih);
      const drawW = iw * scale;
      const drawH = ih * scale;
      const offsetX = (BOX_SIZE - drawW) / 2;
      const offsetY = (BOX_SIZE - drawH) / 2;

      const imageCtx = imageCanvas.getContext("2d");
      const outlineCtx = outlineCanvas.getContext("2d");
      if (!imageCtx || !outlineCtx) return;

      imageCtx.clearRect(0, 0, BOX_SIZE, BOX_SIZE);
      outlineCtx.clearRect(0, 0, BOX_SIZE, BOX_SIZE);

      imageCtx.drawImage(img, offsetX, offsetY, drawW, drawH);

      const imageData = imageCtx.getImageData(0, 0, BOX_SIZE, BOX_SIZE);
      const values = new Float32Array(BOX_SIZE * BOX_SIZE);

      for (let y = 0; y < BOX_SIZE; y++) {
        for (let x = 0; x < BOX_SIZE; x++) {
          const idx = (y * BOX_SIZE + x) * 4;
          const r = imageData.data[idx];
          const g = imageData.data[idx + 1];
          const b = imageData.data[idx + 2];
          const gray = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
          values[y * BOX_SIZE + x] = 1 - gray;
        }
      }

      const contours = d3
        .contours()
        .size([BOX_SIZE, BOX_SIZE])
        .thresholds([threshold])(Array.from(values));

      outlineCtx.clearRect(0, 0, BOX_SIZE, BOX_SIZE);
      outlineCtx.strokeStyle = "#ffffff";
      outlineCtx.lineWidth = 2;

      const path = d3.contourDensity;

      const projection = (p: [number, number]) => p;

      contours.forEach((contour) => {
        contour.coordinates.forEach((multi) => {
          multi.forEach((ring) => {
            outlineCtx.beginPath();
            ring.forEach(([x, y], idx) => {
              const [px, py] = projection([x, y]);
              if (idx === 0) {
                outlineCtx.moveTo(px, py);
              } else {
                outlineCtx.lineTo(px, py);
              }
            });
            outlineCtx.closePath();
            outlineCtx.stroke();
          });
        });
      });
    };
    img.src = uploadedImage.url;
  }, [uploadedImage, threshold]);

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    setUploadedImage({ url, file });
  };

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-neutral-950 px-4 py-8 text-neutral-100">
      <div className="mb-6 text-center">
        <h1 className="text-2xl font-semibold">PaceCasso Prototype</h1>
        <p className="mt-2 text-sm text-neutral-400">
          Upload the provided heart image to see a simple black outline extracted from it.
        </p>
      </div>

      <div className="mb-4 flex flex-col items-center gap-4">
        <input
          type="file"
          accept="image/*"
          onChange={handleFileChange}
          className="block w-full max-w-xs rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
        />
        <label className="flex items-center gap-3 text-sm text-neutral-300">
          <span>Threshold</span>
          <input
            type="range"
            min={0.1}
            max={0.9}
            step={0.05}
            value={threshold}
            onChange={(e) => setThreshold(parseFloat(e.target.value))}
          />
          <span className="w-10 text-right text-xs text-neutral-400">
            {threshold.toFixed(2)}
          </span>
        </label>
      </div>

      <div className="flex gap-6">
        <div className="flex flex-col items-center">
          <span className="mb-2 text-xs uppercase tracking-wide text-neutral-400">
            Original Image
          </span>
          <canvas
            ref={imageCanvasRef}
            width={BOX_SIZE}
            height={BOX_SIZE}
            className="h-[300px] w-[300px] rounded-md border border-neutral-800 bg-neutral-900"
          />
        </div>
        <div className="flex flex-col items-center">
          <span className="mb-2 text-xs uppercase tracking-wide text-neutral-400">
            Extracted Outline
          </span>
          <canvas
            ref={outlineCanvasRef}
            width={BOX_SIZE}
            height={BOX_SIZE}
            className="h-[300px] w-[300px] rounded-md border border-neutral-800 bg-neutral-900"
          />
        </div>
      </div>
    </main>
  );
}

