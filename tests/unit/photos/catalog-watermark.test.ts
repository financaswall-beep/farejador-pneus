import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,unlinkSync,rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe,it,expect} from 'vitest';
import sharp from 'sharp';
import {catalogWatermark,catalogWatermarkPlacement} from '../../../src/catalog-photos/watermark.js';

describe('marca 2W no servidor sem fontes',()=>{
 it.each([220,480])('preserva logo, WhatsApp e telefone sem fontes instaladas em %s px',async(width)=>{
  const directory=mkdtempSync(join(tmpdir(),'farejador-watermark-')),config=join(directory,'fonts.conf');
  writeFileSync(config,'<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><dir>'+directory.replaceAll('\\','/')+'/no-fonts</dir></fontconfig>');
  try{
   const png=execFileSync(process.execPath,['-e',"require('sharp')(require('node:fs').readFileSync(0)).png().toBuffer().then(b=>process.stdout.write(b)).catch(()=>process.exit(1))"],
    {input:catalogWatermark(width),env:{...process.env,FONTCONFIG_FILE:config,FONTCONFIG_PATH:directory},timeout:10000});
   const {data,info}=await sharp(png).ensureAlpha().raw().toBuffer({resolveWithObject:true});
   expect(info).toMatchObject({width,height:Math.round(width*.22),channels:4});
   for(const [start,end,minimum] of [[.04,.24,.4],[.3,.4,.15],[.42,.95,.7]] as const){
    let visible=0,minX=width,maxX=0;
    for(let y=0;y<info.height;y++)for(let x=Math.floor(width*start!);x<width*end!;x++){
     const offset=(y*info.width+x)*4;
     if(data[offset+3]!>200&&data[offset]!>210&&data[offset+1]!>210&&data[offset+2]!>210){
      visible++;minX=Math.min(minX,x);maxX=Math.max(maxX,x);
     }
    }
    expect(visible).toBeGreaterThan(width*minimum!);
    expect(maxX-minX).toBeGreaterThan(width*(end!-start!)*.6);
   }
  }finally{unlinkSync(config);rmdirSync(directory);}
 });
 it.each([[200,200],[360,480],[480,360],[1600,900],[1600,200],[1280,64]])('mantém a assinatura inteira e afastada das bordas em %s × %s',async(width,height)=>{
  const placement=catalogWatermarkPlacement(width,height);
  const mark=await sharp(catalogWatermark(placement.width)).metadata();
  expect(mark.width).toBeLessThanOrEqual(width-16);expect(mark.height).toBe(placement.height);
  expect(mark.height).toBeLessThanOrEqual(height*.21);
  expect(placement.left).toBeGreaterThanOrEqual(8);expect(placement.top).toBeGreaterThanOrEqual(8);
  expect(width-placement.left-mark.width!).toBeGreaterThanOrEqual(8);
  expect(height-placement.top-mark.height!).toBeGreaterThanOrEqual(8);
 });
});
