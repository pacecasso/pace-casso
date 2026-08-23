import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
const require=createRequire(import.meta.url);
const sharp=require("sharp");
const jiti=require("jiti")(import.meta.url);
const { haversineMeters }=jiti("../lib/latticeCompiler.ts");
const root=process.cwd();
const inFile=path.join(root,"tmp-logo-proof","strava-single-run-from-block","strava-single-run-visible-connector.gpx");
const outDir=path.join(root,"tmp-logo-proof","strava-cleaned");
function parse(xml){const pts=[];const re=/<trkpt lat="([^"]+)" lon="([^"]+)"/g;let m;while((m=re.exec(xml)))pts.push([+m[1],+m[2]]);return pts;}
function localBasis(ps){const b=boundsLL(ps);const lat=(b.minLat+b.maxLat)/2;return {lat,mx:111320*Math.cos(lat*Math.PI/180),my:111320,lat0:b.minLat,lng0:b.minLng};}
function toXY(p,b){return[(p[1]-b.lng0)*b.mx,(p[0]-b.lat0)*b.my];}
function toLL(q,b){return[b.lat0+q[1]/b.my,b.lng0+q[0]/b.mx];}
function boundsLL(ps){const lats=ps.map(p=>p[0]),lngs=ps.map(p=>p[1]);return{minLat:Math.min(...lats),maxLat:Math.max(...lats),minLng:Math.min(...lngs),maxLng:Math.max(...lngs)}}
function pointSegDist(p,a,b){const vx=b[0]-a[0],vy=b[1]-a[1],wx=p[0]-a[0],wy=p[1]-a[1];const l2=vx*vx+vy*vy;if(l2===0)return Math.hypot(wx,wy);const t=Math.max(0,Math.min(1,(wx*vx+wy*vy)/l2));return Math.hypot(p[0]-(a[0]+t*vx),p[1]-(a[1]+t*vy));}
function rdp(ps,tol){if(ps.length<=2)return ps.slice();let maxD=-1,idx=-1;const a=ps[0],b=ps[ps.length-1];for(let i=1;i<ps.length-1;i++){const d=pointSegDist(ps[i],a,b);if(d>maxD){maxD=d;idx=i;}}if(maxD<=tol)return[a,b];return[...rdp(ps.slice(0,idx+1),tol).slice(0,-1),...rdp(ps.slice(idx),tol)];}
function splitParts(ps){ // from known connected candidate: top until short connector then lower. Connector is dark, but GPX has top+2 connector+lower from summary.
 return [ps.slice(0,642),ps.slice(642,644),ps.slice(644)];
}
function km(ps){let t=0;for(let i=1;i<ps.length;i++)t+=haversineMeters(ps[i-1],ps[i]);return t/1000;}
function bounds(ps){const xs=ps.map(p=>p[1]),ys=ps.map(p=>p[0]);return{minX:Math.min(...xs),maxX:Math.max(...xs),minY:Math.min(...ys),maxY:Math.max(...ys)}}
function project(ll,w,h,pad=70){const b=bounds(ll),mx=111320*Math.cos(((b.minY+b.maxY)/2)*Math.PI/180),spanX=Math.max(1,(b.maxX-b.minX)*mx),spanY=Math.max(1,(b.maxY-b.minY)*111320),s=Math.min((w-pad*2)/spanX,(h-pad*2)/spanY),ox=(w-spanX*s)/2,oy=(h-spanY*s)/2;return p=>[ox+(p[1]-b.minX)*mx*s,oy+(b.maxY-p[0])*111320*s]}
function d(ps,pr){return ps.map((p,i)=>{const q=pr(p);return`${i?'L':'M'} ${q[0].toFixed(1)} ${q[1].toFixed(1)}`}).join(' ')}
async function render(parts,file,label){const all=parts.flat(),W=1080,H=830,pr=project(all,W,H);const paths=parts.map((seg,i)=>`<path d="${d(seg,pr)}" fill="none" stroke="${i===1?'#666':i===2?'#ff9b70':'#fc4c02'}" stroke-width="17" stroke-linecap="round" stroke-linejoin="round"/><path d="${d(seg,pr)}" fill="none" stroke="#111" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" opacity=".65"/>`).join('');const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="#fff"/>${paths}<text x="24" y="38" font-family="Arial" font-size="20" font-weight="700">${label}</text></svg>`;await sharp(Buffer.from(svg)).jpeg({quality:94}).toFile(file)}
function gpx(name,ps){return`<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="PaceCasso Strava cleanup draft" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${name}</name><trkseg>\n${ps.map(([la,ln])=>`<trkpt lat="${la.toFixed(7)}" lon="${ln.toFixed(7)}"></trkpt>`).join('\n')}\n</trkseg></trk></gpx>\n`}
async function main(){await fs.rm(outDir,{recursive:true,force:true});await fs.mkdir(outDir,{recursive:true});const pts=parse(await fs.readFile(inFile,"utf8"));const [top,conn,low]=splitParts(pts);const basis=localBasis(pts);const rows=[];for(const tol of [0,12,20,30,42,55,70]){const cleanPart=(seg)=>tol===0?seg:rdp(seg.map(p=>toXY(p,basis)),tol).map(q=>toLL(q,basis));const t=cleanPart(top),l=cleanPart(low);const parts=[t,conn,l];const chain=[...t,...conn,...l];const name=`strava-clean-${String(tol).padStart(2,'0')}`;await render(parts,path.join(outDir,`${name}.jpg`),`${name} tol ${tol}m ${km(chain).toFixed(1)} km pts ${chain.length}`);await fs.writeFile(path.join(outDir,`${name}.gpx`),gpx(name,chain));rows.push({name,tol,km:+km(chain).toFixed(2),points:chain.length,jpg:path.relative(root,path.join(outDir,`${name}.jpg`)).replace(/\\/g,'/')});}
const comps=[];for(const row of rows){const input=await sharp(path.join(root,row.jpg)).resize(540,415,{fit:'contain',background:'#fff'}).jpeg().toBuffer();comps.push({input,left:(comps.length%2)*540,top:Math.floor(comps.length/2)*415});}
await sharp({create:{width:1080,height:Math.ceil(comps.length/2)*415,channels:3,background:'#fff'}}).composite(comps).jpeg({quality:92}).toFile(path.join(outDir,'candidate-sheet.jpg'));await fs.writeFile(path.join(outDir,'summary.json'),JSON.stringify(rows,null,2));console.log(JSON.stringify({sheet:path.relative(root,path.join(outDir,'candidate-sheet.jpg')).replace(/\\/g,'/'),rows},null,2));}
main().catch(e=>{console.error(e);process.exit(1)});