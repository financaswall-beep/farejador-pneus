import sharp from 'sharp';
import { sniffImageMime } from '../parceiro/photo-upload.js';
import { CatalogPhotoError } from './model.js';
import { MAX_CATALOG_PHOTO_BYTES } from './storage.js';
import { catalogWatermark } from './watermark.js';
let activeCodecs=0;
/** Sanitized original + branded derivative. Never fabricates a tire or another angle. */
export async function prepareCatalogPhoto(input:Buffer){
 if(input.length>MAX_CATALOG_PHOTO_BYTES)throw new CatalogPhotoError('photo_too_large',413);
 if(!sniffImageMime(input))throw new CatalogPhotoError('not_an_image',415);
 if(activeCodecs>=2)throw new CatalogPhotoError('photo_processing_busy',429);
 activeCodecs++;
 try{
  const original=await sharp(input,{limitInputPixels:30_000_000,animated:false}).rotate()
   .flatten({background:'#f6f7f8'}).resize({width:1600,height:1600,fit:'inside',withoutEnlargement:true})
   .webp({quality:86}).toBuffer({resolveWithObject:true});
  if(original.info.width<200||original.info.height<200)throw new Error('small');
  const width=Math.min(260,Math.max(80,Math.round(original.info.width*0.19)));
  const mark=catalogWatermark(width);
  const photo=await sharp(original.data).composite([{input:mark,gravity:'southeast'}]).webp({quality:84}).toBuffer();
  return {original:original.data,photo,width:original.info.width,height:original.info.height};
 }catch{throw new CatalogPhotoError('invalid_or_small_photo',415);}finally{activeCodecs--;}
}
