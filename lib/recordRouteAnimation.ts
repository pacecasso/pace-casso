/**
 * Record a shareable video of the route drawing itself — the social-hook
 * feature. Uses MediaRecorder + canvas.captureStream, so the only output
 * format supported across all browsers is WebM. Safari on older iOS may
 * lack full support; callers should check `isRouteAnimationSupported()`
 * before offering the button.
 */

export const ANIMATION_DURATION_MS = 3200;
export const ANIMATION_HOLD_MS = 800;
export const ANIMATION_FPS = 30;
export const ANIMATION_SIZE = 512;

export function isRouteAnimationSupported(): boolean {
  if (typeof window === "undefined") return false;
  if (typeof MediaRecorder === "undefined") return false;
  if (typeof HTMLCanvasElement === "undefined") return false;
  // captureStream is the bit browsers most often lack; probe for it.
  const probe = document.createElement("canvas");
  return typeof (probe as HTMLCanvasElement & {
    captureStream?: (fps: number) => MediaStream;
  }).captureStream === "function";
}

type RecordOptions = {
  size?: number;
  durationMs?: number;
  holdMs?: number;
  fps?: number;
  /** Title shown top-left on the animation. Empty string to hide. */
  title?: string;
  /** Distance label shown bottom-left (e.g. "14.8 km"). Empty string to hide. */
  distanceLabel?: string;
  /** Route stroke colour. */
  strokeColor?: string;
};

function computeProjection(
  coords: [number, number][],
  size: number,
  padding: number,
): (lat: number, lng: number) => [number, number] {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const [lat, lng] of coords) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
  }
  const latSpan = maxLat - minLat || 1e-6;
  const lngSpan = maxLng - minLng || 1e-6;
  const drawW = size - 2 * padding;
  const drawH = size - 2 * padding;
  const scale = Math.min(drawW / lngSpan, drawH / latSpan);
  const scaledW = lngSpan * scale;
  const scaledH = latSpan * scale;
  const ox = padding + (drawW - scaledW) / 2;
  const oy = padding + (drawH - scaledH) / 2;
  return (lat: number, lng: number) => {
    const x = ox + ((lng - minLng) / lngSpan) * scaledW;
    const y = oy + scaledH - ((lat - minLat) / latSpan) * scaledH;
    return [x, y];
  };
}

function pickMimeType(): string {
  const candidates = [
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
  ];
  for (const mt of candidates) {
    if (
      typeof MediaRecorder !== "undefined" &&
      (MediaRecorder as unknown as {
        isTypeSupported?: (s: string) => boolean;
      }).isTypeSupported?.(mt)
    ) {
      return mt;
    }
  }
  return "video/webm";
}

/**
 * Record the route drawing itself as a WebM blob. Animation sequence:
 *   1. Fade-in background
 *   2. Route draws point-by-point over `durationMs`
 *   3. Completed route holds for `holdMs`
 */
export async function recordRouteAnimation(
  coords: [number, number][],
  options: RecordOptions = {},
): Promise<Blob | null> {
  if (!isRouteAnimationSupported()) return null;
  if (coords.length < 2) return null;

  const size = options.size ?? ANIMATION_SIZE;
  const durationMs = options.durationMs ?? ANIMATION_DURATION_MS;
  const holdMs = options.holdMs ?? ANIMATION_HOLD_MS;
  const fps = options.fps ?? ANIMATION_FPS;
  const strokeColor = options.strokeColor ?? "#e60000";
  const title = options.title ?? "PaceCasso";
  const distanceLabel = options.distanceLabel ?? "";

  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const project = computeProjection(coords, size, 36);

  const stream = (canvas as HTMLCanvasElement & {
    captureStream: (fps: number) => MediaStream;
  }).captureStream(fps);
  const recorder = new MediaRecorder(stream, { mimeType: pickMimeType() });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  const donePromise = new Promise<Blob>((resolve) => {
    recorder.onstop = () =>
      resolve(new Blob(chunks, { type: recorder.mimeType || "video/webm" }));
  });

  function paintFrame(progress: number): void {
    if (!ctx) return;
    // Background
    ctx.fillStyle = "#fbf9f1";
    ctx.fillRect(0, 0, size, size);

    // Subtle grid for that etch-a-sketch feel
    ctx.strokeStyle = "rgba(0,0,0,0.04)";
    ctx.lineWidth = 1;
    const gridStep = size / 12;
    for (let g = gridStep; g < size; g += gridStep) {
      ctx.beginPath();
      ctx.moveTo(g, 0);
      ctx.lineTo(g, size);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, g);
      ctx.lineTo(size, g);
      ctx.stroke();
    }

    // Route: drawn up to current progress
    const visible = Math.max(2, Math.round(coords.length * progress));
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = 4.5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.shadowColor = "rgba(230, 0, 0, 0.25)";
    ctx.shadowBlur = 8;
    ctx.beginPath();
    for (let i = 0; i < visible; i++) {
      const [lat, lng] = coords[i]!;
      const [x, y] = project(lat, lng);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;

    // "Leading dot" at the tip while still drawing
    if (progress < 1) {
      const lastIdx = Math.min(coords.length - 1, visible - 1);
      const [lat, lng] = coords[lastIdx]!;
      const [x, y] = project(lat, lng);
      ctx.fillStyle = strokeColor;
      ctx.beginPath();
      ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // Title (top-left)
    if (title) {
      ctx.fillStyle = "rgba(0,0,0,0.82)";
      ctx.font = "600 16px system-ui, sans-serif";
      ctx.textBaseline = "top";
      ctx.fillText(title, 18, 16);
      ctx.fillStyle = "rgba(255, 184, 0, 0.9)";
      ctx.fillRect(18, 36, 36, 2);
    }

    // Distance (bottom-left)
    if (distanceLabel) {
      ctx.fillStyle = "rgba(0,0,0,0.78)";
      ctx.font = "600 14px system-ui, sans-serif";
      ctx.textBaseline = "alphabetic";
      ctx.fillText(distanceLabel, 18, size - 18);
    }
  }

  recorder.start();
  const startedAt = performance.now();
  const totalDurationMs = durationMs + holdMs;

  return new Promise<Blob | null>((resolve) => {
    let stopped = false;

    function tick(): void {
      if (stopped) return;
      const elapsed = performance.now() - startedAt;
      const drawPhase = Math.min(1, elapsed / durationMs);
      // Ease-out cubic for a more natural "drawing" feel
      const eased = 1 - Math.pow(1 - drawPhase, 3);
      paintFrame(eased);
      if (elapsed < totalDurationMs) {
        requestAnimationFrame(tick);
      } else {
        stopped = true;
        paintFrame(1);
        // Give the recorder a moment to capture the final frame
        setTimeout(() => {
          try {
            recorder.stop();
          } catch {
            /* already stopped */
          }
          donePromise.then(resolve).catch(() => resolve(null));
        }, 100);
      }
    }
    requestAnimationFrame(tick);
  });
}
