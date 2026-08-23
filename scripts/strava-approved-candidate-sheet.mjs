import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
const require=createRequire(import.meta.url);
const sharp=require("sharp");
const root=process.cwd();
const outDir=path.join(root,"tmp-logo-proof","strava-single-run-from-block");
async function main(){
 const source=await sharp(path.join(root,"strava.png")).resize(560,560,{fit:"contain",background:"#fff"}).jpeg().toBuffer();
 const route=await sharp(path.join(outDir,"strava-single-run-visible-connector.jpg")).resize(700,560,{fit:"contain",background:"#fff"}).jpeg().toBuffer();
 const base=Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1360" height="720"><rect width="100%" height="100%" fill="#f8f5ef"/><text x="34" y="42" font-family="Arial" font-size="26" font-weight="700">Strava one-run candidate - source vs route</text><text x="34" y="74" font-family="Arial" font-size="16" fill="#555">One continuous GPX track, 20.9 km, visible 0.08 km connector. This is a candidate, not marked approved.</text><text x="34" y="668" font-family="Arial" font-size="15" fill="#555">uploaded source</text><text x="660" y="668" font-family="Arial" font-size="15" fill="#555">generated route preview</text></svg>`);
 await sharp(base).composite([{input:source,left:34,top:96},{input:route,left:660,top:96}]).jpeg({quality:94}).toFile(path.join(outDir,"source-vs-single-run-candidate.jpg"));
 console.log(path.relative(root,path.join(outDir,"source-vs-single-run-candidate.jpg")).replace(/\\/g,"/"));
}
main().catch(e=>{console.error(e);process.exit(1)});