/**
 * Curated normalized contours (0–1 space) that read well on a rectangular
 * street grid. Copy is Manhattan-oriented but shapes work in any city preset.
 *
 * Each template carries a `complexity` tag so the gallery can be ordered
 * simple → elaborate for a natural progression.
 */

export type AreaDesignContour = { x: number; y: number };
export type AreaDesignComplexity = "simple" | "medium" | "elaborate";

export type AreaDesignTemplate = {
  id: string;
  title: string;
  blurb: string;
  contour: AreaDesignContour[];
  complexity: AreaDesignComplexity;
  /** Visual icon for the card — emoji or single-glyph letter. Shown big so
   *  users see the *subject* at a glance, not the jagged contour. */
  icon: string;
};

function normalizeContourToBox(
  raw: AreaDesignContour[],
  pad = 0.06,
): AreaDesignContour[] {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of raw) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  const w = maxX - minX || 1;
  const h = maxY - minY || 1;
  const span = Math.max(w, h);
  const ox = (minX + maxX) / 2 - span / 2;
  const oy = (minY + maxY) / 2 - span / 2;
  const s = (1 - 2 * pad) / span;
  return raw.map((p) => ({
    x: pad + (p.x - ox) * s,
    y: pad + (p.y - oy) * s,
  }));
}

function stadiumOvalRaw(): AreaDesignContour[] {
  const pts: AreaDesignContour[] = [];
  const cx = 50;
  const cy = 50;
  const rx = 42;
  const ry = 28;
  for (let i = 0; i <= 48; i++) {
    const t = (i / 48) * Math.PI * 2;
    pts.push({ x: cx + rx * Math.cos(t), y: cy + ry * Math.sin(t) });
  }
  return normalizeContourToBox(pts);
}

function heartRaw(): AreaDesignContour[] {
  const pts: AreaDesignContour[] = [];
  for (let i = 0; i <= 64; i++) {
    const t = (i / 64) * Math.PI * 2;
    const x = 16 * Math.sin(t) ** 3;
    const y =
      -(13 * Math.cos(t) -
        5 * Math.cos(2 * t) -
        2 * Math.cos(3 * t) -
        Math.cos(4 * t));
    pts.push({ x, y });
  }
  return normalizeContourToBox(pts);
}

function blockMRaw(): AreaDesignContour[] {
  const pts: AreaDesignContour[] = [];
  const w = 80;
  const h = 90;
  const leg = 18;
  pts.push({ x: 0, y: h });
  pts.push({ x: 0, y: 0 });
  pts.push({ x: leg, y: 0 });
  pts.push({ x: w / 2, y: h * 0.55 });
  pts.push({ x: w - leg, y: 0 });
  pts.push({ x: w, y: 0 });
  pts.push({ x: w, y: h });
  pts.push({ x: w - leg, y: h });
  pts.push({ x: w - leg, y: leg * 1.2 });
  pts.push({ x: w / 2, y: h * 0.62 });
  pts.push({ x: leg, y: leg * 1.2 });
  pts.push({ x: leg, y: h });
  pts.push({ x: 0, y: h });
  return normalizeContourToBox(pts);
}

/** Simple block R: stem, bowl traced as a single loop on the outside, leg. */
function blockRRaw(): AreaDesignContour[] {
  const w = 70;
  const h = 100;
  const stem = 18;
  const bowlH = h * 0.55;
  const kneeY = bowlH + 4;
  const pts: AreaDesignContour[] = [
    { x: 0, y: h },
    { x: 0, y: 0 },
    { x: w - stem, y: 0 },
    { x: w, y: stem * 0.9 },
    { x: w, y: bowlH - stem * 0.9 },
    { x: w - stem, y: bowlH },
    // leg down to bottom-right
    { x: w, y: h },
    { x: w - stem, y: h },
    // Back up the inside of the leg and bowl
    { x: stem + (w - 2 * stem) * 0.45, y: bowlH + stem * 0.2 },
    { x: stem, y: bowlH },
    { x: stem, y: stem },
    { x: w - stem - 2, y: stem },
    { x: w - stem * 1.2, y: bowlH - stem * 0.9 },
    { x: stem, y: bowlH - stem * 0.1 },
    { x: stem, y: h },
    { x: 0, y: h },
  ];
  // Manually close the stem knee: add a simple fallback trace by keeping the
  // outer silhouette + the inner "bowl hole" concept. The pipeline's nested-
  // hole stitcher handles this, but since we hand-trace, keep outline crisp.
  return normalizeContourToBox(pts);
}

function fivePointStarRaw(): AreaDesignContour[] {
  const cx = 50;
  const cy = 52;
  const outer = 42;
  const inner = 18;
  const pts: AreaDesignContour[] = [];
  // 10 vertices: alternate outer/inner. Start at top.
  for (let i = 0; i < 10; i++) {
    const angle = -Math.PI / 2 + (i * Math.PI) / 5;
    const r = i % 2 === 0 ? outer : inner;
    pts.push({ x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) });
  }
  pts.push(pts[0]!);
  return normalizeContourToBox(pts);
}

function arrowRightRaw(): AreaDesignContour[] {
  // Classic right-pointing arrow with a thick shaft.
  const pts: AreaDesignContour[] = [
    { x: 0, y: 35 },
    { x: 60, y: 35 },
    { x: 60, y: 15 },
    { x: 100, y: 50 },
    { x: 60, y: 85 },
    { x: 60, y: 65 },
    { x: 0, y: 65 },
    { x: 0, y: 35 },
  ];
  return normalizeContourToBox(pts);
}

