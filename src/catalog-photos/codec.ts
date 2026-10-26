import sharp from 'sharp';
import { sniffImageMime } from '../parceiro/photo-upload.js';
import { CatalogPhotoError } from './model.js';
import { MAX_CATALOG_PHOTO_BYTES } from './storage.js';
import { catalogWatermark,catalogWatermarkPlacement } from './watermark.js';
let activeCodecs=0;
/** Only the branded WebP is kept. Never fabricates a tire or another angle. */
export async function prepareCatalogPhoto(input:Buffer){
 if(input.length>MAX_CATALOG_PHOTO_BYTES)throw new CatalogPhotoError('photo_too_large',413);
 if(!sniffImageMime(input))throw new CatalogPhotoError('not_an_image',415);
 if(activeCodecs>=2)throw new CatalogPhotoError('photo_processing_busy',429);
 activeCodecs++;
 try{
  const image=sharp(input,{limitInputPixels:30_000_000,animated:false});
  const metadata=await image.metadata();
  const rotated=(metadata.orientation??1)>=5;
  const displayWidth=(rotated?metadata.height:metadata.width)??0,displayHeight=(rotated?metadata.width:metadata.height)??0;
  const factor=Math.min(1,1600/Math.max(displayWidth,displayHeight));
  if(Math.min(displayWidth,displayHeight)*factor<200)throw new Error('small');
  const placement=catalogWatermarkPlacement(Math.round(displayWidth*factor),Math.round(displayHeight*factor));
  const mark=catalogWatermark(placement.width);
  const photo=await image.rotate().flatten({background:'#f6f7f8'})
   .resize({width:1600,height:1600,fit:'inside',withoutEnlargement:true})
   .composite([{input:mark,left:placement.left,top:placement.top}]).webp({quality:84}).toBuffer({resolveWithObject:true});
  return {photo:photo.data,width:photo.info.width,height:photo.info.height};
 }catch{throw new CatalogPhotoError('invalid_or_small_photo',415);}finally{activeCodecs--;}
}
