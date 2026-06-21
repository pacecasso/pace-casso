export type NormalizedPathPoint = { x: number; y: number };

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function paintDisk(
  mask: Uint8Array,
  size: number,
  cx: number,
  cy: number,
  radius: number,
): void {
  const r = Math.max(1, radius);
  const r2 = r * r;
  for (let y = Math.max(0, cy - r) | 0; y <= Math.min(size - 1, cy + r); y++) {
    for (let x = Math.max(0, cx - r) | 0; x <= Math.min(size - 1, cx + r); x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r2) mask[y * size + x] = 255;
    }
  }
}

function paintLine(
  mask: Uint8Array,
  size: number,
  a: NormalizedPathPoint,
  b: NormalizedPathPoint,
  radius: number,
): void {
  const x0 = clampInt(a.x * (size - 1), 0, size - 1);
  const y0 = clampInt(a.y * (size - 1), 0, size - 1);
  const x1 = clampInt(b.x * (size - 1), 0, size - 1);
  const y1 = clampInt(b.y * (size - 1), 0, size - 1);
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    paintDisk(
      mask,
      size,
      Math.round(x0 + (x1 - x0) * t),
      Math.round(y0 + (y1 - y0) * t),
      radius,
    );
  }
}

export function rasterizeNormalizedPathToLineMask(
  points: NormalizedPathPoint[],
  size: number,
  radius = 2,
): Uint8Array {
  const mask = new Uint8Array(size * size);
  if (points.length === 1) {
    paintDisk(
      mask,
      size,
      clampInt(points[0]!.x * (size - 1), 0, size - 1),
      clampInt(points[0]!.y * (size - 1), 0, size - 1),
      radius,
    );
    return mask;
  }

  for (let i = 1; i < points.length; i++) {
    paintLine(mask, size, points[i - 1]!, points[i]!, radius);
  }
  return mask;
}