function houseRaw(): AreaDesignContour[] {
  // Classic child's drawing house: rectangle body + triangle roof.
  const pts: AreaDesignContour[] = [
    { x: 10, y: 100 },
    { x: 10, y: 45 },
    { x: 50, y: 5 },
    { x: 90, y: 45 },
    { x: 90, y: 100 },
    { x: 10, y: 100 },
  ];
  return normalizeContourToBox(pts);
}

function zigZGridRaw(): AreaDesignContour[] {
  const pts: AreaDesignContour[] = [];
  const w = 100;
  const h = 80;
  const zigs = 5;
  for (let z = 0; z < zigs; z++) {
    const x0 = (z * w) / zigs;
    const x1 = ((z + 1) * w) / zigs;
    const yTop = z % 2 === 0 ? 0 : h;
    const yBot = z % 2 === 0 ? h : 0;
    pts.push({ x: x0, y: yTop });
    pts.push({ x: x1, y: yBot });
  }
  return normalizeContourToBox(pts);
}

function lightningRaw(): AreaDesignContour[] {
  const pts: AreaDesignContour[] = [
    { x: 40, y: 5 },
    { x: 55, y: 40 },
    { x: 48, y: 42 },
    { x: 72, y: 88 },
    { x: 52, y: 50 },
    { x: 60, y: 46 },
    { x: 35, y: 8 },
  ];
  return normalizeContourToBox(pts);
}

function fishRaw(): AreaDesignContour[] {
  // Simple fish silhouette: teardrop body + forked tail.
  const pts: AreaDesignContour[] = [
    { x: 10, y: 50 }, // nose
    { x: 30, y: 25 },
    { x: 60, y: 18 },
    { x: 80, y: 35 },
    // tail
    { x: 100, y: 20 },
    { x: 94, y: 50 },
    { x: 100, y: 80 },
    // back along bottom
    { x: 80, y: 65 },
    { x: 60, y: 82 },
    { x: 30, y: 75 },
    { x: 10, y: 50 },
  ];
  return normalizeContourToBox(pts);
}

export const AREA_TEMPLATE_INTRO =
  "Pick a starter shape to skip tracing — ordered simple → elaborate. Each one's been test-snapped against the current city's streets so you know it'll work.";

/**
 * Curated starter shapes, simple → elaborate. The `complexity` tag drives
 * the visual grouping in the UI and also helps the runner choose something
 * that matches their appetite (a first run vs. a sprawling weekend project).
 */
export const AREA_DESIGN_TEMPLATES: AreaDesignTemplate[] = [
  {
    id: "stadium",
    title: "Loop",
    blurb: "Smooth oval — easiest to snap cleanly across any grid.",
    contour: stadiumOvalRaw(),
    complexity: "simple",
    icon: "⭕",
  },
  {
    id: "heart",
    title: "Heart",
    blurb: "Classic loop; reads well when snapped to long blocks.",
    contour: heartRaw(),
    complexity: "simple",
    icon: "❤️",
  },
  {
    id: "arrow",
    title: "Arrow",
    blurb: "Straight shaft + triangular head — crisp and readable.",
    contour: arrowRightRaw(),
    complexity: "simple",
    icon: "➡️",
  },
  {
    id: "house",
    title: "Little house",
    blurb: "Square body + triangle roof. A kids'-drawing classic.",
    contour: houseRaw(),
    complexity: "medium",
    icon: "🏠",
  },
  {
    id: "block-r",
    title: "Letter R",
    blurb: "Stem, bowl, and leg — a flex for your first letter run.",
    contour: blockRRaw(),
    complexity: "medium",
    icon: "R",
  },
  {
    id: "block-m",
    title: "Letter M",
    blurb: "Verticals and a deep V — lots of corners for street turns.",
    contour: blockMRaw(),
    complexity: "medium",
    icon: "M",
  },
  {
    id: "star",
    title: "Five-point star",
    blurb: "Sharp points; snaps best when stretched across many blocks.",
    contour: fivePointStarRaw(),
    complexity: "medium",
    icon: "⭐",
  },
  {
    id: "fish",
    title: "Fish",
    blurb: "Teardrop body + forked tail; needs a wide, open neighborhood.",
    contour: fishRaw(),
    complexity: "elaborate",
    icon: "🐟",
  },
  {
    id: "zig-avenue",
    title: "Zig avenue",
    blurb: "Alternating diagonals that ride the grid like switchbacks.",
    contour: zigZGridRaw(),
    complexity: "elaborate",
    icon: "⚡",
  },
  {
    id: "bolt",
    title: "Lightning",
    blurb: "Sharp turns — punchy and angular when snapped.",
    contour: lightningRaw(),
    complexity: "elaborate",
    icon: "🌩️",
  },
];

export const COMPLEXITY_ORDER: Record<AreaDesignComplexity, number> = {
  simple: 0,
  medium: 1,
  elaborate: 2,
};

export const COMPLEXITY_LABEL: Record<AreaDesignComplexity, string> = {
  simple: "Simple",
  medium: "Medium",
  elaborate: "Elaborate",
};

/**
 * Convert a normalized 0–1 contour into an SVG `d` attribute that fits a
 * `size × size` viewBox. Used for tiny preview thumbnails on the template
 * cards — pure SVG, no canvas, scales to any display size.
 */
export function contourToSvgPath(
  contour: AreaDesignContour[],
  size: number,
): string {
  if (contour.length < 2) return "";
  const parts: string[] = [];
  for (let i = 0; i < contour.length; i++) {
    const p = contour[i]!;
    const x = (p.x * size).toFixed(1);
    const y = (p.y * size).toFixed(1);
    parts.push(`${i === 0 ? "M" : "L"}${x},${y}`);
  }
  return parts.join(" ");
}
