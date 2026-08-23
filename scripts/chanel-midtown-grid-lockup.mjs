import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
const require=createRequire(import.meta.url);
const sharp=require("sharp");
const root=process.cwd();
const outDir=path.join(root,"tmp-logo-proof","chanel-midtown-grid-lockup");
function bearingUnitVector(deg){const r=deg*Math.PI/180;return{east:Math.sin(r),north:Math.cos(r)}}
function offsetLatLng(center,east,north){const M=111320,mx=M*Math.cos(center[0]*Math.PI/180);return[center[0]+north/M,center[1]+east/mx]}
function projectRaw(raw,center,xStep,yStep,bearing){let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;for(const p of raw){minX=Math.min(minX,p.x);maxX=Math.max(maxX,p.x);minY=Math.min(minY,p.y);maxY=Math.max(maxY,p.y)}const cx=(minX+maxX)/2,cy=(minY+maxY)/2,xAxis=bearingUnitVector(bearing),yAxis=bearingUnitVector(bearing-90);return raw.map(p=>{const lx=(p.x-cx)*xStep,ly=(p.y-cy)*yStep;return offsetLatLng(center,lx*xAxis.east+ly*yAxis.east,lx*xAxis.north+ly*yAxis.north)})}
function add(out,x,y){const last=out[out.length-1];if(!last||last.x!==x||last.y!==y)out.push({x,y})}
function move(out,x,y){const cur=out[out.length-1];if(!cur){add(out,x,y);return;} if(cur.x!==x)add(out,x,y); if(cur.y!==y)add(out,x,y)}
function draw(out,pts){for(const [x,y] of pts)move(out,x,y)}
function C(x,y,w,h){return [[x+w,y+h],[x,y+h],[x,y],[x+w,y]]}
function H(x,y,w,h){const m=y+h/2;return [[x,y],[x,y+h],[x,m],[x+w,m],[x+w,y],[x+w,y+h]]}
function A(x,y,w,h){const m=y+h/2;return [[x,y+h],[x,y],[x+w,y],[x+w,y+h],[x+w,m],[x,m],[x,y+h]]}
function N(x,y,w,h){const pts=[[x,y+h],[x,y]];const steps=4;let px=x,py=y;for(let i=1;i<=steps;i++){const nx=x+w*i/steps,ny=y+h*i/steps;pts.push([nx,py],[nx,ny]);px=nx;py=ny;}pts.push([x+w,y],[x+w,y+h]);return pts}
function E(x,y,w,h){const m=y+h/2;return [[x+w,y+h],[x,y+h],[x,y],[x+w,y],[x,y],[x,m],[x+w,m],[x,m],[x,y+h],[x+w,y+h]]}
function L(x,y,w,h){return [[x,y+h],[x,y],[x,y+h],[x+w,y+h]]}
function word(out,x,y,w,h,g){for(const fn of [C,H,A,N,E,L]){draw(out,fn(x,y,w,h));x+=w+g}}
function make({w,h,g,symW,symH}){const out=[];const total=6*w+5*g;const cx=total/2; // double-C made of two open block loops, overlapped like the source
 draw(out,[[cx-1,y0=0]]); return out}
function build(spec){const out=[];const x=0,y=0,w=spec.w,h=spec.h,g=spec.g,total=6*w+5*g,cx=total/2,symY=h+2; // larger y renders above/north
 draw(out,[[cx+0.6,symY],[cx+3.8,symY],[cx+4.6,symY+0.8],[cx+4.6,symY+2.6],[cx+3.8,symY+3.4],[cx+0.6,symY+3.4]]);
 draw(out,[[cx-0.6,symY+3.4],[cx-3.8,symY+3.4],[cx-4.6,symY+2.6],[cx-4.6,symY+0.8],[cx-3.8,symY],[cx-0.6,symY]]);
 // route around the left margin into the word, not through it
 move(out,-2,symY); move(out,-2,y+h); move(out,0,y+h);
 word(out,x,y,w,h,g);
 return out}
