import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
const require=createRequire(import.meta.url);
const sharp=require("sharp");
const jiti=require("jiti")(import.meta.url);
const { traceShapeOnStreets, getStreetGraph, traceContour, place }=jiti("../lib/streetGraphTrace.ts");
const root=process.cwd();
const outRoot=path.join(root,"tmp-logo-proof","brand-block-multistroke");

function arcLine(cx,cy,r,startDeg,endDeg,steps=26){const pts=[];for(let i=0;i<=steps;i++){const t=(startDeg+(endDeg-startDeg)*i/steps)*Math.PI/180;pts.push({x:cx+Math.cos(t)*r,y:cy+Math.sin(t)*r});}return pts;}
function arcComponent(cx,cy,outerR,innerR,startDeg,endDeg,steps=22){
  const pts=[];
  for(let i=0;i<=steps;i++){const t=(startDeg+(endDeg-startDeg)*i/steps)*Math.PI/180;pts.push({x:cx+Math.cos(t)*outerR,y:cy+Math.sin(t)*outerR});}
  for(let i=steps;i>=0;i--){const t=(startDeg+(endDeg-startDeg)*i/steps)*Math.PI/180;pts.push({x:cx+Math.cos(t)*innerR,y:cy+Math.sin(t)*innerR});}
  pts.push(pts[0]);return pts;
}
function ellipse(cx,cy,rx,ry,steps=34,start=0,end=360){const pts=[];for(let i=0;i<=steps;i++){const t=(start+(end-start)*i/steps)*Math.PI/180;pts.push({x:cx+Math.cos(t)*rx,y:cy+Math.sin(t)*ry});}return pts;}
function swoosh(){return[
 {x:.055,y:.64},{x:.105,y:.735},{x:.205,y:.790},{x:.350,y:.760},{x:.535,y:.650},{x:.795,y:.455},{x:.965,y:.305},
 {x:.695,y:.375},{x:.455,y:.435},{x:.270,y:.500},{x:.175,y:.475},{x:.145,y:.380},{x:.205,y:.235},{x:.110,y:.350},{x:.070,y:.485},{x:.055,y:.640},
];}
function stonesLip(){return[
 {x:.18,y:.36},{x:.24,y:.29},{x:.31,y:.16},{x:.42,y:.07},{x:.51,y:.10},{x:.57,y:.16},{x:.64,y:.09},{x:.76,y:.07},{x:.86,y:.15},{x:.90,y:.32},{x:.96,y:.43},{x:.88,y:.48},{x:.76,y:.47},{x:.64,y:.41},{x:.54,y:.40},{x:.45,y:.43},{x:.35,y:.40},{x:.25,y:.45},{x:.16,y:.47},{x:.11,y:.43},{x:.18,y:.36},
];}
function stonesTongue(){return[
 {x:.48,y:.43},{x:.57,y:.48},{x:.64,y:.58},{x:.67,y:.72},{x:.66,y:.90},{x:.59,y:.98},{x:.50,y:.96},{x:.44,y:.86},{x:.40,y:.72},{x:.39,y:.59},{x:.42,y:.49},{x:.48,y:.43},
];}
function stonesMouth(){return[
 {x:.24,y:.43},{x:.34,y:.40},{x:.45,y:.45},{x:.34,y:.53},{x:.22,y:.50},{x:.17,y:.47},{x:.24,y:.43},
];}
function stonesHighlightL(){return[
 {x:.37,y:.14},{x:.45,y:.13},{x:.49,y:.18},{x:.47,y:.23},{x:.40,y:.22},{x:.34,y:.19},{x:.37,y:.14},
];}
function stonesHighlightR(){return[
 {x:.68,y:.13},{x:.78,y:.13},{x:.83,y:.19},{x:.80,y:.24},{x:.72,y:.22},{x:.65,y:.18},{x:.68,y:.13},
];}
const specs={
 nike:{
  label:'Nike swoosh block interpretation',
  components:[swoosh()],
  colors:['#111111'],
  placement:{scales:[1500,2200,3000,4000,5200,6500],rots:[-75,-60,-45,-30,-15,0,15,29],anchorM:120,placementsPerScale:8,minCoverage:.88},
  trace:{anchorMs:[85,115,145],lambda:14,corridorM:120,closeLoop:true,minCoverage:.96},
  targetAspect:3.0,targetKm:18,
 },
 chanel:{
  label:'Chanel double-C block interpretation',
  components:[arcComponent(.44,.43,.31,.205,55,305,26),arcComponent(.56,.43,.31,.205,-125,125,26)],
  colors:['#111111','#111111'],
  placement:{scales:[1300,1800,2400,3200,4000,5200,6500],rots:[-45,-29,-15,0,15,29,45,60,75,90],anchorM:120,placementsPerScale:8,minCoverage:.86},
  trace:{anchorMs:[80,110,140],lambda:15,corridorM:125,closeLoop:true,minCoverage:.94},
  targetAspect:1.85,targetKm:22,
 },
 stones:{
  label:'Rolling Stones lips tongue simplified interpretation',
  components:[stonesLip(),stonesTongue(),stonesMouth()],
  colors:['#e51d2a','#e51d2a','#211b1b'],
  placement:{scales:[1800,2400,3200,4000,5200,6500,7800],rots:[-45,-29,-15,0,15,29,45,60,75,90],anchorM:120,placementsPerScale:7,minCoverage:.82},
  trace:{anchorMs:[90,120,155,190],lambda:13,corridorM:170,closeLoop:true,minCoverage:.82},
  targetAspect:.70,targetKm:28,
 },
};
function normalizeTogether(components){let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;for(const c of components)for(const p of c){minX=Math.min(minX,p.x);maxX=Math.max(maxX,p.x);minY=Math.min(minY,p.y);maxY=Math.max(maxY,p.y);}const span=Math.max(maxX-minX,maxY-minY)||1,cx=(minX+maxX)/2,cy=(minY+maxY)/2;return components.map(c=>c.map(p=>[((p.x-cx)*2)/span,((cy-p.y)*2)/span]));}
const M=111320;function meters(a,b){const m=M*Math.cos(a[0]*Math.PI/180);return Math.hypot((b[0]-a[0])*M,(b[1]-a[1])*m)}
function km(segs){let t=0;for(const seg of segs)for(let i=1;i<seg.length;i++)t+=meters(seg[i-1],seg[i]);return t/1000}
function bounds(ps){const xs=ps.map(p=>p[1]),ys=ps.map(p=>p[0]);return{minX:Math.min(...xs),maxX:Math.max(...xs),minY:Math.min(...ys),maxY:Math.max(...ys)}}
function aspect(segs){const all=segs.flat(),b=bounds(all),mid=(b.minY+b.maxY)/2;return ((b.maxX-b.minX)*Math.cos(mid*Math.PI/180))/(b.maxY-b.minY||1)}
function score(spec,segs){const a=aspect(segs),total=km(segs);return 100-Math.abs(a-spec.targetAspect)*12-Math.abs(total-spec.targetKm)*.12;}
function project(ll,w,h,pad=70){const b=bounds(ll),mx=111320*Math.cos(((b.minY+b.maxY)/2)*Math.PI/180),spanX=(b.maxX-b.minX)*mx,spanY=(b.maxY-b.minY)*111320,s=Math.min((w-pad*2)/(spanX||1),(h-pad*2)/(spanY||1)),ox=(w-spanX*s)/2,oy=(h-spanY*s)/2;return p=>[ox+(p[1]-b.minX)*mx*s,oy+(b.maxY-p[0])*111320*s]}
function d(ps,pr){return ps.map((p,i)=>{const q=pr(p);return`${i?'L':'M'} ${q[0].toFixed(1)} ${q[1].toFixed(1)}`}).join(' ')}
async function render(spec,segs,file,label){const all=segs.flat(),w=980,h=760,pr=project(all,w,h);const paths=segs.map((seg,i)=>`<path d="${d(seg,pr)}" fill="none" stroke="${spec.colors[i%spec.colors.length]}" stroke-width="16" stroke-linecap="round" stroke-linejoin="round"/><path d="${d(seg,pr)}" fill="none" stroke="#111" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" opacity=".55"/>`).join('');const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#fff"/>${paths}<text x="24" y="38" font-family="Arial" font-size="20" font-weight="700">${label}</text></svg>`;await sharp(Buffer.from(svg)).jpeg({quality:94}).toFile(file)}
function gpx(name,segs){return`<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="PaceCasso brand block multi-stroke" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${name}</name>\n${segs.map(seg=>`<trkseg>\n${seg.map(([lat,lng])=>`<trkpt lat="${lat.toFixed(7)}" lon="${lng.toFixed(7)}"></trkpt>`).join('\n')}\n</trkseg>`).join('\n')}\n</trk></gpx>\n`}
async function runOne(name,spec){const outDir=path.join(outRoot,name);await fs.rm(outDir,{recursive:true,force:true});await fs.mkdir(outDir,{recursive:true});const combined=spec.components.flat();const placements=await traceShapeOnStreets(combined,{topK:4,anchorM:spec.placement.anchorM,trimSpikes:false,closeLoop:false,scales:spec.placement.scales,rots:spec.placement.rots,placementsPerScale:spec.placement.placementsPerScale,minCoverage:spec.placement.minCoverage,centerStepDeg:.005});const g=await getStreetGraph();const units=normalizeTogether(spec.components);const rows=[];let n=0;for(const p of placements){for(const anchorM of spec.trace.anchorMs){const segs=[];let ok=true,coverages=[];for(const unit of units){const target=place(unit,p.center,p.scaleM,p.rotDeg);const t=traceContour(g,target,{anchorM,lambda:spec.trace.lambda,corridorM:spec.trace.corridorM,trimSpikes:false,closeLoop:spec.trace.closeLoop});coverages.push(t.coverage);if(t.chain.length<8||t.coverage<spec.trace.minCoverage){ok=false;break;}segs.push(t.chain);}if(!ok)continue;const id=`${name}-${String(++n).padStart(2,'0')}`;const total=km(segs);const s=score(spec,segs);await render(spec,segs,path.join(outDir,`${id}.jpg`),`${id} ${total.toFixed(1)} km rot ${p.rotDeg} s${s.toFixed(1)}`);await fs.writeFile(path.join(outDir,`${id}.gpx`),gpx(id,segs));rows.push({id,km:+total.toFixed(2),rot:p.rotDeg,scale:p.scaleM,anchorM,score:+s.toFixed(2),coverage:coverages.map(x=>+x.toFixed(3)),image:path.relative(root,path.join(outDir,`${id}.jpg`)).replace(/\\/g,'/')});}}
rows.sort((a,b)=>b.score-a.score);const composites=[];for(const row of rows.slice(0,12)){const input=await sharp(path.join(outDir,`${row.id}.jpg`)).resize(490,380,{fit:'contain',background:'#fff'}).jpeg().toBuffer();composites.push({input,left:(composites.length%2)*490,top:Math.floor(composites.length/2)*380});}
await sharp({create:{width:980,height:Math.max(760,Math.ceil(composites.length/2)*380),channels:3,background:'#fff'}}).composite(composites).jpeg({quality:92}).toFile(path.join(outDir,'candidate-sheet.jpg'));
await fs.writeFile(path.join(outDir,'summary.json'),JSON.stringify({label:spec.label,rows},null,2));return {name,count:rows.length,best:rows[0],sheet:path.relative(root,path.join(outDir,'candidate-sheet.jpg')).replace(/\\/g,'/')};}
async function main(){await fs.mkdir(outRoot,{recursive:true});const names=process.argv.slice(2);const todo=names.length?names:Object.keys(specs);const out=[];for(const name of todo){if(!specs[name])throw new Error(`unknown spec ${name}`);console.log(`running ${name}`);out.push(await runOne(name,specs[name]));console.log(JSON.stringify(out[out.length-1],null,2));}await fs.writeFile(path.join(outRoot,'summary.json'),JSON.stringify(out,null,2));console.log(JSON.stringify({outRoot:path.relative(root,outRoot).replace(/\\/g,'/'),out},null,2));}
main().catch(e=>{console.error(e);process.exit(1)});








