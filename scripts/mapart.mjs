import fs from "node:fs/promises"; import path from "node:path"; import { createRequire } from "node:module";
const repo=process.cwd(); const sharp=createRequire(path.join(repo,"package.json"))("sharp");
const d=JSON.parse(await fs.readFile(path.join(repo,"tmp-gas-spike/osm-walk-network.json"),"utf8"));
const nodes=new Map(); for(const e of d.elements) if(e.type==="node") nodes.set(e.id,[e.lat,e.lon]);
const m=([a,b],[c,e])=>Math.hypot((c-a)*111320,(e-b)*111320*Math.cos(a*Math.PI/180));
function extractRoad(names,latMin,latMax,lonMin=-180,lonMax=180,byLat=true){
  const set=new Set(names),adj=new Map(),coord=new Map();
  const add=(a,b)=>{const ca=nodes.get(a),cb=nodes.get(b);if(!ca||!cb)return;for(const c of[ca,cb])if(c[0]<latMin||c[0]>latMax||c[1]<lonMin||c[1]>lonMax)return;coord.set(a,ca);coord.set(b,cb);const w=m(ca,cb);if(!adj.has(a))adj.set(a,[]);if(!adj.has(b))adj.set(b,[]);adj.get(a).push([b,w]);adj.get(b).push([a,w]);};
  for(const e of d.elements){if(e.type!=="way"||!set.has(e.tags?.name))continue;for(let i=1;i<e.nodes.length;i++)add(e.nodes[i-1],e.nodes[i]);}
  const ids=[...coord.keys()]; if(!ids.length)return[];
  for(let i=0;i<ids.length;i++)for(let j=i+1;j<ids.length;j++){const dd=m(coord.get(ids[i]),coord.get(ids[j]));if(dd>1&&dd<60){adj.get(ids[i]).push([ids[j],dd]);adj.get(ids[j]).push([ids[i],dd]);}}
  let a=ids[0],b=ids[0];for(const id of ids){const c=coord.get(id);if(byLat){if(c[0]<coord.get(a)[0])a=id;if(c[0]>coord.get(b)[0])b=id;}else{if(c[1]<coord.get(a)[1])a=id;if(c[1]>coord.get(b)[1])b=id;}}
  const dist=new Map([[a,0]]),prev=new Map(),done=new Set();
  while(true){let u=-1,ud=Infinity;for(const[k,v]of dist){if(!done.has(k)&&v<ud){ud=v;u=k;}}if(u===-1||u===b)break;done.add(u);for(const[v,w]of adj.get(u)||[]){if(done.has(v))continue;const nd=ud+w;if(nd<(dist.get(v)??Infinity)){dist.set(v,nd);prev.set(v,u);}}}
  const p=[];let c=b;while(c!==undefined){p.push(coord.get(c));c=prev.get(c);}p.reverse();
  const out=[];for(const q of p)if(!out.length||m(out[out.length-1],q)>8)out.push(q);return out;
}
async function render(pts,file,w=680,h=1000){
  const TILE=256;const lonX=(lo,z)=>((lo+180)/360)*TILE*2**z,latY=(la,z)=>{const r=la*Math.PI/180;return((1-Math.log(Math.tan(r)+1/Math.cos(r))/Math.PI)/2)*TILE*2**z;};
  let zoom=13;for(let z=16;z>=11;z--){const xs=pts.map(p=>lonX(p[1],z)),ys=pts.map(p=>latY(p[0],z));if(Math.max(...xs)-Math.min(...xs)<=w*0.82&&Math.max(...ys)-Math.min(...ys)<=h*0.82){zoom=z;break;}}
  const xs=pts.map(p=>lonX(p[1],zoom)),ys=pts.map(p=>latY(p[0],zoom));const vx=(Math.min(...xs)+Math.max(...xs))/2-w/2,vy=(Math.min(...ys)+Math.max(...ys))/2-h/2;
  const tiles=[];for(let tx=Math.floor(vx/TILE);tx<=Math.floor((vx+w)/TILE);tx++)for(let ty=Math.floor(vy/TILE);ty<=Math.floor((vy+h)/TILE);ty++){const r=await fetch(`https://a.basemaps.cartocdn.com/light_all/${zoom}/${tx}/${ty}@2x.png`,{headers:{"User-Agent":"dev"}});if(!r.ok)continue;tiles.push({input:await sharp(Buffer.from(await r.arrayBuffer())).resize(TILE,TILE).toBuffer(),left:Math.round(tx*TILE-vx),top:Math.round(ty*TILE-vy)});}
  const dd=pts.map((p,i)=>`${i?"L":"M"} ${(lonX(p[1],zoom)-vx).toFixed(1)} ${(latY(p[0],zoom)-vy).toFixed(1)}`).join(" ");
  const ov=Buffer.from(`<svg width="${w}" height="${h}"><path d="${dd}" fill="none" stroke="#fc5200" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`);
  await sharp({create:{width:w,height:h,channels:4,background:"#eaeaea"}}).composite([...tiles,{input:ov,left:0,top:0}]).png().toFile(path.join(repo,"tmp-trace",file));
}
// -- Riverside Drive curve --
const rd=extractRoad(["Riverside Drive"],40.775,40.820);
console.log("Riverside Drive:",rd.length,"pts",rd.length?(rd.reduce((s,p,i)=>i?s+m(rd[i-1],p):0,0)/1000).toFixed(1)+"km":"");
if(rd.length){await render(rd,"riverside.png");console.log("wrote riverside.png");}
