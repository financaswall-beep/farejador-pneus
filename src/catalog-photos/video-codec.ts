import sharp from 'sharp';
import { mkdtemp,writeFile,readFile,stat,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve,sep } from 'node:path';
import { runMediaProgram,withMediaSlot,type ProgramRunner } from '../marketing/publisher/media-process.js';
import { parseVideoInspection } from '../marketing/publisher/media-inspection.js';
import { CatalogPhotoError } from './model.js';
import { catalogWatermark,catalogWatermarkPlacement } from './watermark.js';
export const MAX_CATALOG_VIDEO_UPLOAD=80*1024*1024;
export const MAX_CATALOG_VIDEO_BYTES=8*1024*1024;
export const MAX_CATALOG_VIDEO_SECONDS=15;
export const catalogVideoMimes=['video/mp4','video/quicktime','video/webm'];
export interface PreparedCatalogVideo {video:Buffer;width:number;height:number;duration:number}

function format(input:Buffer){
 if(input.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3])))return 'matroska';
 if(['ftyp','moov','mdat','wide'].includes(input.subarray(4,8).toString('ascii')))return 'mov';
 throw new CatalogPhotoError('video_invalid',415);
}
function safeInput(kind:string){
 return ['-protocol_whitelist','file','-f',kind,...(kind==='mov'?['-enable_drefs','0','-use_absolute_path','0']:[])];
}
function metadata(bytes:Buffer){
 try{
  const value=JSON.parse(bytes.toString());
  const video=value.streams?.find((stream:{codec_type?:string})=>stream.codec_type==='video');
  const rotation=Number(video?.side_data_list?.find((side:{rotation?:number})=>side.rotation!==undefined)?.rotation??video?.tags?.rotate??0);
  if(!Number.isFinite(rotation)||rotation%90!==0)throw new Error('rotation');
  const displayRotation=((rotation%360)+360)%360;
  return {...parseVideoInspection(value),rotation:displayRotation,
   width:Number(displayRotation%180?video.height:video.width),height:Number(displayRotation%180?video.width:video.height)};
 }
 catch{throw new CatalogPhotoError('video_invalid',415);}
}
/** Temporary originals never reach Storage. Same bounded native runner used by the publisher. */
export async function prepareCatalogVideo(input:Buffer,runner:ProgramRunner=runMediaProgram):Promise<PreparedCatalogVideo>{
 if(input.length>MAX_CATALOG_VIDEO_UPLOAD)throw new CatalogPhotoError('video_too_large',413);
 const kind=format(input);
 try{return await withMediaSlot(async()=>{
  const directory=await mkdtemp(join(tmpdir(),'matrix-catalog-video-'));
  const source=join(directory,'input.bin'),logo=join(directory,'2w.png'),output=join(directory,'video.mp4');
  const common=['-v','error','-threads','1','-max_alloc','67108864','-probesize','5242880','-analyzeduration','5000000'];
  const probe=async(path:string,container:string)=>metadata(await runner('ffprobe',[
   ...common,...safeInput(container),'-show_streams','-show_format','-of','json',path]));
  try{
   await writeFile(source,input,{mode:0o600});
   const original=await probe(source,kind);
   if(original.duration>MAX_CATALOG_VIDEO_SECONDS+.25)throw new CatalogPhotoError('video_too_long');
   if(original.width*original.height>9_437_184)throw new CatalogPhotoError('video_dimensions_too_large');
   if(Math.min(original.width,original.height)<200)throw new CatalogPhotoError('video_too_small');
   const displayWidth=original.width,displayHeight=original.height;
   const landscape=displayWidth>=displayHeight;
   const factor=Math.min(1,(landscape?1280:720)/displayWidth,(landscape?720:1280)/displayHeight);
   const placement=catalogWatermarkPlacement(Math.floor(displayWidth*factor/2)*2,Math.floor(displayHeight*factor/2)*2);
   await writeFile(logo,await sharp(catalogWatermark(placement.width)).png().toBuffer(),{mode:0o600});
   const scale="scale=w='if(gte(iw,ih),min(iw,1280),min(iw,720))':h='if(gte(iw,ih),min(ih,720),min(ih,1280))':force_original_aspect_ratio=decrease:force_divisible_by=2";
   const rotate=original.rotation===90?'transpose=cclock,':original.rotation===270?'transpose=clock,':original.rotation===180?'hflip,vflip,':'';
   await runner('ffmpeg',[...common,'-nostdin','-y',...safeInput(kind),'-noautorotate','-display_rotation:v:0','0','-i',source,'-i',logo,
    '-filter_complex_threads','1','-filter_complex',`[0:v:0]${rotate}${scale},setsar=1,fps=30[base];[base][1:v]overlay=main_w-overlay_w-${placement.inset}:main_h-overlay_h-${placement.inset}:format=auto,format=yuv420p[video]`,
    '-map','[video]','-map','0:a:0?','-t',String(MAX_CATALOG_VIDEO_SECONDS),
    '-c:v','libx264','-preset','fast','-crf','22','-maxrate','2200k','-bufsize','4400k','-threads','2',
    '-c:a','aac','-b:a','64k','-ac','1','-ar','48000',
    '-map_metadata','-1','-map_chapters','-1','-metadata:s:v:0','rotate=0','-movflags','+faststart',output]);
   const size=(await stat(output)).size;
   if(size<=0||size>MAX_CATALOG_VIDEO_BYTES)throw new CatalogPhotoError('video_output_too_large',413);
   const final=await probe(output,'mov');
   if(final.width>1280||final.height>1280||final.duration>15.25||final.inspection.video_codec!=='h264'
    ||final.inspection.audio_codec&&final.inspection.audio_codec!=='aac')throw new CatalogPhotoError('video_invalid',415);
   return {video:await readFile(output),width:final.width,height:final.height,duration:final.duration};
  }finally{
   if(resolve(directory).startsWith(resolve(tmpdir())+sep+'matrix-catalog-video-'))await rm(directory,{recursive:true,force:true});
  }
 });}catch(error){
  if(error instanceof CatalogPhotoError)throw error;
  const code=(error as {code?:string}).code;
  throw new CatalogPhotoError(code==='publisher_media_processor_missing'?'video_processor_missing':
   code==='publisher_media_processing_timeout'?'video_processing_timeout':
    code==='publisher_media_processing_busy'?'video_processing_busy':'video_invalid',
   code==='publisher_media_processing_busy'?429:code==='publisher_media_processor_missing'||code==='publisher_media_processing_timeout'?503:415);
 }
}
