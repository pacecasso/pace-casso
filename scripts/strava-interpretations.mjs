import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const sharp = require("sharp");
const jiti = require("jiti")(import.meta.url);
const { buildLatticeGraph } = jiti("../lib/latticeCompiler.ts");
const root=process.cwd();
const outDir=path.join(root,"tmp-logo-proof","strava-interpretations");
const M=111320, origin=[40.748,-73.994];
const X={e:Math.sin(119*Math.PI/180),n:Math.cos(119*Math.PI/180)},Y={e:Math.sin(29*Math.PI/180),n:Math.cos(29*Math.PI/180)};
function toLL([x,y]){const e=x*X.e+y*Y.e,n=x*X.n+y*Y.n,m=M*Math.cos(origin[0]*Math.PI/180);return[origin[0]+n/M,origin[1]+e/m]}
function toLocal([lat,lng]){const m=M*Math.cos(origin[0]*Math.PI/180),n=(lat-origin[0])*M,e=(lng-origin[1])*m,det=X.e*Y.n-Y.e*X.n;return[(e*Y.n-Y.e*n)/det,(X.e*n-e*X.n)/det]}
function dist(a,b){return Math.hypot(a[0]-b[0],a[1]-b[1])}
function nearest(graph,p){let best=0,bd=Infinity;const lp=toLocal(toLL(p));for(let i=0;i<graph.nodes.length;i++){const d=dist(toLocal(graph.nodes[i]),lp);if(d<bd){bd=d;best=i}}return best}
function shortest(graph,a,b){if(a===b)return{path:[a],m:0};const D=new Map([[a,0]]),P=new Map(),done=new Set(),open=[[0,a]],t=toLocal(graph.nodes[b]);while(open.length){let bi=0;for(let i=1;i<open.length;i++)if(open[i][0]<open[bi][0])bi=i;const[,c]=open.splice(bi,1)[0];if(c===b)break;if(done.has(c))continue;done.add(c);const cd=D.get(c)??Infinity;for(const e of graph.adj.get(c)??[]){const nd=cd+e.len;if(nd<(D.get(e.to)??Infinity)){D.set(e.to,nd);P.set(e.to,c);open.push([nd+dist(toLocal(graph.nodes[e.to]),t),e.to])}}}if(!P.has(b))return null;const path=[];let c=b;while(c!==undefined){path.push(c);c=P.get(c)}path.reverse();return{path,m:D.get(b)??0}}
function append(chain,graph,nodes){for(let i=0;i<nodes.length;i++){const node=graph.nodes[nodes[i]];if(i>0){const e=(graph.adj.get(nodes[i-1])??[]).find(x=>x.to===nodes[i]);if(e)for(const v of e.via??[])chain.push(v)}const last=chain[chain.length-1];if(!last||last[0]!==node[0]||last[1]!==node[1])chain.push(node)}}
function route(graph,pts){const ns=pts.map(p=>nearest(graph,p)).filter((n,i,a)=>i===0||n!==a[i-1]);const chain=[graph.nodes[ns[0]]];let m=0,fail=0;for(let i=1;i<ns.length;i++){const leg=shortest(graph,ns[i-1],ns[i]);if(!leg){fail++;continue}append(chain,graph,leg.path);m+=leg.m}return{chain,km:m/1000,fail,waypoints:ns.length}}
function pr(points,w,h,pad=70){const xs=points.map(p=>p[0]),ys=points.map(p=>p[1]);const b={minX:Math.min(...xs),maxX:Math.max(...xs),minY:Math.min(...ys),maxY:Math.max(...ys)};const s=Math.min((w-pad*2)/(b.maxX-b.minX||1),(h-pad*2)/(b.maxY-b.minY||1));const ox=(w-(b.maxX-b.minX)*s)/2,oy=(h-(b.maxY-b.minY)*s)/2;return p=>[ox+(p[0]-b.minX)*s,oy+(b.maxY-p[1])*s]}
function pathD(points,proj){return points.map((p,i)=>{const q=proj(p);return`${i?'L':'M'} ${q[0].toFixed(1)} ${q[1].toFixed(1)}`}).join(' ')}
async function render(chain,file,label){const loc=chain.map(toLocal),w=1000,h=760,proj=pr(loc,w,h);const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#fff"/><path d="${pathD(loc,proj)}" fill="none" stroke="#111" stroke-width="18" stroke-linecap="round" stroke-linejoin="round"/><text x="24" y="38" font-family="Arial" font-size="20" font-weight="700">${label}</text></svg>`;await sharp(Buffer.from(svg)).jpeg({quality:94}).toFile(file)}
function gpx(name,chain){return`<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="PaceCasso interpretation" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${name}</name><trkseg>\n${chain.map(([lat,lng])=>`<trkpt lat="${lat.toFixed(7)}" lon="${lng.toFixed(7)}"></trkpt>`).join('\n')}\n</trkseg></trk></gpx>\n`}
function interpTemplates(){return[
 {id:'summit-run', pts:[[0,0],[300,520],[520,960],[760,1380],[1000,920],[1260,520],[1540,0],[1220,0],[760,760],[300,0],[0,0],[1020,-160],[800,-500],[760,-760],[720,-500],[500,-160],[1020,-160]]},
 {id:'mountain-badge', pts:[[0,0],[260,380],[520,820],[780,1280],[1040,820],[1300,380],[1560,0],[1230,0],[780,620],[330,0],[0,0],[430,-180],[780,-660],[1130,-180],[430,-180]]},
 {id:'runner-peak', pts:[[0,0],[220,0],[460,420],[730,1020],[980,420],[1220,0],[1500,0],[1220,260],[980,640],[730,1320],[460,640],[220,260],[0,0],[730,640],[980,120],[1220,120],[980,-360],[730,-700],[480,-360],[730,120]]},
 {id:'double-arrow', pts:[[0,0],[360,640],[720,1280],[1080,640],[1440,0],[1120,0],[720,720],[320,0],[0,0],[280,-160],[720,-780],[1160,-160],[880,-160],[720,-430],[560,-160],[280,-160]]}
]}
async function main(){await fs.rm(outDir,{recursive:true,force:true});await fs.mkdir(outDir,{recursive:true});const graph=buildLatticeGraph(JSON.parse(await fs.readFile(path.join(root,'lib/data/manhattan-lattice.json'),'utf8')));const results=[];for(const t of interpTemplates()){for(const shift of [[700,2000],[1400,2100],[2100,2200],[1100,3100],[1900,3300]]){const pts=t.pts.map(([x,y])=>[x+shift[0],y+shift[1]]);const r=route(graph,pts);if(r.fail)continue;if(r.km<5||r.km>20)continue;results.push({template:t.id,shift,r,score:Math.abs(r.km-10)})}}
results.sort((a,b)=>a.score-b.score);const summary=[];let i=0;for(const x of results.slice(0,12)){const id=`${String(++i).padStart(2,'0')}-${x.template}`;const img=path.join(outDir,`${id}.jpg`);await render(x.r.chain,img,`${id} ${x.r.km.toFixed(1)} km`);await fs.writeFile(path.join(outDir,`${id}.gpx`),gpx(id,x.r.chain));summary.push({id,km:+x.r.km.toFixed(2),image:path.relative(root,img).replace(/\\/g,'/')})}await fs.writeFile(path.join(outDir,'summary.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify(summary,null,2))}
main().catch(e=>{console.error(e);process.exit(1)})
