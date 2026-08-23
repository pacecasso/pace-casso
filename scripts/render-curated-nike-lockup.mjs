import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
const require=createRequire(import.meta.url);
const sharp=require("sharp");
const jiti=require("jiti")(import.meta.url);
const { CURATED_NIKE_BLOCK_LOCKUP_MANHATTAN_COORDS, curatedNikeBlockLockupRouteKm }=jiti("../lib/curatedNikeBlockLockupManhattanRoute.ts");
const root=process.cwd();
const outDir=path.join(root,"tmp-logo-proof","brand-lockup-with-text","nike");
const M=111320;function meters(a,b){const m=M*Math.cos(a[0]*Math.PI/180);return Math.hypot((b[0]-a[0])*M,(b[1]-a[1])*m)}
function bounds(ps){const xs=ps.map(p=>p[1]),ys=ps.map(p=>p[0]);return{minX:Math.min(...xs),maxX:Math.max(...xs),minY:Math.min(...ys),maxY:Math.max(...ys)}}
function project(ll,w,h,pad=70){const b=bounds(ll),mx=M*Math.cos(((b.minY+b.maxY)/2)*Math.PI/180),spanX=(b.maxX-b.minX)*mx,spanY=(b.maxY-b.minY)*M,s=Math.min((w-pad*2)/(spanX||1),(h-pad*2)/(spanY||1)),ox=(w-spanX*s)/2,oy=(h-spanY*s)/2;return p=>[ox+(p[1]-b.minX)*mx*s,oy+(b.maxY-p[0])*M*s]}
function d(ps,pr){return ps.map((p,i)=>{const q=pr(p);return`${i?'L':'M'} ${q[0].toFixed(1)} ${q[1].toFixed(1)}`}).join(' ')}
function gpx(chain){return`<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="PaceCasso curated Nike lockup" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>Nike swoosh plus JUST DO IT</name><trkseg>\n${chain.map(([lat,lng])=>`<trkpt lat="${lat.toFixed(7)}" lon="${lng.toFixed(7)}"></trkpt>`).join('\n')}\n</trkseg></trk></gpx>\n`}
async function main(){await fs.rm(outDir,{recursive:true,force:true});await fs.mkdir(outDir,{recursive:true});const chain=CURATED_NIKE_BLOCK_LOCKUP_MANHATTAN_COORDS;const pr=project(chain,1100,850);const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="1100" height="850"><rect width="100%" height="100%" fill="#fff"/><path d="${d(chain,pr)}" fill="none" stroke="#111" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/><text x="24" y="38" font-family="Arial" font-size="20" font-weight="700">nike lockup ${curatedNikeBlockLockupRouteKm().toFixed(1)} km — swoosh plus JUST DO IT</text></svg>`;await sharp(Buffer.from(svg)).jpeg({quality:94}).toFile(path.join(outDir,"nike-just-do-it-lockup.jpg"));await fs.writeFile(path.join(outDir,"nike-just-do-it-lockup.gpx"),gpx(chain));console.log(path.relative(root,path.join(outDir,"nike-just-do-it-lockup.jpg")).replace(/\\/g,'/'));}
main().catch(e=>{console.error(e);process.exit(1)});
