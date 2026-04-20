/**
 * SVG → runnable contour. The high-leverage alternative to threshold-and-
 * trace: most corporate logos are available as SVG, which already IS clean
 * vector data. We sample the paths directly (via the browser's built-in
 * `SVGGeometryElement.getPointAtLength`), skipping the threshold / Moore-
 * boundary / curvature-sample pipeline entirely.
 *
 * Also renders the SVG to a JPEG data URL so Step 2's vision ranker has a
 * raster reference image for Claude — same interface the photo path uses.
 *
 * Security: SVGs can embed `<script>` and event handlers. We parse with
 * `DOMParser`, strip executable content, clone into a hidden DOM host only
 * long enough to sample the geometry, then remove the host.
 */

export type SvgContourPoint = { x: number; y: number };

export type SvgExtractionResult = {
  /** Normalized to [0, 1] × [0, 1] relative to the sampled-point bounding box. */
  contour: SvgContourPoint[];
  /** Raster JPEG data URL (for Step 2 vision ranking). White bg, max 1024 px. */
  imageBase64: string;
};

/** Roughly "how many points we want for a typical logo outline." */
const TARGET_POINTS = 360;
const MIN_POINTS = 32;
const MAX_POINTS = 1200;

const DANGEROUS_TAGS = new Set(["script", "foreignobject", "iframe"]);

/** Quick sniff — used by the upload handler before committing to this path. */
export function looksLikeSvgFile(file: File): boolean {
  if (file.type === "image/svg+xml") return true;
  return /\.svg$/i.test(file.name);
}

/**
 * Main entry. Returns `null` when the file isn't a parseable SVG or has no
 * geometry we can sample — callers fall back to the raster pipeline.
 */
export async function svgFileToContourAndPreview(
  file: File,
): Promise<SvgExtractionResult | null> {
  let text: string;
  try {
    text = await file.text();
  } catch {
    return null;
  }
  if (!text.includes("<svg")) return null;

  const parsed = parseAndSanitizeSvgText(text);
  if (!parsed) return null;
  const { svgEl, cleanedText } = parsed;

  let imageBase64: string;
  try {
    imageBase64 = await renderSvgToJpegDataUrl(cleanedText, 1024, 0.92);
  } catch (err) {
    console.warn("[svgToContour] raster preview failed:", err);
    return null;
  }

  const host = document.createElement("div");
  host.style.position = "absolute";
  host.style.left = "-9999px";
  host.style.top = "0";
  host.style.width = "1px";
  host.style.height = "1px";
  host.style.overflow = "hidden";
  host.setAttribute("aria-hidden", "true");
  const clone = svgEl.cloneNode(true) as SVGSVGElement;
  host.appendChild(clone);
  document.body.appendChild(host);

  try {
    const rings = sampleAllGeometry(clone);
    if (rings.length === 0) return null;
    const contour = normalizeAndPickPrimary(rings);
    if (contour.length < 4) return null;
    return { contour, imageBase64 };
  } catch (err) {
    console.warn("[svgToContour] sampling failed:", err);
    return null;
  } finally {
    try {
      document.body.removeChild(host);
    } catch {
      /* already gone */
    }
  }
}

/**
 * Strip scripts, event handlers, javascript: URLs, and other active content.
 * Returns both the sanitized SVG element and a serialized string form (the
 * string is what we hand to `<img src=...>` for the raster preview).
 */
function parseAndSanitizeSvgText(
  text: string,
): { svgEl: SVGSVGElement; cleanedText: string } | null {
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  if (doc.querySelector("parsererror")) return null;
  const el = doc.documentElement;
  if (!el || el.tagName.toLowerCase() !== "svg") return null;

  const all = el.querySelectorAll("*");
  const toRemove: Element[] = [];
  for (const node of Array.from(all)) {
    const tag = node.tagName.toLowerCase();
    if (DANGEROUS_TAGS.has(tag)) {
      toRemove.push(node);
      continue;
    }
    for (const attr of Array.from(node.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on")) {
        node.removeAttribute(attr.name);
        continue;
      }
      if (
        (name === "href" || name === "xlink:href") &&
        /^\s*(javascript|data:text\/html):/i.test(attr.value)
      ) {
        node.removeAttribute(attr.name);
      }
    }
  }
  for (const node of toRemove) node.remove();

  const cleanedText = new XMLSerializer().serializeToString(el);
  return { svgEl: el as unknown as SVGSVGElement, cleanedText };
}

