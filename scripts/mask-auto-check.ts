// which extraction mode does the unattended picker choose? npx tsx scripts/mask-auto-check.ts <images...>
import { loadMaskAuto } from "./finisher-shared";
(async () => {
  for (const f of process.argv.slice(2)) {
    const m = await loadMaskAuto(f);
    let ink = 0;
    for (let i = 0; i < m.mask.length; i++) if (m.mask[i] === 255) ink++;
    console.log(`${f} -> ${m.mode} (${((100 * ink) / m.mask.length).toFixed(1)} % ink)`);
  }
})();
