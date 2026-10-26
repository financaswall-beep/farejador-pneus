import { describe,expect,it,vi } from 'vitest';
import { access,readFile,writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import sharp from 'sharp';
Object.assign(process.env,{NODE_ENV:'test',FAREJADOR_ENV:'test',DATABASE_URL:'postgres://test',CHATWOOT_HMAC_SECRET:'test',ADMIN_AUTH_TOKEN:'test'});
const {prepareCatalogVideo,MAX_CATALOG_VIDEO_UPLOAD}=await import('../../../src/catalog-photos/video-codec.js');
const input=Buffer.concat([Buffer.alloc(4),Buffer.from('ftyp'),Buffer.alloc(24)]);
function probe(width=1920,height=1080,duration=15,codec='h264'){
 return Buffer.from(JSON.stringify({streams:[{codec_type:'video',codec_name:codec,width,height,avg_frame_rate:'30/1'}],format:{duration:String(duration)}}));
}
describe('vídeo do catálogo: limites, marca e arquivo final único',()=>{
 it('processa em diretório temporário, com marca 2W, MP4 limitado e sem original persistente',async()=>{
  let probes=0,output='';
  const runner=vi.fn(async(program:string,args:string[])=>{
   if(program==='ffprobe')return ++probes===1?probe():probe(1280,720);
   output=args.at(-1)!;
   const logo=args[args.indexOf('-filter_complex_threads')-1]!;
   expect((await readFile(logo)).subarray(1,4).toString()).toBe('PNG');
   await writeFile(output,'final-video');return Buffer.alloc(0);
  });
  const result=await prepareCatalogVideo(input,runner as never);
  expect(result).toMatchObject({width:1280,height:720,duration:15});expect(result.video.toString()).toBe('final-video');
  expect(result).not.toHaveProperty('original');
  const encode=runner.mock.calls.find(call=>call[0]==='ffmpeg')![1];
  expect(encode).toEqual(expect.arrayContaining(['libx264','aac','2200k','+faststart','-map_metadata','-1']));
  expect(encode.join(' ')).toMatch(/overlay=main_w-overlay_w-[1-9]\d*:main_h-overlay_h-[1-9]\d*/);
  const first=runner.mock.calls[0][1];expect(first[first.indexOf('-protocol_whitelist')+1]).toBe('file');
  expect(first).toEqual(expect.arrayContaining(['-enable_drefs','0','-use_absolute_path']));
  await expect(access(dirname(output))).rejects.toBeDefined();
 });
 it('recusa dados arbitrários, arquivo grande e duração excessiva antes de codificar',async()=>{
  const runner=vi.fn(async()=>probe(1920,1080,16));
  await expect(prepareCatalogVideo(Buffer.from('#EXTM3U\nhttps://external.example/media'),runner)).rejects.toMatchObject({code:'video_invalid'});
  await expect(prepareCatalogVideo(Buffer.alloc(MAX_CATALOG_VIDEO_UPLOAD+1),runner)).rejects.toMatchObject({code:'video_too_large'});
  expect(runner).not.toHaveBeenCalled();
  await expect(prepareCatalogVideo(input,runner)).rejects.toMatchObject({code:'video_too_long'});
  expect(runner).toHaveBeenCalledTimes(1);
 });
 it.each([[90,'cclock'],[-90,'clock']])('preserva a rotação %s do celular sem copiar a orientação antiga',async(rotation,transpose)=>{
  let probes=0;const runner=vi.fn(async(program:string,args:string[])=>{
   if(program==='ffprobe'){
    if(++probes===2)return probe(720,1280,3);
    const data=JSON.parse(probe(1920,1080,3).toString());data.streams[0].side_data_list=[{rotation}];return Buffer.from(JSON.stringify(data));
   }
   expect(args).toContain('-noautorotate');expect(args).toContain('-display_rotation:v:0');
   expect(args[args.indexOf('-filter_complex')+1]).toContain('transpose='+transpose);
   const mark=await sharp(await readFile(args[args.indexOf('-filter_complex_threads')-1]!)).metadata();
   expect(mark.width).toBeGreaterThan(200);expect(mark.width).toBeLessThan(300);
   await writeFile(args.at(-1)!,'rotated');return Buffer.alloc(0);
  });
  expect(await prepareCatalogVideo(input,runner as never)).toMatchObject({width:720,height:1280,duration:3});
 });
 it('recusa resolução acima de 4K e remove o temporário mesmo se o encoder falhar',async()=>{
  await expect(prepareCatalogVideo(input,vi.fn(async()=>probe(8192,8192)))).rejects.toMatchObject({code:'video_invalid'});
  let directory='';
  const runner=vi.fn(async(program:string,args:string[])=>{
   directory=dirname(args.at(-1)!);
   if(program==='ffprobe')return probe();
   throw Object.assign(new Error('timeout'),{code:'publisher_media_processing_timeout'});
  });
  await expect(prepareCatalogVideo(input,runner as never)).rejects.toMatchObject({code:'video_processing_timeout',status:503});
  await expect(access(directory)).rejects.toBeDefined();
 });
});
