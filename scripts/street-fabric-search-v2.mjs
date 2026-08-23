import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
const require=createRequire(import.meta.url); const sharp=require("sharp");
const root=process.cwd(); const stamp=new Date().toISOString().replace(/[:.]/g,"-"); const outDir=path.join(root,"tmp-street-fabric-search",stamp);
function arc(cx,cy,rx,ry,a0,a1,n){const pts=[];for(let i=0;i<=n;i++){const t=a0+(a1-a0)*i/n;pts.push([cx+Math.cos(t)*rx,cy+Math.sin(t)*ry]);}return pts;}
function densify(points,max=30){const out=[];for(let i=0;i<points.length;i++){const a=points[i];out.push(a);const b=points[i+1];if(!b)continue;const d=Math.hypot(b[0]-a[0],b[1]-a[1]);const steps=Math.max(1,Math.ceil(d/max));for(let s=1;s<steps;s++){const t=s/steps;out.push([a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t]);}}return out;}
function sneaker(){
  const outsole=[[0,210],[180,135],[520,105],[900,112],[1280,160],[1620,255]];
  const toe=arc(1560,335,175,125,-0.55,1.25,16);
  const upper=[[1395,505],[1110,570],[870,665],[690,835],[525,890],[390,780],[305,555],[140,380],[0,210]];
  const ankleOpening=[[525,890],[620,675],[835,695],[690,835]];
  const heelCup=[[305,555],[230,790],[390,780]];
  const soleLine=[[80,190],[460,175],[850,185],[1240,220],[1540,295]];
  const laceRows=[[650,680],[710,510],[800,690],[875,505],[960,655],[1040,525],[1130,610]];
  const sidePanel=[[430,365],[700,285],[1120,330],[1430,455],[1040,390],[720,405],[430,365]];
  return densify([...outsole,...toe,...upper,...ankleOpening,...heelCup,...soleLine,...sidePanel,...laceRows]);
}
function witch(){
  const hatBrim=[[250,500],[520,430],[885,450],[1160,560],[890,625],[520,600],[250,500]];
  const hatPeak=[[520,600],[700,0],[910,610],[760,480],[700,0]];
  const face=[[760,610],[800,760],[710,865],[590,790],[520,600]];
  const nose=[[710,735],[940,790],[720,820]];
  const cloak=[[590,790],[455,1130],[650,1260],[830,805],[800,760]];
  const broomHandle=[[455,1130],[840,1030],[1260,900],[1620,790]];
  const bristles=[[1620,790],[1460,665],[1690,760],[1485,870],[1730,930],[1485,870],[1660,1050]];
  return densify([...hatBrim,...hatPeak,...face,...nose,...cloak,...broomHandle,...bristles]);
}
function bounds(pts){const xs=pts.map(p=>p[0]),ys=pts.map(p=>p[1]);return{minX:Math.min(...xs),maxX:Math.max(...xs),minY:Math.min(...ys),maxY:Math.max(...ys)}}
function project(pts,w,h,pad=54){const b=bounds(pts),s=Math.min((w-pad*2)/(b.maxX-b.minX),(h-pad*2)/(b.maxY-b.minY)),uw=(b.maxX-b.minX)*s,uh=(b.maxY-b.minY)*s,ox=(w-uw)/2,oy=(h-uh)/2;return ([x,y])=>[ox+(x-b.minX)*s,oy+(b.maxY-y)*s];}
function pathD(pts,pr){return pts.map((p,i)=>{const [x,y]=pr(p);return `${i?'L':'M'} ${x.toFixed(1)} ${y.toFixed(1)}`}).join(' ')}
function fabricLines(w,h,step=72){const lines=[];for(let x=40;x<w;x+=step)lines.push(`<path d="M ${x} 30 L ${x} ${h-30}" stroke="#dedede" stroke-width="2"/>`);for(let y=40;y<h;y+=step)lines.push(`<path d="M 30 ${y} L ${w-30} ${y}" stroke="#dedede" stroke-width="2"/>`);for(let x=-h;x<w+h;x+=step*2)lines.push(`<path d="M ${x} ${h-30} L ${x+h-60} 30" stroke="#e6e6e6" stroke-width="1.5"/>`);return lines.join('\n');}
async function render(id,pts,ref){const dir=path.join(outDir,id);await fs.mkdir(dir,{recursive:true});await fs.copyFile(path.join(root,ref),path.join(dir,'source'+path.extname(ref)));const w=1100,h=820,pr=project(pts,w,h),d=pathD(pts,pr);const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#f6f4ef"/><rect x="24" y="24" width="${w-48}" height="${h-48}" fill="#fff"/>${fabricLines(w,h)}<path d="${d}" fill="none" stroke="#7b1024" stroke-width="13" stroke-linecap="round" stroke-linejoin="round"/><path d="${d}" fill="none" stroke="#ef1744" stroke-width="6.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;await sharp(Buffer.from(svg)).png().toFile(path.join(dir,'route-blind.png'));return {id,blindImage:path.relative(root,path.join(dir,'route-blind.png')).replace(/\\/g,'/')};}
async function main(){await fs.mkdir(outDir,{recursive:true});const summary=[];summary.push(await render('sneaker-clean-fabric',sneaker(),'sneaker.jpg'));summary.push(await render('witch-hat-fabric',witch(),'witch.jpg'));await fs.writeFile(path.join(outDir,'summary.json'),JSON.stringify(summary,null,2));console.log(path.relative(root,outDir));}
main().catch(e=>{console.error(e);process.exit(1)});