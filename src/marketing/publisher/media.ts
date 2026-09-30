import type { Pool } from 'pg';
import sharp from 'sharp';
import type { z } from 'zod';
import { publisherConfig } from './config.js';
import { PublisherError, type Environment, type uploadSchema, type finalizeSchema } from './model.js';
import { PublisherStorage } from './storage.js';

export interface Media {
  id:string; name:string; kind:'photo'|'video'; mime:string; bytes:string; status:string;
  original_path:string; publish_path:string|null; thumbnail_path:string|null;
  width:number|null; height:number|null; duration:string|null;
}
export async function reserveMedia(pool:Pool, environment:Environment, data:z.infer<typeof uploadSchema>, actor:string, storage=new PublisherStorage()) {
  const config=publisherConfig();
  const kind=data.mime.startsWith('image/')?'photo':'video';
  if(data.bytes>config.max_file_bytes || kind==='photo' && data.bytes>8*1024*1024) throw new PublisherError('publisher_media_too_large',413);
  await storage.assertPrivateBucket();
  const client=await pool.connect();
  const extension:Record<string,string>={'image/jpeg':'jpg','image/png':'png','image/webp':'webp','video/mp4':'mp4','video/quicktime':'mov'};
  const path=`${environment}/${data.id}/original.${extension[data.mime]}`;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`publisher-library:${environment}`]);
    const existing=await client.query<Media>('SELECT * FROM ops.publisher_media WHERE environment=$1 AND id=$2 FOR UPDATE',[environment,data.id]);
    const prior=existing.rows[0];
    if(prior && (prior.status!=='uploading' || prior.mime!==data.mime || Number(prior.bytes)!==data.bytes)) throw new PublisherError('publisher_upload_conflict');
    if(!prior) {
      const usage=await client.query<{bytes:string}>(`SELECT coalesce(sum(bytes+262144+CASE WHEN kind='photo' THEN 8388608 ELSE 0 END),0)::text bytes FROM ops.publisher_media
        WHERE environment=$1 AND status IN ('uploading','ready','deleting')`,[environment]);
      // Reserva inclui conversões JPEG e miniatura, para não ultrapassar o limite durante uploads simultâneos.
      if(Number(usage.rows[0]?.bytes)+data.bytes+262144+(kind==='photo'?8*1024*1024:0)>config.library_limit_bytes) throw new PublisherError('publisher_library_full',413);
      await client.query(`INSERT INTO ops.publisher_media(environment,id,name,kind,mime,bytes,original_path,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[environment,data.id,data.name,kind,data.mime,data.bytes,path,actor]);
    }
    const upload_url=await storage.uploadUrl(path);
    await client.query('COMMIT');return {id:data.id,upload_url};
  } catch(error){await client.query('ROLLBACK');throw error;} finally{client.release();}
}
export function validVideoHeader(buffer:Buffer):boolean {return buffer.length>=12 && buffer.subarray(4,8).toString()==='ftyp';}
export async function finalizeMedia(pool:Pool, environment:Environment, id:string, data:z.infer<typeof finalizeSchema>, storage=new PublisherStorage()) {
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const media=(await client.query<Media>('SELECT * FROM ops.publisher_media WHERE environment=$1 AND id=$2 FOR UPDATE',[environment,id])).rows[0];
    if(!media)throw new PublisherError('publisher_media_not_found',404);
    if(media.status==='ready'){await client.query('COMMIT');return {id};}
    if(media.status!=='uploading')throw new PublisherError('publisher_upload_conflict');
    const info=await storage.info(media.original_path);
    if(info.bytes!==Number(media.bytes) || info.mime!==media.mime)throw new PublisherError('publisher_upload_mismatch',400);
    let publishPath=media.original_path;
    let thumb:Buffer;let width=data.width;let height=data.height;
    if(media.kind==='photo') {
      const image=await storage.read(media.original_path,8*1024*1024);
      const processor=sharp(image,{limitInputPixels:40_000_000}).rotate();
      const meta=await processor.metadata();
      if(!['jpeg','png','webp'].includes(meta.format??''))throw new PublisherError('publisher_media_invalid',400);
      const jpeg=await processor.clone().resize({width:1440,height:2560,fit:'inside',withoutEnlargement:true}).jpeg({quality:90}).toBuffer({resolveWithObject:true});
      width=jpeg.info.width;height=jpeg.info.height;publishPath=`${environment}/${id}/publish.jpg`;
      await storage.put(publishPath,jpeg.data);
      thumb=await processor.clone().resize(400,400,{fit:'inside',withoutEnlargement:true}).jpeg({quality:72}).toBuffer();
    } else {
      if(!data.duration || !validVideoHeader(await storage.read(media.original_path,32,true)))throw new PublisherError('publisher_media_invalid',400);
      if(!data.thumbnail || !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(data.thumbnail))throw new PublisherError('publisher_thumbnail_required',400);
      thumb=await sharp(Buffer.from(data.thumbnail.split(',')[1]!,'base64'),{limitInputPixels:2_000_000}).resize(400,400,{fit:'inside'}).jpeg({quality:72}).toBuffer();
    }
    const thumbnail=`${environment}/${id}/thumbnail.jpg`;await storage.put(thumbnail,thumb);
    await client.query(`UPDATE ops.publisher_media SET status='ready',publish_path=$3,thumbnail_path=$4,width=$5,height=$6,duration=$7
      WHERE environment=$1 AND id=$2`,[environment,id,publishPath,thumbnail,width,height,media.kind==='video'?data.duration:null]);
    await client.query('COMMIT');return {id};
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
export async function listMedia(pool:Pool,environment:Environment,storage=new PublisherStorage()) {
  const media=(await pool.query<Media>(`SELECT id,name,kind,mime,bytes,status,original_path,publish_path,thumbnail_path,width,height,duration
    FROM ops.publisher_media WHERE environment=$1 AND status='ready' ORDER BY created_at DESC LIMIT 100`,[environment])).rows;
  return Promise.all(media.map(async ({original_path,publish_path,thumbnail_path,...m})=>({...m,
    thumbnail_url:thumbnail_path?await storage.signedUrl(thumbnail_path):null})));
}