type SampledRing = {
  pts: SvgContourPoint[];
  length: number;
};

/**
 * Sample every geometry element to a dense polyline. Browsers expose
 * `getTotalLength` + `getPointAtLength` on path, rect, circle, ellipse, line,
 * polygon, and polyline via the common `SVGGeometryElement` parent — no
 * custom path parser needed.
 */
function sampleAllGeometry(svg: SVGSVGElement): SampledRing[] {
  const geomEls = svg.querySelectorAll<SVGGeometryElement>(
    "path, polygon, polyline, rect, circle, ellipse, line",
  );
  if (geomEls.length === 0) return [];

  const rings: SampledRing[] = [];
  for (const el of Array.from(geomEls)) {
    let len = 0;
    try {
      len = el.getTotalLength();
    } catch {
      continue;
    }
    if (!Number.isFinite(len) || len <= 0.5) continue;
    // ~8 SVG user-units per sample on typical logos; clamped to [MIN, MAX].
    const n = Math.min(MAX_POINTS, Math.max(MIN_POINTS, Math.round(len / 4)));
    const pts: SvgContourPoint[] = [];
    for (let i = 0; i <= n; i++) {
      const t = (i / n) * len;
      let p: DOMPoint;
      try {
        p = el.getPointAtLength(t);
      } catch {
        continue;
      }
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      pts.push({ x: p.x, y: p.y });
    }
    if (pts.length >= 4) rings.push({ pts, length: len });
  }
  return rings;
}

/**
 * Compute a single normalized contour. Strategy: pick the longest ring as
 * the primary silhouette. Logos usually have one dominant path + some
 * ornamentation (registered marks, inner details); running the dominant path
 * produces a cleaner street-grid read than an all-paths union.
 *
 * Coordinates normalize into [0, 1]² using the bounding box of the PRIMARY
 * ring, so the contour fills the available space when placed.
 */
function normalizeAndPickPrimary(rings: SampledRing[]): SvgContourPoint[] {
  const sorted = [...rings].sort((a, b) => b.length - a.length);
  const primary = sorted[0].pts;

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of primary) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const w = Math.max(1e-6, maxX - minX);
  const h = Math.max(1e-6, maxY - minY);

  let contour: SvgContourPoint[] = primary.map((p) => ({
    x: (p.x - minX) / w,
    y: (p.y - minY) / h,
  }));

  if (contour.length > TARGET_POINTS) {
    contour = downsampleContour(contour, TARGET_POINTS);
  }
  return contour;
}

export function downsampleContour(
  contour: SvgContourPoint[],
  maxN: number,
): SvgContourPoint[] {
  if (contour.length <= maxN || maxN < 2) return contour;
  const stride = contour.length / maxN;
  const out: SvgContourPoint[] = [];
  for (let i = 0; i < maxN; i++) {
    out.push(contour[Math.min(contour.length - 1, Math.round(i * stride))]);
  }
  const last = contour[contour.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

/**
 * Rasterize the sanitized SVG to a JPEG data URL. Browsers happily decode
 * `<img src="blob:">` pointed at an `image/svg+xml` blob; we draw onto a
 * white-background canvas so transparent SVGs don't bake black into the JPEG.
 */
async function renderSvgToJpegDataUrl(
  svgText: string,
  maxEdge: number,
  jpegQuality: number,
): Promise<string> {
  const blob = new Blob([svgText], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("SVG image decode failed"));
      el.src = url;
    });
    const iw = img.naturalWidth || 1024;
    const ih = img.naturalHeight || 1024;
    const scale = Math.min(1, maxEdge / Math.max(iw, ih));
    const cw = Math.max(1, Math.round(iw * scale));
    const ch = Math.max(1, Math.round(ih * scale));
    const canvas = document.createElement("canvas");
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas 2d context unavailable");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, cw, ch);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, cw, ch);
    return canvas.toDataURL("image/jpeg", jpegQuality);
  } finally {
    URL.revokeObjectURL(url);
  }
}
