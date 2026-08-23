import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
const require=createRequire(import.meta.url);
const sharp=require("sharp");
const root=process.cwd();
const outDir=path.join(root,"tmp-logo-proof","chanel-direct-grid-lockup");

async function loadGrid(){
 const raw=JSON.parse(await fs.readFile(path.join(root,"tmp-wordmark","downtown-grid.json"),"utf8"));
 const NC=raw.COLS.length, NR=raw.ROWS.length; const cell=[];
 for(let c=0;c<NC;c++){cell[c]=[];for(let r=0;r<NR;r++)cell[c][r]=raw.grid[`${raw.COLS[c]}|${raw.ROWS[r]}`]??null;}
 for(let pass=0;pass<12;pass++)for(let c=0;c<NC;c++)for(let r=0;r<NR;r++)if(!cell[c][r]){const nb=[];for(const [dc,dr] of [[1,0],[-1,0],[0,1],[0,-1]]){const cc=c+dc,rr=r+dr;if(cc>=0&&cc<NC&&rr>=0&&rr<NR&&cell[cc][rr])nb.push(cell[cc][rr]);}if(nb.length>=2)cell[c][r]=[nb.reduce((s,p)=>s+p[0],0)/nb.length,nb.reduce((s,p)=>s+p[1],0)/nb.length];}
 return {NC,NR,ll:(c,r)=>cell[Math.max(0,Math.min(NC-1,Math.round(c)))][Math.max(0,Math.min(NR-1,Math.round(r)))]};
}
function line(a,b){const pts=[];const dc=Math.sign(b[0]-a[0]),dr=Math.sign(b[1]-a[1]);const n=Math.max(Math.abs(b[0]-a[0]),Math.abs(b[1]-a[1]));for(let i=1;i<=n;i++)pts.push([a[0]+dc*i,a[1]+dr*i]);return pts;}
function addMove(out,p){if(!out.length){out.push(p);return;}const cur=out[out.length-1]; if(cur[0]===p[0]||cur[1]===p[1]) out.push(...line(cur,p)); else {out.push(...line(cur,[p[0],cur[1]])); out.push(...line([p[0],cur[1]],p));}}
function drawPath(out,pts){for(const p of pts)addMove(out,p);}
function C(x,y,w,h){return [[x+w,y+h],[x,y+h],[x,y],[x+w,y]];}
function H(x,y,w,h){return [[x,y],[x,y+h],[x,Math.round(y+h/2)],[x+w,Math.round(y+h/2)],[x+w,y],[x+w,y+h]];}
function A(x,y,w,h){const m=Math.round(y+h/2);return [[x,y+h],[x,y],[x+w,y],[x+w,y+h],[x+w,m],[x,m],[x,y+h]];}
function N(x,y,w,h){const pts=[[x,y+h],[x,y]];let cx=x,cy=y;const steps=Math.min(w,h);for(let i=1;i<=steps;i++){pts.push([x+i,cy]);pts.push([x+i,y+i]);cy=y+i;}pts.push([x+w,y],[x+w,y+h]);return pts;}
function E(x,y,w,h){const m=Math.round(y+h/2);return [[x+w,y+h],[x,y+h],[x,y],[x+w,y],[x,y],[x,m],[x+w,m],[x,m],[x,y+h],[x+w,y+h]];}
function L(x,y,w,h){return [[x,y],[x,y+h],[x+w,y+h]];}
function wordCHANEL(x,y,w,h,g){const letters=[C,H,A,N,E,L];const out=[];for(let i=0;i<letters.length;i++){const pts=letters[i](x+i*(w+g),y,w,h);drawPath(out,pts);}return out;}
function uniqueConsecutive(pts){const out=[];for(const p of pts){const q=out[out.length-1];if(!q||q[0]!==p[0]||q[1]!==p[1])out.push(p);}return out;}
function meters(a,b){const M=111320,mx=M*Math.cos(a[0]*Math.PI/180);return Math.hypot((b[0]-a[0])*M,(b[1]-a[1])*mx)}
function km(ps){let t=0;for(let i=1;i<ps.length;i++)t+=meters(ps[i-1],ps[i]);return t/1000}
function bounds(ps){const lats=ps.map(p=>p[0]),lngs=ps.map(p=>p[1]);return{minLat:Math.min(...lats),maxLat:Math.max(...lats),minLng:Math.min(...lngs),maxLng:Math.max(...lngs)}}
function project(ps,w,h,pad=60){const b=bounds(ps),mid=(b.minLat+b.maxLat)/2,mx=111320*Math.cos(mid*Math.PI/180),spanX=Math.max(1,(b.maxLng-b.minLng)*mx),spanY=Math.max(1,(b.maxLat-b.minLat)*111320),s=Math.min((w-pad*2)/spanX,(h-pad*2)/spanY),ox=(w-spanX*s)/2,oy=(h-spanY*s)/2;return p=>[ox+(p[1]-b.minLng)*mx*s,oy+(b.maxLat-p[0])*111320*s]}
function d(ps,pr){return ps.map((p,i)=>{const q=pr(p);return`${i?'L':'M'} ${q[0].toFixed(1)} ${q[1].toFixed(1)}`}).join(' ')}
async function render(ps,file,label){const W=1280,Hh=900,pr=project(ps,W,Hh,70);const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${Hh}"><rect width="100%" height="100%" fill="#fff"/><path d="${d(ps,pr)}" fill="none" stroke="#111" stroke-width="15" stroke-linecap="round" stroke-linejoin="round"/><text x="24" y="38" font-family="Arial" font-size="20" font-weight="700">${label}</text></svg>`;await sharp(Buffer.from(svg)).jpeg({quality:94}).toFile(file)}
function gpx(name,ps){return`<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="PaceCasso direct-grid Chanel proof" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${name}</name><trkseg>\n${ps.map(([la,ln])=>`<trkpt lat="${la.toFixed(7)}" lon="${ln.toFixed(7)}"></trkpt>`).join('\n')}\n</trkseg></trk></gpx>\n`}
function makeGridRoute({x=1,y=0,w=3,h=5,g=2}){const out=[];const totalW=6*w+5*g;const sx=x+Math.floor(totalW/2); // symbol centered
 // Interlocking block C marks. They overlap, but remain open on left/right.
 drawPath(out,[[sx-1,0],[sx-5,0],[sx-5,3],[sx-1,3],[sx-2,3],[sx-2,1],[sx+2,1],[sx+2,3],[sx+6,3],[sx+6,0],[sx+2,0]]);
 // connector around left side into word baseline
 addMove(out,[x-1,y+h+2]); addMove(out,[x,y+h]);
 drawPath(out,wordCHANEL(x,y+h+1,w,h,g));
 return uniqueConsecutive(out);
}
async function main(){await fs.rm(outDir,{recursive:true,force:true});await fs.mkdir(outDir,{recursive:true});const grid=await loadGrid();const specs=[{w:3,h:5,g:2},{w:4,h:6,g:2},{w:3,h:6,g:3},{w:4,h:7,g:3}];const rows=[];let i=0;for(const spec of specs){const gp=makeGridRoute({x:1,y:0,...spec});const ll=gp.map(([c,r])=>grid.ll(c,r));const name=`chanel-grid-${String(++i).padStart(2,'0')}`;await render(ll,path.join(outDir,`${name}.jpg`),`${name} ${km(ll).toFixed(1)} km direct street-grid CHANEL`);await fs.writeFile(path.join(outDir,`${name}.gpx`),gpx(name,ll),'utf8');rows.push({name,km:+km(ll).toFixed(2),gridPoints:gp.length,jpg:path.relative(root,path.join(outDir,`${name}.jpg`)).replace(/\\/g,'/'),gpx:path.relative(root,path.join(outDir,`${name}.gpx`)).replace(/\\/g,'/')});}
const comps=[];for(const row of rows){const input=await sharp(path.join(root,row.jpg)).resize(640,450,{fit:'contain',background:'#fff'}).jpeg().toBuffer();comps.push({input,left:(comps.length%2)*640,top:Math.floor(comps.length/2)*450});}
await sharp({create:{width:1280,height:Math.ceil(comps.length/2)*450,channels:3,background:'#fff'}}).composite(comps).jpeg({quality:92}).toFile(path.join(outDir,'candidate-sheet.jpg'));
await fs.writeFile(path.join(outDir,'summary.json'),JSON.stringify(rows,null,2));console.log(JSON.stringify({outDir:path.relative(root,outDir).replace(/\\/g,'/'),rows},null,2));}
main().catch(e=>{console.error(e);process.exit(1)});