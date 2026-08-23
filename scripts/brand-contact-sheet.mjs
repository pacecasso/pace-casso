import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
const require=createRequire(import.meta.url);
const sharp=require("sharp");
const root=process.cwd();
const base=path.join(root,"tmp-logo-proof","brand-block-multistroke");
const logos=['nike','chanel','stones'];
const comps=[];
let i=0;
for(const logo of logos){
  const file=path.join(base,logo,'candidate-sheet.jpg');
  const input=await sharp(file).resize(640,900,{fit:'contain',background:'#fff'}).jpeg({quality:92}).toBuffer();
  comps.push({input,left:i*640,top:0});
  i++;
}
await sharp({create:{width:1920,height:900,channels:3,background:'#fff'}}).composite(comps).jpeg({quality:92}).toFile(path.join(base,'nike-chanel-stones-contact.jpg'));
console.log(path.relative(root,path.join(base,'nike-chanel-stones-contact.jpg')).replace(/\\/g,'/'));