function meters(a,b){const M=111320,mx=M*Math.cos(a[0]*Math.PI/180);return Math.hypot((b[0]-a[0])*M,(b[1]-a[1])*mx)}
function km(ps){let t=0;for(let i=1;i<ps.length;i++)t+=meters(ps[i-1],ps[i]);return t/1000}
function bounds(ps){const lats=ps.map(p=>p[0]),lngs=ps.map(p=>p[1]);return{minLat:Math.min(...lats),maxLat:Math.max(...lats),minLng:Math.min(...lngs),maxLng:Math.max(...lngs)}}
function renderProject(ps,W,H,pad=70){const b=bounds(ps),mid=(b.minLat+b.maxLat)/2,mx=111320*Math.cos(mid*Math.PI/180),spanX=Math.max(1,(b.maxLng-b.minLng)*mx),spanY=Math.max(1,(b.maxLat-b.minLat)*111320),s=Math.min((W-pad*2)/spanX,(H-pad*2)/spanY),ox=(W-spanX*s)/2,oy=(H-spanY*s)/2;return p=>[ox+(p[1]-b.minLng)*mx*s,oy+(b.maxLat-p[0])*111320*s]}
function d(ps,pr){return ps.map((p,i)=>{const q=pr(p);return`${i?'L':'M'} ${q[0].toFixed(1)} ${q[1].toFixed(1)}`}).join(' ')}
async function render(ps,file,label){const W=1280,H=920,pr=renderProject(ps,W,H);const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="#fff"/><path d="${d(ps,pr)}" fill="none" stroke="#111" stroke-width="13" stroke-linecap="round" stroke-linejoin="round"/><text x="24" y="38" font-family="Arial" font-size="20" font-weight="700">${label}</text></svg>`;await sharp(Buffer.from(svg)).jpeg({quality:94}).toFile(file)}
function gpx(name,ps){return`<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="PaceCasso midtown-grid Chanel proof" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${name}</name><trkseg>\n${ps.map(([la,ln])=>`<trkpt lat="${la.toFixed(7)}" lon="${ln.toFixed(7)}"></trkpt>`).join('\n')}\n</trkseg></trk></gpx>\n`}
async function main(){await fs.rm(outDir,{recursive:true,force:true});await fs.mkdir(outDir,{recursive:true});const specs=[{w:3,h:6,g:1.8,xStep:155,yStep:160},{w:3.4,h:6.4,g:2.1,xStep:165,yStep:170},{w:3.7,h:6.8,g:2.3,xStep:170,yStep:180},{w:4,h:7,g:2.5,xStep:175,yStep:185}];const centers=[[40.752,-73.988],[40.758,-73.985],[40.746,-73.99]];const rows=[];let n=0;for(const spec of specs)for(const center of centers.slice(0,2)){const raw=build(spec);const anchors=projectRaw(raw,center,spec.xStep,spec.yStep,112);const name=`chanel-mid-${String(++n).padStart(2,'0')}`;await render(anchors,path.join(outDir,`${name}.jpg`),`${name} ${km(anchors).toFixed(1)} km CHANEL one-track grid lockup`);await fs.writeFile(path.join(outDir,`${name}.gpx`),gpx(name,anchors),'utf8');rows.push({name,km:+km(anchors).toFixed(2),jpg:path.relative(root,path.join(outDir,`${name}.jpg`)).replace(/\\/g,'/'),gpx:path.relative(root,path.join(outDir,`${name}.gpx`)).replace(/\\/g,'/')});}
const comps=[];for(const row of rows){const input=await sharp(path.join(root,row.jpg)).resize(640,460,{fit:'contain',background:'#fff'}).jpeg().toBuffer();comps.push({input,left:(comps.length%2)*640,top:Math.floor(comps.length/2)*460});}
await sharp({create:{width:1280,height:Math.ceil(comps.length/2)*460,channels:3,background:'#fff'}}).composite(comps).jpeg({quality:92}).toFile(path.join(outDir,'candidate-sheet.jpg'));await fs.writeFile(path.join(outDir,'summary.json'),JSON.stringify(rows,null,2));console.log(JSON.stringify({outDir:path.relative(root,outDir).replace(/\\/g,'/'),rows},null,2));}
main().catch(e=>{console.error(e);process.exit(1)});