/** Does the API's mask differ from the offline rig's mask? */
import fs from "node:fs/promises";
import { loadMask, loadMaskAuto, fillEnclosed } from "../lib/geoMask";

const count = (m: Uint8Array): number => m.reduce((a, v) => a + (v ? 1 : 0), 0);

async function main(): Promise<void> {
  const file = process.argv[2] ?? "catpic.jpg";
  const buf = await fs.readFile(file);
  const api = await loadMask(buf, "auto");
  const rig = await loadMaskAuto(file);
  const rigFilled = fillEnclosed(rig.mask, rig.w, rig.h);
  const apiFilled = fillEnclosed(api.mask, api.w, api.h);
  console.log(`api   loadMask(buf,"auto"): ${api.w}x${api.h} ink=${count(api.mask)}`);
  console.log(`api   + fillEnclosed      : ink=${count(apiFilled)}`);
  console.log(`rig   loadMaskAuto(path)  : ${rig.w}x${rig.h} ink=${count(rig.mask)}`);
  console.log(`rig   + fillEnclosed      : ink=${count(rigFilled)}`);
  const same = api.w === rig.w && api.h === rig.h && count(apiFilled) === count(rigFilled);
  console.log(same ? "MASKS MATCH" : "MASKS DIFFER");
}
main().catch((e) => { console.error(e); process.exit(1); });
