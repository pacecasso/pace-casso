/**
 * Curated normalized contours (0–1 space) that read well on a rectangular street grid.
 * Copy is Manhattan-oriented but shapes work in any city preset.
 */

export type AreaDesignContour = { x: number; y: number };

export type AreaDesignTemplate = {
  id: string;
  title: string;
  blurb: string;
  contour: AreaDesignContour[];
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

/** Short intro for the template row (Manhattan grid–aware copy). */
export const AREA_TEMPLATE_INTRO =
  "These shapes sit nicely on a rectangular grid—great for NYC avenues and crosstowns. Pick one to skip tracing and go straight to placement.";

export const AREA_DESIGN_TEMPLATES: AreaDesignTemplate[] = [
  {
    id: "heart",
    title: "Heart",
    blurb: "Classic loop; reads well when snapped to long blocks.",
    contour: heartRaw(),
  },
  {
    id: "zig-avenue",
    title: "Zig avenue",
    blurb: "Alternating diagonals—uses the grid like switchbacks.",
    contour: zigZGridRaw(),
  },
  {
    id: "block-m",
    title: "Block M",
    blurb: "Verticals and a deep V—lots of 90° corners for street corners.",
    contour: blockMRaw(),
  },
  {
    id: "stadium",
    title: "Stadium loop",
    blurb: "Smooth oval; easy to scale across several neighborhoods.",
    contour: stadiumOvalRaw(),
  },
  {
    id: "bolt",
    title: "Lightning",
    blurb: "Sharp turns; good when you want a punchy, angular snap.",
    contour: lightningRaw(),
  },
];
