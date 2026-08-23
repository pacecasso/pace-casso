import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
const require=createRequire(import.meta.url);
const sharp=require("sharp");
const jiti=require("jiti")(import.meta.url);
const { traceShapeOnStreets, getStreetGraph, traceContour, place }=jiti("../lib/streetGraphTrace.ts");
const root=process.cwd();
const outDir=path.join(root,"tmp-logo-proof","strava-street-trace-block-multistroke");
// Block-outline interpretation of the Strava logo. Each filled logo piece becomes
// a runnable outline track segment; there is no visible transfer line between pieces.
const top=[
 {x:.04,y:.56},{x:.40,y:.02},{x:.77,y:.56},{x:.61,y:.56},{x:.40,y:.27},{x:.20,y:.56},{x:.04,y:.56},
];
const lower=[
 {x:.45,y:.58},{x:.63,y:.98},{x:.92,y:.58},{x:.76,y:.58},{x:.63,y:.78},{x:.54,y:.58},{x:.45,y:.58},
];
const combined=[...top,...lower];
function units(contours){let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;for(const c of contours)for(const p of c){minX=Math.min(minX,p.x);maxX=Math.max(maxX,p.x);minY=Math.min(minY,p.y);maxY=Math.max(maxY,p.y);}const span=Math.max(maxX-minX,maxY-minY)||1,cx=(minX+maxX)/2,cy=(minY+maxY)/2;return contours.map(c=>c.map(p=>[((p.x-cx)*2)/span,((cy-p.y)*2)/span]));}
const M=111320;function meters(a,b){const m=M*Math.cos(a[0]*Math.PI/180);return Math.hypot((b[0]-a[0])*M,(b[1]-a[1])*m)}
function km(segs){let t=0;for(const seg of segs)for(let i=1;i<seg.length;i++)t+=meters(seg[i-1],seg[i]);return t/1000}
function bounds(ps){const xs=ps.map(p=>p[1]),ys=ps.map(p=>p[0]);return{minX:Math.min(...xs),maxX:Math.max(...xs),minY:Math.min(...ys),maxY:Math.max(...ys)}}
function project(ll,w,h,pad=70){const b=bounds(ll),mx=111320*Math.cos(((b.minY+b.maxY)/2)*Math.PI/180),spanX=(b.maxX-b.minX)*mx,spanY=(b.maxY-b.minY)*111320,s=Math.min((w-pad*2)/(spanX||1),(h-pad*2)/(spanY||1)),ox=(w-spanX*s)/2,oy=(h-spanY*s)/2;return p=>[ox+(p[1]-b.minX)*mx*s,oy+(b.maxY-p[0])*111320*s]}
function d(ps,pr){return ps.map((p,i)=>{const q=pr(p);return`${i?'L':'M'} ${q[0].toFixed(1)} ${q[1].toFixed(1)}`}).join(' ')}
async function render(segs,file,label){const all=segs.flat(),w=980,h=760,pr=project(all,w,h);const colors=['#fc4c02','#ff9b70'];const paths=segs.map((seg,i)=>`<path d="${d(seg,pr)}" fill="none" stroke="${colors[i]}" stroke-width="16" stroke-linecap="round" stroke-linejoin="round"/><path d="${d(seg,pr)}" fill="none" stroke="#111" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" opacity=".70"/>`).join('');const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#fff"/>${paths}<text x="24" y="38" font-family="Arial" font-size="20" font-weight="700">${label}</text></svg>`;await sharp(Buffer.from(svg)).jpeg({quality:94}).toFile(file)}
function gpx(name,segs){return`<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="PaceCasso block multi-stroke street trace" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${name}</name>\n${segs.map(seg=>`<trkseg>\n${seg.map(([lat,lng])=>`<trkpt lat="${lat.toFixed(7)}" lon="${lng.toFixed(7)}"></trkpt>`).join('\n')}\n</trkseg>`).join('\n')}\n</trk></gpx>\n`}
function scoreBlock(segs){const total=km(segs); const all=segs.flat(); const b=bounds(all); const aspect=((b.maxX-b.minX)*Math.cos(((b.minY+b.maxY)/2)*Math.PI/180))/(b.maxY-b.minY||1); return 100-Math.abs(aspect-.75)*16-Math.abs(total-18)*.18;}
async function main(){await fs.rm(outDir,{recursive:true,force:true});await fs.mkdir(outDir,{recursive:true});const placements=await traceShapeOnStreets(combined,{topK:4,anchorM:105,trimSpikes:false,closeLoop:false,scales:[1300,1800,2400,3200,4000,5200,6500],rots:[0,15,-15,29,-29,45,-45,60,-60,75,-75,90,-90,105,-105],placementsPerScale:8,minCoverage:.90,centerStepDeg:.005});const g=await getStreetGraph();const [uTop,uLower]=units([top,lower]);const rows=[];let n=0;for(const p of placements){for(const anchorM of [80,105,130]){const topTarget=place(uTop,p.center,p.scaleM,p.rotDeg);const lowerTarget=place(uLower,p.center,p.scaleM,p.rotDeg);const a=traceContour(g,topTarget,{anchorM,lambda:14,corridorM:110,trimSpikes:false,closeLoop:true});const b=traceContour(g,lowerTarget,{anchorM,lambda:14,corridorM:110,trimSpikes:false,closeLoop:true});if(a.chain.length<8||b.chain.length<8||a.coverage<.96||b.coverage<.96)continue;const segs=[a.chain,b.chain];const id=`block-${String(++n).padStart(2,'0')}`;const total=km(segs);const score=scoreBlock(segs);await render(segs,path.join(outDir,`${id}.jpg`),`${id} ${total.toFixed(1)} km rot ${p.rotDeg} s${score.toFixed(1)}`);await fs.writeFile(path.join(outDir,`${id}.gpx`),gpx(id,segs));rows.push({id,km:+total.toFixed(2),rot:p.rotDeg,scale:p.scaleM,anchorM,score:+score.toFixed(2),coverage:[a.coverage,b.coverage],image:path.relative(root,path.join(outDir,`${id}.jpg`)).replace(/\\/g,'/')});}}
rows.sort((a,b)=>b.score-a.score);const composites=[];for(const row of rows.slice(0,12)){const input=await sharp(path.join(outDir,`${row.id}.jpg`)).resize(490,380,{fit:'contain',background:'#fff'}).jpeg().toBuffer();composites.push({input,left:(composites.length%2)*490,top:Math.floor(composites.length/2)*380});}
await sharp({create:{width:980,height:Math.max(760,Math.ceil(composites.length/2)*380),channels:3,background:'#fff'}}).composite(composites).jpeg({quality:92}).toFile(path.join(outDir,'candidate-sheet.jpg'));
await fs.writeFile(path.join(outDir,'summary.json'),JSON.stringify({rows},null,2));console.log(JSON.stringify({count:rows.length,best:rows[0],sheet:path.relative(root,path.join(outDir,'candidate-sheet.jpg')).replace(/\\/g,'/')},null,2));}
main().catch(e=>{console.error(e);process.exit(1)});
