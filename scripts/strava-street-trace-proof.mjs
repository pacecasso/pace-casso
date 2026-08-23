import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
const require=createRequire(import.meta.url);
const sharp=require("sharp");
const jiti=require("jiti")(import.meta.url);
const { traceShapeOnStreets }=jiti("../lib/streetGraphTrace.ts");
const root=process.cwd();
const outDir=path.join(root,"tmp-logo-proof","strava-street-trace");
function contour(){return[
 {x:.08,y:.57},{x:.41,y:.02},{x:.74,y:.57},
 {x:.48,y:.57},{x:.63,y:.98},{x:.92,y:.57}
];}
function dist(a,b){const M=111320,m=M*Math.cos(a[0]*Math.PI/180);return Math.hypot((b[0]-a[0])*M,(b[1]-a[1])*m)}
function bounds(ps){const xs=ps.map(p=>p[1]),ys=ps.map(p=>p[0]);return{minX:Math.min(...xs),maxX:Math.max(...xs),minY:Math.min(...ys),maxY:Math.max(...ys)}}
function project(ll,w,h,pad=70){const b=bounds(ll),mx=111320*Math.cos(((b.minY+b.maxY)/2)*Math.PI/180),spanX=(b.maxX-b.minX)*mx,spanY=(b.maxY-b.minY)*111320,s=Math.min((w-pad*2)/(spanX||1),(h-pad*2)/(spanY||1)),ox=(w-spanX*s)/2,oy=(h-spanY*s)/2;return p=>[ox+(p[1]-b.minX)*mx*s,oy+(b.maxY-p[0])*111320*s]}
function d(ps,pr){return ps.map((p,i)=>{const q=pr(p);return`${i?'L':'M'} ${q[0].toFixed(1)} ${q[1].toFixed(1)}`}).join(' ')}
async function render(c,file,label){const w=980,h=760,pr=project(c.chain,w,h);const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#fff"/><path d="${d(c.chain,pr)}" fill="none" stroke="#fc4c02" stroke-width="18" stroke-linecap="round" stroke-linejoin="round"/><path d="${d(c.chain,pr)}" fill="none" stroke="#111" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" opacity=".75"/><text x="24" y="38" font-family="Arial" font-size="20" font-weight="700">${label}</text></svg>`;await sharp(Buffer.from(svg)).jpeg({quality:94}).toFile(file)}
function gpx(name,chain){return`<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="PaceCasso street-trace Strava" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${name}</name><trkseg>\n${chain.map(([lat,lng])=>`<trkpt lat="${lat.toFixed(7)}" lon="${lng.toFixed(7)}"></trkpt>`).join('\n')}\n</trkseg></trk></gpx>\n`}
async function main(){await fs.rm(outDir,{recursive:true,force:true});await fs.mkdir(outDir,{recursive:true});const candidates=await traceShapeOnStreets(contour(),{topK:4,anchorM:120,trimSpikes:false,closeLoop:false,scales:[900,1300,1800,2400,3200,4000,5200],rots:[0,15,-15,29,-29,45,-45,60,-60,75,-75,90,-90,105,-105],placementsPerScale:7,minCoverage:.96,centerStepDeg:.005});const summary=[];let i=0;for(const c of candidates){const id=`trace-${String(++i).padStart(2,'0')}`;await render(c,path.join(outDir,`${id}.jpg`),`${id} ${c.km.toFixed(1)} km v${c.visualScore?.toFixed?.(1)??''}`);await fs.writeFile(path.join(outDir,`${id}.gpx`),gpx(id,c.chain));summary.push({id,km:c.km,visualScore:c.visualScore,coverage:c.coverage,maxGapM:c.maxGapM,image:path.relative(root,path.join(outDir,`${id}.jpg`)).replace(/\\/g,'/')});}
const composites=[];for(const row of summary){const input=await sharp(path.join(outDir,`${row.id}.jpg`)).resize(490,380,{fit:'contain',background:'#fff'}).jpeg().toBuffer();composites.push({input,left:(composites.length%2)*490,top:Math.floor(composites.length/2)*380});}
await sharp({create:{width:980,height:760,channels:3,background:'#fff'}}).composite(composites).jpeg({quality:92}).toFile(path.join(outDir,'candidate-sheet.jpg'));
await fs.writeFile(path.join(outDir,'summary.json'),JSON.stringify({summary},null,2));console.log(JSON.stringify({count:summary.length,best:summary[0],sheet:path.relative(root,path.join(outDir,'candidate-sheet.jpg')).replace(/\\/g,'/')},null,2));}
main().catch(e=>{console.error(e);process.exit(1)});

