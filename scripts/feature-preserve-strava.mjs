import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const sharp = require("sharp");
const jiti = require("jiti")(import.meta.url);
const { buildLatticeGraph } = jiti("../lib/latticeCompiler.ts");
const root = process.cwd();
const outDir = path.join(root, "tmp-logo-proof", "feature-preserve-strava");
const M_PER_LAT = 111320;
const origin = [40.748, -73.994];
const X = { e: Math.sin(119*Math.PI/180), n: Math.cos(119*Math.PI/180) };
const Y = { e: Math.sin(29*Math.PI/180), n: Math.cos(29*Math.PI/180) };
function toLatLng([x,y]) { const e=x*X.e+y*Y.e, n=x*X.n+y*Y.n; const m=M_PER_LAT*Math.cos(origin[0]*Math.PI/180); return [origin[0]+n/M_PER_LAT, origin[1]+e/m]; }
function toLocal([lat,lng]) { const m=M_PER_LAT*Math.cos(origin[0]*Math.PI/180); const n=(lat-origin[0])*M_PER_LAT, e=(lng-origin[1])*m; const det=X.e*Y.n-Y.e*X.n; return [(e*Y.n-Y.e*n)/det,(X.e*n-e*X.n)/det]; }
function dist(a,b){return Math.hypot(a[0]-b[0],a[1]-b[1]);}
function nearest(graph, ll) { const p=toLocal(ll); let best=0, bd=Infinity; for(let i=0;i<graph.nodes.length;i++){const d=dist(toLocal(graph.nodes[i]),p); if(d<bd){bd=d; best=i;}} return best; }
function shortest(graph, from, to) { if(from===to) return {path:[from],m:0}; const distM=new Map([[from,0]]), prev=new Map(), done=new Set(), open=[[0,from]]; const target=toLocal(graph.nodes[to]); while(open.length){let bi=0; for(let i=1;i<open.length;i++) if(open[i][0]<open[bi][0]) bi=i; const [,cur]=open.splice(bi,1)[0]; if(cur===to) break; if(done.has(cur)) continue; done.add(cur); const cd=distM.get(cur)??Infinity; for(const e of graph.adj.get(cur)??[]){const nd=cd+e.len; if(nd<(distM.get(e.to)??Infinity)){distM.set(e.to,nd); prev.set(e.to,cur); open.push([nd+dist(toLocal(graph.nodes[e.to]),target),e.to]);}} } if(!prev.has(to)) return null; const path=[]; let cur=to; while(cur!==undefined){path.push(cur); cur=prev.get(cur);} path.reverse(); return {path,m:distM.get(to)??0}; }
function append(chain, graph, nodes){ for(let i=0;i<nodes.length;i++){ const node=graph.nodes[nodes[i]]; if(i>0){ const from=nodes[i-1]; const e=(graph.adj.get(from)??[]).find(x=>x.to===nodes[i]); if(e) for(const v of e.via??[]) chain.push(v); } const last=chain[chain.length-1]; if(!last||last[0]!==node[0]||last[1]!==node[1]) chain.push(node); } }
function routeThrough(graph, pts){ const ns=pts.map(p=>nearest(graph,toLatLng(p))).filter((n,i,a)=>i===0||n!==a[i-1]); const chain=[graph.nodes[ns[0]]]; let m=0, failed=0; for(let i=1;i<ns.length;i++){const leg=shortest(graph,ns[i-1],ns[i]); if(!leg){failed++; continue;} append(chain,graph,leg.path); m+=leg.m;} return {chain,km:m/1000,failed,waypoints:ns.length}; }
function projectFactory(points,w,h,pad=80){const xs=points.map(p=>p[0]),ys=points.map(p=>p[1]);const b={minX:Math.min(...xs),maxX:Math.max(...xs),minY:Math.min(...ys),maxY:Math.max(...ys)};const s=Math.min((w-pad*2)/(b.maxX-b.minX),(h-pad*2)/(b.maxY-b.minY));const ox=(w-(b.maxX-b.minX)*s)/2, oy=(h-(b.maxY-b.minY)*s)/2; return ([x,y])=>[ox+(x-b.minX)*s,oy+(b.maxY-y)*s];}
function d(points,pr){return points.map((p,i)=>{const [x,y]=pr(p);return `${i?'L':'M'} ${x.toFixed(1)} ${y.toFixed(1)}`}).join(' ')}
async function renderBlind(chain,file,label){const loc=chain.map(toLocal);const w=1100,h=820,pr=projectFactory(loc,w,h);const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#fff"/><path d="${d(loc,pr)}" fill="none" stroke="#111" stroke-width="24" stroke-linecap="round" stroke-linejoin="round"/><text x="28" y="42" font-family="Arial" font-size="22" font-weight="700">${label}</text></svg>`; await sharp(Buffer.from(svg)).jpeg({quality:94}).toFile(file);}
async function compare(routeFile,file,metrics){const src=await sharp(path.join(root,'strava.png')).resize(680,560,{fit:'contain',background:'#fff'}).png().toBuffer(); const rte=await sharp(routeFile).resize(680,560,{fit:'contain',background:'#fff'}).png().toBuffer(); const base=Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1500" height="760"><rect width="100%" height="100%" fill="#f8f5ef"/><text x="40" y="46" font-family="Arial" font-size="28" font-weight="700">Strava feature-preserving route</text><text x="40" y="78" font-family="Arial" font-size="16" fill="#555">${metrics}</text><text x="40" y="705" font-family="Arial" font-size="15" fill="#555">source</text><text x="790" y="705" font-family="Arial" font-size="15" fill="#555">route</text></svg>`); await sharp(base).composite([{input:src,left:40,top:110},{input:rte,left:790,top:110}]).jpeg({quality:94}).toFile(file);}
function gpx(name,chain){return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="PaceCasso feature preserve" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${name}</name><trkseg>\n${chain.map(([lat,lng])=>`<trkpt lat="${lat.toFixed(7)}" lon="${lng.toFixed(7)}"></trkpt>`).join('\n')}\n</trkseg></trk></gpx>\n`;}
async function main(){await fs.rm(outDir,{recursive:true,force:true}); await fs.mkdir(outDir,{recursive:true}); const graph=buildLatticeGraph(JSON.parse(await fs.readFile(path.join(root,'lib/data/manhattan-lattice.json'),'utf8')));
 const variants=[
  {id:'centerline-clean', pts:[[0,0],[460,980],[920,0],[705,0],[460,520],[215,0],[0,0],[920,-120],[690,-120],[460,-620],[230,-120],[0,-120]]},
  {id:'two-chevron', pts:[[0,0],[360,760],[720,0],[560,0],[360,430],[160,0],[0,0],[720,-90],[540,-90],[360,-500],[180,-90],[0,-90]]},
  {id:'big-symbol', pts:[[0,0],[520,1160],[1040,0],[800,0],[520,650],[240,0],[0,0],[1040,-160],[780,-160],[520,-780],[260,-160],[0,-160]]},
 ];
 const summary=[]; for(const v of variants){const shifted=v.pts.map(([x,y])=>[x+1700,y+1800]); const r=routeThrough(graph,shifted); const blind=path.join(outDir,`${v.id}-blind.jpg`); await renderBlind(r.chain,blind,`${v.id} ${r.km.toFixed(1)} km`); await compare(blind,path.join(outDir,`${v.id}-compare.jpg`),`${r.km.toFixed(1)} km, ${r.waypoints} named feature waypoints, failed legs ${r.failed}`); await fs.writeFile(path.join(outDir,`${v.id}.gpx`),gpx(v.id,r.chain)); summary.push({id:v.id,km:+r.km.toFixed(2),failed:r.failed,compare:path.relative(root,path.join(outDir,`${v.id}-compare.jpg`)).replace(/\\/g,'/')}); }
 await fs.writeFile(path.join(outDir,'summary.json'),JSON.stringify(summary,null,2)); console.log(JSON.stringify(summary,null,2));}
main().catch(e=>{console.error(e);process.exit(1)});
