import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const sharp = require("sharp");
const jiti = require("jiti")(import.meta.url);
const { buildLatticeGraph, compileContourToLattice } = jiti("../lib/latticeCompiler.ts");

const root = process.cwd();
const outDir = path.join(root, "tmp-logo-proof", "chanel-downtown-lockup");
const glyphs = {
  C: ({l,r}, {t,b}) => [[r,b],[l,b],[l,t],[r,t]],
  H: ({l,r}, {t,m,b}) => [[l,t],[l,b],[l,m],[r,m],[r,t],[r,b]],
  A: ({l,c,r}, {t,m,b}) => [[l,b],[c,t],[r,b],[r,m],[l,m],[l,b]],
  N: ({l,r}, {t,b}) => [[l,b],[l,t],[r,b],[r,t],[r,b]],
  E: ({l,c,r}, {t,m,b}) => [[r,b],[l,b],[l,t],[r,t],[l,t],[l,m],[c,m],[l,m],[l,b],[r,b]],
  L: ({l,r}, {t,b}) => [[l,t],[l,b],[r,b]],
};
function arc(cx, cy, rx, ry, start, end, steps) {
  const pts=[];
  for (let i=0;i<=steps;i++) {
    const a=(start+(end-start)*i/steps)*Math.PI/180;
    pts.push([cx+Math.cos(a)*rx, cy+Math.sin(a)*ry]);
  }
  return pts;
}
function wordPts(word, x0, t, b, letterW, gap) {
  const pts=[]; let x=x0; const rows={t,m:(t+b)/2,b};
  for (let i=0;i<word.length;i++) {
    const ch=word[i]; const g=glyphs[ch]; if(!g) continue;
    const cols={l:x,c:x+letterW/2,r:x+letterW};
    const gp=g(cols, rows);
    if (pts.length) {
      const last=pts[pts.length-1];
      // baseline connector between letters, visible but low.
      pts.push([last[0], b], [gp[0][0], b]);
    }
    pts.push(...gp);
    x += letterW + gap;
  }
  return pts;
}
async function loadGrid() {
  const gridRaw = JSON.parse(await fs.readFile(path.join(root,"tmp-wordmark","downtown-grid.json"),"utf8"));
  const NC=gridRaw.COLS.length, NR=gridRaw.ROWS.length;
  const cell=[];
  for(let c=0;c<NC;c++){cell[c]=[];for(let r=0;r<NR;r++)cell[c][r]=gridRaw.grid[`${gridRaw.COLS[c]}|${gridRaw.ROWS[r]}`]??null;}
  for(let pass=0;pass<12;pass++)for(let c=0;c<NC;c++)for(let r=0;r<NR;r++)if(!cell[c][r]){
    const nb=[]; for(const [dc,dr] of [[1,0],[-1,0],[0,1],[0,-1]]){const cc=c+dc, rr=r+dr; if(cc>=0&&cc<NC&&rr>=0&&rr<NR&&cell[cc][rr])nb.push(cell[cc][rr]);}
    if(nb.length>=2)cell[c][r]=[nb.reduce((s,p)=>s+p[0],0)/nb.length,nb.reduce((s,p)=>s+p[1],0)/nb.length];
  }
  return (col,row)=>{const c0=Math.max(0,Math.min(NC-2,Math.floor(col))), r0=Math.max(0,Math.min(NR-2,Math.floor(row))); const fc=col-c0, fr=row-r0; const p00=cell[c0][r0], p10=cell[c0+1][r0], p01=cell[c0][r0+1], p11=cell[c0+1][r0+1]; return [p00[0]*(1-fc)*(1-fr)+p10[0]*fc*(1-fr)+p01[0]*(1-fc)*fr+p11[0]*fc*fr, p00[1]*(1-fc)*(1-fr)+p10[1]*fc*(1-fr)+p01[1]*(1-fc)*fr+p11[1]*fc*fr];};
}
function meters(a,b){const M=111320, mx=M*Math.cos(a[0]*Math.PI/180);return Math.hypot((b[0]-a[0])*M,(b[1]-a[1])*mx)}
function densifyLL(pts, step=55){const out=[];for(let i=0;i<pts.length;i++){if(i===0){out.push(pts[i]);continue;}const a=pts[i-1], b=pts[i];const d=meters(a,b);const n=Math.max(1,Math.round(d/step));for(let s=1;s<=n;s++)out.push([a[0]+(b[0]-a[0])*s/n,a[1]+(b[1]-a[1])*s/n]);}return out;}
function bounds(ps){const lats=ps.map(p=>p[0]), lngs=ps.map(p=>p[1]);return{minLat:Math.min(...lats),maxLat:Math.max(...lats),minLng:Math.min(...lngs),maxLng:Math.max(...lngs)}}
function project(ps,w,h,pad=60){const b=bounds(ps), mid=(b.minLat+b.maxLat)/2, mx=111320*Math.cos(mid*Math.PI/180), spanX=Math.max(1,(b.maxLng-b.minLng)*mx), spanY=Math.max(1,(b.maxLat-b.minLat)*111320), s=Math.min((w-pad*2)/spanX,(h-pad*2)/spanY), ox=(w-spanX*s)/2, oy=(h-spanY*s)/2;return p=>[ox+(p[1]-b.minLng)*mx*s,oy+(b.maxLat-p[0])*111320*s]}
function d(ps,pr){return ps.map((p,i)=>{const q=pr(p);return `${i?'L':'M'} ${q[0].toFixed(1)} ${q[1].toFixed(1)}`}).join(' ')}
async function render(ps,file,label){const w=1200,h=900,pr=project(ps,w,h,75);const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#fff"/><path d="${d(ps,pr)}" fill="none" stroke="#111" stroke-width="15" stroke-linecap="round" stroke-linejoin="round"/><text x="24" y="38" font-family="Arial" font-size="20" font-weight="700">${label}</text></svg>`;await sharp(Buffer.from(svg)).jpeg({quality:94}).toFile(file)}
function gpx(name, ps){return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="PaceCasso Chanel downtown lockup" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${name}</name><trkseg>\n${ps.map(([la,ln])=>`<trkpt lat="${la.toFixed(7)}" lon="${ln.toFixed(7)}"></trkpt>`).join('\n')}\n</trkseg></trk></gpx>\n`}
async function main(){
  await fs.rm(outDir,{recursive:true,force:true}); await fs.mkdir(outDir,{recursive:true});
  const ll=await loadGrid();
  const lattice=JSON.parse(await fs.readFile(path.join(root,"lib","data","manhattan-lattice.json"),"utf8"));
  const graph=buildLatticeGraph(lattice);
  const variants=[];
  let id=0;
  for (const spec of [
    {lw:2.35,gap:1.05,symRx:5.0,symRy:1.55,symY:1.8,wordT:4.2,wordB:8.4},
    {lw:2.55,gap:1.15,symRx:5.3,symRy:1.7,symY:1.7,wordT:4.3,wordB:8.7},
    {lw:2.15,gap:1.0,symRx:4.7,symRy:1.5,symY:1.8,wordT:4.1,wordB:8.1},
  ]) {
    const word=wordPts('CHANEL',0,spec.wordT,spec.wordB,spec.lw,spec.gap);
    const totalW=6*spec.lw+5*spec.gap;
    const cx=totalW/2;
    const leftC=arc(cx-1.55,spec.symY,spec.symRx*0.42,spec.symRy,58,302,34);
    const rightC=arc(cx+1.55,spec.symY,spec.symRx*0.42,spec.symRy,238,-58,34);
    const pts=[...leftC,[cx-0.15,spec.symY+spec.symRy+0.35],[cx+0.15,spec.symY+spec.symRy+0.35],...rightC];
    const last=pts[pts.length-1], firstWord=word[0];
    pts.push([last[0],spec.wordT-0.3],[Math.max(0,firstWord[0]-0.55),spec.wordT-0.3],[Math.max(0,firstWord[0]-0.55),firstWord[1]],[firstWord[0],firstWord[1]],...word);
    const llPts=densifyLL(pts.map(([c,r])=>ll(c,r)),50);
    const result=compileContourToLattice(llPts,graph,{sampleMeters:24,pinRadiusMeters:115,minPinSpacingMeters:45,maxLegDetourRatio:3.0,maxLegDetourSlackMeters:260});
    if(!result) continue;
    const name=`chanel-dt-${String(++id).padStart(2,'0')}`;
    const score=result.meanDeviationMeters+result.maxDeviationMeters/6+result.skippedPins*250+Math.abs(result.km-32)*2;
    await render(result.chain,path.join(outDir,`${name}.jpg`),`${name} ${result.km.toFixed(1)} km skipped ${result.skippedPins} dev ${result.meanDeviationMeters.toFixed(1)}/${result.maxDeviationMeters.toFixed(1)}`);
    await fs.writeFile(path.join(outDir,`${name}.gpx`),gpx(name,result.chain),'utf8');
    variants.push({name,score,km:+result.km.toFixed(2),skipped:result.skippedPins,mean:+result.meanDeviationMeters.toFixed(1),max:+result.maxDeviationMeters.toFixed(1),jpg:path.relative(root,path.join(outDir,`${name}.jpg`)).replace(/\\/g,'/'),gpx:path.relative(root,path.join(outDir,`${name}.gpx`)).replace(/\\/g,'/')});
  }
  variants.sort((a,b)=>a.score-b.score);
  const comps=[]; for(const row of variants){const input=await sharp(path.join(root,row.jpg)).resize(600,450,{fit:'contain',background:'#fff'}).jpeg().toBuffer(); comps.push({input,left:(comps.length%2)*600,top:Math.floor(comps.length/2)*450});}
  if(comps.length) await sharp({create:{width:1200,height:Math.ceil(comps.length/2)*450,channels:3,background:'#fff'}}).composite(comps).jpeg({quality:92}).toFile(path.join(outDir,'candidate-sheet.jpg'));
  await fs.writeFile(path.join(outDir,'summary.json'),JSON.stringify(variants,null,2));
  console.log(JSON.stringify({outDir:path.relative(root,outDir).replace(/\\/g,'/'),variants},null,2));
}
main().catch(e=>{console.error(e);process.exit(1)});