import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
const require=createRequire(import.meta.url);const sharp=require("sharp");
const root=process.cwd();
const routeFile=path.join(root,"tmp-logo-proof","strava-fullgraph-block","best-current-strava-repaired.gpx");
const out=path.join(root,"tmp-logo-proof","strava-fullgraph-block","best-current-strava-source-vs-polished.jpg");
function parse(xml){const pts=[];const re=/<trkpt lat="([^"]+)" lon="([^"]+)"/g;let m;while((m=re.exec(xml)))pts.push([+m[1],+m[2]]);return pts;}
function bounds(ps){const lats=ps.map(p=>p[0]),lngs=ps.map(p=>p[1]);return{minLat:Math.min(...lats),maxLat:Math.max(...lats),minLng:Math.min(...lngs),maxLng:Math.max(...lngs)}}
function project(ps,w,h,pad=58){const b=bounds(ps),mid=(b.minLat+b.maxLat)/2,mx=111320*Math.cos(mid*Math.PI/180),spanX=Math.max(1,(b.maxLng-b.minLng)*mx),spanY=Math.max(1,(b.maxLat-b.minLat)*111320),s=Math.min((w-pad*2)/spanX,(h-pad*2)/spanY),ox=(w-spanX*s)/2,oy=(h-spanY*s)/2;return p=>[ox+(p[1]-b.minLng)*mx*s,oy+(b.maxLat-p[0])*111320*s]}
function d(ps,pr){return ps.map((p,i)=>{const q=pr(p);return`${i?'L':'M'} ${q[0].toFixed(1)} ${q[1].toFixed(1)}`}).join(' ')}
const pts=parse(await fs.readFile(routeFile,"utf8"));
const w=720,h=620,pr=project(pts,w,h);
const routeSvg=Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#fff"/><path d="${d(pts,pr)}" fill="none" stroke="#fc4c02" stroke-width="15" stroke-linecap="round" stroke-linejoin="round"/><path d="${d(pts,pr)}" fill="none" stroke="#1d1d1d" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" opacity=".42"/></svg>`);
const route=await sharp(routeSvg).png().toBuffer();
const src=await sharp(path.join(root,"strava.png")).resize(w,h,{fit:"contain",background:"#fff"}).png().toBuffer();
const base=Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1520" height="760"><rect width="100%" height="100%" fill="#f7f4ee"/><text x="40" y="48" font-family="Arial" font-size="28" font-weight="700">Strava route candidate best-current</text><text x="40" y="82" font-family="Arial" font-size="16" fill="#555">16.95 km single GPX; verified on local OSM walk graph</text><text x="40" y="710" font-family="Arial" font-size="16" fill="#555">source</text><text x="800" y="710" font-family="Arial" font-size="16" fill="#555">route</text></svg>`);
await sharp(base).composite([{input:src,left:40,top:110},{input:route,left:800,top:110}]).jpeg({quality:94}).toFile(out);
console.log(path.relative(root,out).replace(/\\/g,"/"));