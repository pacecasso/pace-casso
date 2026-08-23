import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const sharp = require("sharp");
const root=process.cwd();
const srcDir=path.join(root,"tmp-logo-proof","strava-arm-connector-search");
const outDir=path.join(root,"tmp-logo-proof","strava-hidden-transfer-preview");
const M=111320, origin=[40.748,-73.994];
const X={e:Math.sin(119*Math.PI/180),n:Math.cos(119*Math.PI/180)},Y={e:Math.sin(29*Math.PI/180),n:Math.cos(29*Math.PI/180)};
function toLocal([lat,lng]){const m=M*Math.cos(origin[0]*Math.PI/180),n=(lat-origin[0])*M,e=(lng-origin[1])*m,det=X.e*Y.n-Y.e*X.n;return[(e*Y.n-Y.e*n)/det,(X.e*n-e*X.n)/det]}
function parseGpx(txt){return[...txt.matchAll(/<trkpt lat="([^"]+)" lon="([^"]+)"/g)].map(m=>[+m[1],+m[2]])}
function dist(a,b){return Math.hypot(a[0]-b[0],a[1]-b[1])}
function splitLargestJump(chain){const loc=chain.map(toLocal);let bi=1,bd=0;for(let i=1;i<loc.length;i++){const d=dist(loc[i-1],loc[i]);if(d>bd){bd=d;bi=i}}return [chain.slice(0,bi),chain.slice(bi),bd]}
function bounds(points){const xs=points.map(p=>p[0]),ys=points.map(p=>p[1]);return{minX:Math.min(...xs),maxX:Math.max(...xs),minY:Math.min(...ys),maxY:Math.max(...ys)}}
function project(points,w,h,pad=70){const b=bounds(points),s=Math.min((w-pad*2)/(b.maxX-b.minX||1),(h-pad*2)/(b.maxY-b.minY||1)),ox=(w-(b.maxX-b.minX)*s)/2,oy=(h-(b.maxY-b.minY)*s)/2;return p=>[ox+(p[0]-b.minX)*s,oy+(b.maxY-p[1])*s]}
function d(points,pr){return points.map((p,i)=>{const q=pr(p);return`${i?'L':'M'} ${q[0].toFixed(1)} ${q[1].toFixed(1)}`}).join(' ')}
async function render(segments,file,label){const locSegs=segments.map(s=>s.map(toLocal));const all=locSegs.flat();const pr=project(all,980,760);const paths=locSegs.map(s=>`<path d="${d(s,pr)}" fill="none" stroke="#111" stroke-width="18" stroke-linecap="round" stroke-linejoin="round"/>`).join('\n');const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="980" height="760"><rect width="100%" height="100%" fill="#fff"/>${paths}<text x="24" y="38" font-family="Arial" font-size="20" font-weight="700">${label}</text></svg>`;await sharp(Buffer.from(svg)).jpeg({quality:94}).toFile(file)}
function gpxSegments(name,segs){return`<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="PaceCasso hidden-transfer proof" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${name}</name>\n${segs.map(seg=>`<trkseg>\n${seg.map(([lat,lng])=>`<trkpt lat="${lat.toFixed(7)}" lon="${lng.toFixed(7)}"></trkpt>`).join('\n')}\n</trkseg>`).join('\n')}\n</trk></gpx>\n`}
async function main(){await fs.rm(outDir,{recursive:true,force:true});await fs.mkdir(outDir,{recursive:true});const summary=[];for(let i=1;i<=40;i++){const id=`arm-${String(i).padStart(2,'0')}`;const gpx=path.join(srcDir,`${id}.gpx`);try{const chain=parseGpx(await fs.readFile(gpx,'utf8'));const [a,b,jump]=splitLargestJump(chain);if(a.length<2||b.length<2)continue;const file=path.join(outDir,`${id}.jpg`);await render([a,b],file,`${id} art strokes, transfer hidden`);await fs.writeFile(path.join(outDir,`${id}-segmented.gpx`),gpxSegments(id,[a,b]));summary.push({id,jump:+jump.toFixed(1),image:path.relative(root,file).replace(/\\/g,'/')});}catch{}}
await fs.writeFile(path.join(outDir,'summary.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify({kept:summary.length,outDir:path.relative(root,outDir)},null,2))}
main().catch(e=>{console.error(e);process.exit(1)})
