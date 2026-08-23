import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const sharp = require("sharp");
const jiti = require("jiti")(import.meta.url);
const { buildLatticeGraph, haversineMeters } = jiti("../lib/latticeCompiler.ts");
const root = process.cwd();
const outDir = path.join(root,"tmp-logo-proof","strava-street-search");
const M=111320;
const center=[40.748,-73.994];
const X={e:Math.sin(119*Math.PI/180),n:Math.cos(119*Math.PI/180)};
const Y={e:Math.sin(29*Math.PI/180),n:Math.cos(29*Math.PI/180)};
function toLocal([lat,lng]){const m=M*Math.cos(center[0]*Math.PI/180);const n=(lat-center[0])*M,e=(lng-center[1])*m;const det=X.e*Y.n-Y.e*X.n;return [(e*Y.n-Y.e*n)/det,(X.e*n-e*X.n)/det];}
function dist(a,b){return Math.hypot(a[0]-b[0],a[1]-b[1]);}
function nearest(nodes,target){let best=0,bd=Infinity;for(let i=0;i<nodes.length;i++){const d=dist(nodes[i].p,target);if(d<bd){bd=d;best=i;}}return {idx:best,d:bd};}
function shortest(graph, from, to){if(from===to)return{path:[from],m:0};const D=new Map([[from,0]]),P=new Map(),done=new Set(),open=[[0,from]];const tgt=toLocal(graph.nodes[to]);while(open.length){let bi=0;for(let i=1;i<open.length;i++)if(open[i][0]<open[bi][0])bi=i;const[,cur]=open.splice(bi,1)[0];if(cur===to)break;if(done.has(cur))continue;done.add(cur);const cd=D.get(cur)??Infinity;for(const e of graph.adj.get(cur)??[]){const nd=cd+e.len;if(nd<(D.get(e.to)??Infinity)){D.set(e.to,nd);P.set(e.to,cur);open.push([nd+dist(toLocal(graph.nodes[e.to]),tgt),e.to]);}}}if(!P.has(to))return null;const path=[];let c=to;while(c!==undefined){path.push(c);c=P.get(c);}path.reverse();return{path,m:D.get(to)??0};}
function append(chain,graph,path){for(let i=0;i<path.length;i++){const node=graph.nodes[path[i]];if(i>0){const e=(graph.adj.get(path[i-1])??[]).find(x=>x.to===path[i]);if(e)for(const v of e.via??[])chain.push(v);}const last=chain[chain.length-1];if(!last||last[0]!==node[0]||last[1]!==node[1])chain.push(node);}}
function build(graph, pts, localNodes){const ns=[];for(const p of pts){const n=nearest(localNodes,p);if(n.d>360)return null;if(ns[ns.length-1]!==n.idx)ns.push(n.idx);}const chain=[graph.nodes[ns[0]]];let km=0,fail=0;for(let i=1;i<ns.length;i++){const leg=shortest(graph,ns[i-1],ns[i]);if(!leg){fail++;continue;}append(chain,graph,leg.path);km+=leg.m/1000;}return{chain,km,fail,ns};}
function project(points,w,h,pad=70){const xs=points.map(p=>p[0]),ys=points.map(p=>p[1]);const b={minX:Math.min(...xs),maxX:Math.max(...xs),minY:Math.min(...ys),maxY:Math.max(...ys)};const s=Math.min((w-pad*2)/(b.maxX-b.minX||1),(h-pad*2)/(b.maxY-b.minY||1));const ox=(w-(b.maxX-b.minX)*s)/2,oy=(h-(b.maxY-b.minY)*s)/2;return p=>[ox+(p[0]-b.minX)*s,oy+(b.maxY-p[1])*s];}
function d(points,pr){return points.map((p,i)=>{const q=pr(p);return`${i?'L':'M'} ${q[0].toFixed(1)} ${q[1].toFixed(1)}`}).join(' ')}
async function render(chain,file,label){const loc=chain.map(toLocal);const w=980,h=760,pr=project(loc,w,h);const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#fff"/><path d="${d(loc,pr)}" fill="none" stroke="#111" stroke-width="16" stroke-linecap="round" stroke-linejoin="round"/><text x="24" y="38" font-family="Arial" font-size="20" font-weight="700">${label}</text></svg>`;await sharp(Buffer.from(svg)).jpeg({quality:94}).toFile(file);}
function gpx(name,chain){return`<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="PaceCasso strava street search" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${name}</name><trkseg>\n${chain.map(([lat,lng])=>`<trkpt lat="${lat.toFixed(7)}" lon="${lng.toFixed(7)}"></trkpt>`).join('\n')}\n</trkseg></trk></gpx>\n`;}
async function main(){await fs.rm(outDir,{recursive:true,force:true});await fs.mkdir(outDir,{recursive:true});const graph=buildLatticeGraph(JSON.parse(await fs.readFile(path.join(root,'lib/data/manhattan-lattice.json'),'utf8')));const localNodes=graph.nodes.map((ll,i)=>({i,p:toLocal(ll)}));const results=[];let count=0;
for(const base of localNodes.filter(n=>n.p[0]>-100&&n.p[0]<4200&&n.p[1]>-2500&&n.p[1]<5200)){for(const sx of [520,680,840,1000,1200]){for(const sy of [680,850,1050,1250]){const x=base.p[0], y=base.p[1];const pts=[[x,y],[x+sx/2,y+sy],[x+sx,y],[x+sx*0.78,y],[x+sx/2,y+sy*0.46],[x+sx*0.22,y],[x,y],[x+sx,y-sy*0.12],[x+sx*0.74,y-sy*0.12],[x+sx/2,y-sy*0.72],[x+sx*0.26,y-sy*0.12],[x,y-sy*0.12]];const r=build(graph,pts,localNodes);if(!r||r.fail)continue;if(r.km<4||r.km>18)continue;const loc=r.chain.map(toLocal);const xs=loc.map(p=>p[0]),ys=loc.map(p=>p[1]);const w=Math.max(...xs)-Math.min(...xs),h=Math.max(...ys)-Math.min(...ys);const score=Math.abs(w/h-0.75)*50+Math.abs(r.km-9)*0.4;results.push({...r,score,base:base.i,sx,sy});}}}
results.sort((a,b)=>a.score-b.score);const summary=[];for(const r of results.slice(0,24)){const id=`cand-${String(++count).padStart(2,'0')}`;const img=path.join(outDir,`${id}.jpg`);await render(r.chain,img,`${id} ${r.km.toFixed(1)} km`);await fs.writeFile(path.join(outDir,`${id}.gpx`),gpx(id,r.chain));summary.push({id,km:+r.km.toFixed(2),score:+r.score.toFixed(2),image:path.relative(root,img).replace(/\\/g,'/')});}
await fs.writeFile(path.join(outDir,'summary.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify(summary,null,2));}
main().catch(e=>{console.error(e);process.exit(1)});
