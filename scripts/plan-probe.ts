/** What strokes does makePlan actually produce? Does the gas hose exist at all? */
import { makePlan, setHugTolerance } from "../lib/strokePainter";
import { loadMaskAuto, fillEnclosed } from "../lib/geoMask";

async function main(): Promise<void> {
  const img = process.argv[2]!;
  const scale = Number(process.argv[3] ?? 2500);
  const hug = Number(process.argv[4] ?? 90);
  const m = await loadMaskAuto(img);
  const filled = fillEnclosed(m.mask, m.w, m.h);
  setHugTolerance(hug);
  const plan = makePlan(filled, m.w, m.h, scale, { pitchM: 160, rows: 0, openM: 60, minRelMass: 0.02 }, []);
  console.log(`${img} @${scale} hug=${hug}: mode=${m.mode} strokes=${plan.strokes.length}`);
  plan.strokes.forEach((s, i) => {
    const xs = s.pts.map((p) => p[0]);
    const ys = s.pts.map((p) => p[1]);
    const spanX = (Math.max(...xs) - Math.min(...xs)) * scale;
    const spanY = (Math.max(...ys) - Math.min(...ys)) * scale;
    console.log(
      `  stroke ${i}: kind=${s.kind} closed=${s.closed} link=${s.link ?? false} group=${s.group ?? "-"} ` +
        `${s.pts.length} pts, span ${spanX.toFixed(0)} x ${spanY.toFixed(0)} m`,
    );
  });
}
main().catch((e) => { console.error(e); process.exit(1); });
