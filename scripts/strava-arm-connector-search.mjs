import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const sharp = require("sharp");
const jiti = require("jiti")(import.meta.url);
const { buildLatticeGraph } = jiti("../lib/latticeCompiler.ts");
const root=process.cwd();
const outDir=path.join(root,"tmp-logo-proof","strava-arm-connector-search");
const M=111320, origin=[40.748,-73.994];
const X={e:Math.sin(119*Math.PI/180),n:Math.cos(119*Math.PI/180)},Y={e:Math.sin(29*Math.PI/180),n:Math.cos(29*Math.PI/180)};
function toLocal([lat,lng]){const m=M*Math.cos(origin[0]*Math.PI/180),n=(lat-origin[0])*M,e=(lng-origin[1])*m,det=X.e*Y.n-Y.e*X.n;return[(e*Y.n-Y.e*n)/det,(X.e*n-e*X.n)/det]}
function dist(a,b){return Math.hypot(a[0]-b[0],a[1]-b[1])}
function ang(a,b){return Math.atan2(b[1]-a[1],b[0]-a[0])}
function normAng(a){while(a<=-Math.PI)a+=Math.PI*2;while(a>Math.PI)a-=Math.PI*2;return a}
function shortest(graph,from,to,maxVisit=4500){if(from===to)return{nodes:[from],m:0};const D=new Map([[from,0]]),P=new Map(),done=new Set(),open=[[0,from]],t=toLocal(graph.nodes[to]);while(open.length&&done.size<maxVisit){let bi=0;for(let i=1;i<open.length;i++)if(open[i][0]<open[bi][0])bi=i;const[,cur]=open.splice(bi,1)[0];if(cur===to)break;if(done.has(cur))continue;done.add(cur);const cd=D.get(cur)??Infinity;for(const e of graph.adj.get(cur)??[]){const nd=cd+e.len;if(nd<(D.get(e.to)??Infinity)){D.set(e.to,nd);P.set(e.to,cur);open.push([nd+dist(toLocal(graph.nodes[e.to]),t),e.to])}}}if(!P.has(to))return null;const nodes=[];let c=to;while(c!==undefined){nodes.push(c);c=P.get(c)}nodes.reverse();return{nodes,m:D.get(to)??0}}
function append(chain,graph,nodes){for(let i=1;i<nodes.length;i++){const a=nodes[i-1],b=nodes[i],edge=(graph.adj.get(a)??[]).find(x=>x.to===b),nodeA=graph.nodes[a],last=chain[chain.length-1];if(!last||last[0]!==nodeA[0]||last[1]!==nodeA[1])chain.push(nodeA);if(edge)for(const v of edge.via??[])chain.push(v);chain.push(graph.nodes[b])}}
function pathKm(chain){let m=0;for(let i=1;i<chain.length;i++)m+=dist(toLocal(chain[i-1]),toLocal(chain[i]));return m/1000}
function bounds(ps){const xs=ps.map(p=>p[0]),ys=ps.map(p=>p[1]);return{minX:Math.min(...xs),maxX:Math.max(...xs),minY:Math.min(...ys),maxY:Math.max(...ys)}}
function project(ps,w,h,pad=70){const b=bounds(ps),s=Math.min((w-pad*2)/(b.maxX-b.minX||1),(h-pad*2)/(b.maxY-b.minY||1)),ox=(w-(b.maxX-b.minX)*s)/2,oy=(h-(b.maxY-b.minY)*s)/2;return p=>[ox+(p[0]-b.minX)*s,oy+(b.maxY-p[1])*s]}
function d(ps,pr){return ps.map((p,i)=>{const q=pr(p);return`${i?'L':'M'} ${q[0].toFixed(1)} ${q[1].toFixed(1)}`}).join(' ')}
async function render(chain,file,label){const loc=chain.map(toLocal),w=980,h=760,pr=project(loc,w,h);const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#fff"/><path d="${d(loc,pr)}" fill="none" stroke="#111" stroke-width="18" stroke-linecap="round" stroke-linejoin="round"/><text x="24" y="38" font-family="Arial" font-size="20" font-weight="700">${label}</text></svg>`;await sharp(Buffer.from(svg)).jpeg({quality:94}).toFile(file)}
function gpx(name,chain){return`<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="PaceCasso arm motif search" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${name}</name><trkseg>\n${chain.map(([lat,lng])=>`<trkpt lat="${lat.toFixed(7)}" lon="${lng.toFixed(7)}"></trkpt>`).join('\n')}\n</trkseg></trk></gpx>\n`}
function lineDeviation(local,nodes,a,b){const A=local[a],B=local[b],vx=B[0]-A[0],vy=B[1]-A[1],len=Math.hypot(vx,vy)||1;let sum=0,max=0;for(const n of nodes){const P=local[n],dev=Math.abs((P[0]-A[0])*vy-(P[1]-A[1])*vx)/len;sum+=dev;max=Math.max(max,dev)}return{mean:sum/nodes.length,max}}
function makeArms(graph,local){const armsByApex=new Map();const nodes=local.map((p,i)=>({i,p})).filter(n=>n.p[0]>-500&&n.p[0]<4700&&n.p[1]>-3600&&n.p[1]<6200);let checked=0;for(let ai=0;ai<nodes.length;ai+=2){const apex=nodes[ai];const near=nodes.filter(n=>{const dd=dist(apex.p,n.p);return dd>420&&dd<1850&&Math.abs(n.p[0]-apex.p[0])>160&&Math.abs(n.p[1]-apex.p[1])>220}).sort((a,b)=>dist(apex.p,a.p)-dist(apex.p,b.p)).slice(0,90);for(const end of near){checked++;const leg=shortest(graph,apex.i,end.i,1800);if(!leg)continue;const chord=dist(apex.p,end.p);if(leg.m/chord>1.42)continue;const dev=lineDeviation(local,leg.nodes,apex.i,end.i);if(dev.mean>115||dev.max>330)continue;const theta=ang(apex.p,end.p);const arm={apex:apex.i,end:end.i,nodes:leg.nodes,m:leg.m,chord,theta,down:end.p[1]<apex.p[1],score:(leg.m/chord-1)*8+dev.mean/80};if(!armsByApex.has(apex.i))armsByApex.set(apex.i,[]);armsByApex.get(apex.i).push(arm)}}return armsByApex}
function composeOptions(graph,u,l,local){
 const opts=[];
 const upperOrders=[[u.a,u.b],[u.b,u.a]];
 const lowerOrders=[[l.a,l.b],[l.b,l.a]];
 for(const [ua,ub] of upperOrders) for(const [la,lb] of lowerOrders){
  const conn=shortest(graph,ub.end,la.end,2600); if(!conn) continue;
  const chain=[graph.nodes[ua.end]];
  append(chain,graph,[...ua.nodes].reverse());
  append(chain,graph,ub.nodes);
  append(chain,graph,conn.nodes);
  append(chain,graph,[...la.nodes].reverse());
  append(chain,graph,lb.nodes);
  opts.push({chain,connM:conn.m});
 }
 return opts;
}
function candidateScore(chain,local){const pts=chain.map(ll=>toLocal(ll)),b=bounds(pts),w=b.maxX-b.minX,h=b.maxY-b.minY,aspect=w/Math.max(1,h);let horiz=0,vert=0,total=0;for(let i=1;i<pts.length;i++){const dx=Math.abs(pts[i][0]-pts[i-1][0]),dy=Math.abs(pts[i][1]-pts[i-1][1]),l=Math.hypot(dx,dy);total+=l;if(dy<dx*.25)horiz+=l;if(dx<dy*.25)vert+=l}return 80-Math.abs(aspect-.75)*24-Math.max(0,horiz/Math.max(1,total)-.28)*55-Math.max(0,vert/Math.max(1,total)-.5)*35}
async function main(){await fs.rm(outDir,{recursive:true,force:true});await fs.mkdir(outDir,{recursive:true});const graph=buildLatticeGraph(JSON.parse(await fs.readFile(path.join(root,'lib/data/manhattan-lattice.json'),'utf8')));const local=graph.nodes.map(toLocal);console.log('building arms');const byApex=makeArms(graph,local);console.log('apexes',byApex.size);const uppers=[],lowers=[];for(const [apex,arms] of byApex){const down=arms.filter(a=>a.down);const up=arms.filter(a=>!a.down);for(let i=0;i<down.length;i++)for(let j=i+1;j<down.length;j++){const a=down[i],b=down[j],da=normAng(a.theta),db=normAng(b.theta);if(Math.sign(Math.cos(da))===Math.sign(Math.cos(db)))continue;const open=Math.abs(normAng(da-db));if(open<.65||open>2.45)continue;uppers.push({apex,a,b,score:a.score+b.score,center:local[apex],width:dist(local[a.end],local[b.end]),height:(local[apex][1]-(local[a.end][1]+local[b.end][1])/2)})}for(let i=0;i<up.length;i++)for(let j=i+1;j<up.length;j++){const a=up[i],b=up[j],da=normAng(a.theta),db=normAng(b.theta);if(Math.sign(Math.cos(da))===Math.sign(Math.cos(db)))continue;const open=Math.abs(normAng(da-db));if(open<.65||open>2.45)continue;lowers.push({apex,a,b,score:a.score+b.score,center:local[apex],width:dist(local[a.end],local[b.end]),height:((local[a.end][1]+local[b.end][1])/2-local[apex][1])})}}
uppers.sort((a,b)=>a.score-b.score);lowers.sort((a,b)=>a.score-b.score);const cands=[];for(const u of uppers.slice(0,1200))for(const l of lowers.slice(0,1200)){const dx=Math.abs(u.center[0]-l.center[0]);const dy=u.center[1]-l.center[1];if(dx>Math.max(420,u.width*.9))continue;if(dy<260||dy>1800)continue;if(l.width/u.width<.35||l.width/u.width>1.05)continue;for(const opt of composeOptions(graph,u,l,local)){const chain=opt.chain;const km=pathKm(chain);if(km<4||km>24)continue;const connPenalty=Math.max(0,(opt.connM-450)/130);const score=candidateScore(chain,local)-u.score-l.score-Math.abs(km-10)*.45-dx/240-connPenalty; cands.push({chain,km,score,u,l,connM:opt.connM})}}
cands.sort((a,b)=>b.score-a.score);const summary=[];let n=0;for(const c of cands.slice(0,40)){const id=`arm-${String(++n).padStart(2,'0')}`;const img=path.join(outDir,`${id}.jpg`);await render(c.chain,img,`${id} ${c.km.toFixed(1)} km s${c.score.toFixed(1)}`);await fs.writeFile(path.join(outDir,`${id}.gpx`),gpx(id,c.chain));summary.push({id,km:+c.km.toFixed(2),score:+c.score.toFixed(2),image:path.relative(root,img).replace(/\\/g,'/')})}await fs.writeFile(path.join(outDir,'summary.json'),JSON.stringify({uppers:uppers.length,lowers:lowers.length,candidates:cands.length,summary},null,2));console.log(JSON.stringify({uppers:uppers.length,lowers:lowers.length,candidates:cands.length,best:summary[0],outDir:path.relative(root,outDir)},null,2))}
main().catch(e=>{console.error(e);process.exit(1)})
