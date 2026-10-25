import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,unlinkSync,rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe,it,expect} from 'vitest';
import sharp from 'sharp';
import {catalogWatermark} from '../../../src/catalog-photos/watermark.js';

describe('marca 2W no servidor sem fontes',()=>{
 it('continua legível sem fontes instaladas, com tamanho e contraste proporcionais',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'farejador-watermark-')),config=join(directory,'fonts.conf');
  writeFileSync(config,'<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><dir>'+directory.replaceAll('\\','/')+'/no-fonts</dir></fontconfig>');
  try{
   const png=execFileSync(process.execPath,['-e',"require('sharp')(require('node:fs').readFileSync(0)).png().toBuffer().then(b=>process.stdout.write(b)).catch(()=>process.exit(1))"],
    {input:catalogWatermark(228),env:{...process.env,FONTCONFIG_FILE:config,FONTCONFIG_PATH:directory},timeout:10000});
   const {data,info}=await sharp(png).ensureAlpha().raw().toBuffer({resolveWithObject:true});
   expect(info).toMatchObject({width:228,height:125,channels:4});
   let visible=0,minX=info.width,maxX=0,minY=info.height,maxY=0;
   for(let y=0;y<info.height;y++)for(let x=0;x<info.width;x++){
    const offset=(y*info.width+x)*4;
    if(data[offset+3]!>100&&data[offset]!>180&&data[offset+1]!>180&&data[offset+2]!>180){
     visible++;minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);
    }
   }
   expect(visible).toBeGreaterThan(3500);expect(maxX-minX).toBeGreaterThan(170);expect(maxY-minY).toBeGreaterThan(85);
  }finally{unlinkSync(config);rmdirSync(directory);}
 });
});
