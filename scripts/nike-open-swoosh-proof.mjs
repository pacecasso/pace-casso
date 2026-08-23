import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
const require=createRequire(import.meta.url);
const sharp=require("sharp");
const jiti=require("jiti")(import.meta.url);
const { traceShapeOnStreets }=jiti("../lib/streetGraphTrace.ts");
const root=process.cwd();
const outDir=path.join(root,"tmp-logo-proof","nike-open-swoosh");
const contour=[
 {x:.07,y:.66},{x:.13,y:.73},{x:.24,y:.75},{x:.39,y:.69},{x:.58,y:.58},{x:.78,y:.44},{x:.96,y:.31}
];
const M=111320;function meters(a,b){const m=M*Math.cos(a[0]*Math.PI/180);return Math.hypot((b[0]-a[0])*M,(b[1]-a[1])*m)}
function bounds(ps){const xs=ps.map(p=>p[1]),ys=ps.map(p=>p[0]);return{minX:Math.min(...xs),maxX:Math.max(...xs),minY:Math.min(...ys),maxY:Math.max(...ys)}}
function project(ll,w,h,pad=70){const b=bounds(ll),mx=111320*Math.cos(((b.minY+b.maxY)/2)*Math.PI/180),spanX=(b.maxX-b.minX)*mx,spanY=(b.maxY-b.minY)*111320,s=Math.min((w-pad*2)/(spanX||1),(h-pad*2)/(spanY||1)),ox=(w-spanX*s)/2,oy=(h-spanY*s)/2;return p=>[ox+(p[1]-b.minX)*mx*s,oy+(b.maxY-p[0])*111320*s]}
function d(ps,pr){return ps.map((p,i)=>{const q=pr(p);return`${i?'L':'M'} ${q[0].toFixed(1)} ${q[1].toFixed(1)}`}).join(' ')}
function km(chain){let t=0;for(let i=1;i<chain.length;i++)t+=meters(chain[i-1],chain[i]);return t/1000}
async function render(c,file,label){const w=980,h=520,pr=project(c.chain,w,h);const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#fff"/><path d="${d(c.chain,pr)}" fill="none" stroke="#111" stroke-width="30" stroke-linecap="round" stroke-linejoin="round"/><path d="${d(c.chain,pr)}" fill="none" stroke="#111" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" opacity=".75"/><text x="24" y="38" font-family="Arial" font-size="20" font-weight="700">${label}</text></svg>`;await sharp(Buffer.from(svg)).jpeg({quality:94}).toFile(file)}
function gpx(name,chain){return`<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="PaceCasso open Nike swoosh" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${name}</name><trkseg>\n${chain.map(([lat,lng])=>`<trkpt lat="${lat.toFixed(7)}" lon="${lng.toFixed(7)}"></trkpt>`).join('\n')}\n</trkseg></trk></gpx>\n`}
async function main(){await fs.rm(outDir,{recursive:true,force:true});await fs.mkdir(outDir,{recursive:true});const cands=await traceShapeOnStreets(contour,{topK:4,anchorM:100,trimSpikes:false,closeLoop:false,scales:[1800,2600,3600,5000,6500,8200],rots:[-45,-30,-15,0,15,29,45,60,75],placementsPerScale:8,minCoverage:.92,centerStepDeg:.005});let n=0;const rows=[];for(const c of cands){const id=`swoosh-${String(++n).padStart(2,'0')}`;await render(c,path.join(outDir,`${id}.jpg`),`${id} ${c.km.toFixed(1)} km rot ${c.rotDeg}`);await fs.writeFile(path.join(outDir,`${id}.gpx`),gpx(id,c.chain));rows.push({id,km:c.km,rot:c.rotDeg,coverage:c.coverage,image:path.relative(root,path.join(outDir,`${id}.jpg`)).replace(/\\/g,'/')});}
const comps=[];for(const row of rows){const input=await sharp(path.join(outDir,`${row.id}.jpg`)).resize(490,260,{fit:'contain',background:'#fff'}).jpeg().toBuffer();comps.push({input,left:(comps.length%2)*490,top:Math.floor(comps.length/2)*260});}
await sharp({create:{width:980,height:Math.max(520,Math.ceil(comps.length/2)*260),channels:3,background:'#fff'}}).composite(comps).jpeg({quality:92}).toFile(path.join(outDir,'candidate-sheet.jpg'));
await fs.writeFile(path.join(outDir,'summary.json'),JSON.stringify({rows},null,2));console.log(JSON.stringify({count:rows.length,best:rows[0],sheet:path.relative(root,path.join(outDir,'candidate-sheet.jpg')).replace(/\\/g,'/')},null,2));}
main().catch(e=>{console.error(e);process.exit(1)});
