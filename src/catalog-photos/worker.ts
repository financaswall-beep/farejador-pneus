import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { pool } from '../persistence/db.js';
import { env } from '../shared/config/env.js';
import { logger } from '../shared/logger.js';
import { CatalogDrive,catalogDriveStatus } from './drive.js';
import { driveAngle,CatalogPhotoError } from './model.js';
import { saveCatalogPhoto } from './repository.js';
import { CatalogPhotoStorage } from './storage.js';
import { CatalogVideoStorage } from './video-storage.js';
import { saveCatalogVideo } from './video-repository.js';
import { catalogVideoMimes } from './video-codec.js';
export async function syncOneCatalogFolder(db:Pool=pool,drive=new CatalogDrive(),storage=new CatalogPhotoStorage(),videoStorage=new CatalogVideoStorage()){
 const client=await db.connect();let committed=false;
 try{
  await client.query('BEGIN');
  const locked=(await client.query(`SELECT pg_try_advisory_xact_lock(hashtext($1)) ok`,['matrix-catalog-drive:'+env.FAREJADOR_ENV])).rows[0].ok;
  if(!locked)return;
  const binding=(await client.query(`SELECT s.* FROM commerce.matrix_photo_settings s
   JOIN commerce.products p ON p.id=s.product_id AND p.environment=s.environment AND p.deleted_at IS NULL
   WHERE s.environment=$1 AND s.drive_enabled AND s.drive_folder_id IS NOT NULL
    AND (s.drive_checked_at IS NULL OR s.drive_checked_at<now()-interval '1 minute')
   ORDER BY s.drive_checked_at NULLS FIRST,s.product_id LIMIT 1`,[env.FAREJADOR_ENV])).rows[0];
  if(!binding)return;
  let errorCode:string|null=null;
  try{
   const {files,token}=await drive.folderPhotos(binding.drive_folder_id);
   const selected=files.filter(file=>file.mimeType.startsWith('image/')).map(file=>({file,angle:driveAngle(file.name)})).filter(row=>row.angle!==null);
   const videos=files.filter(file=>catalogVideoMimes.includes(file.mimeType)&&/^video\.(mp4|mov|webm)$/i.test(file.name.normalize('NFD').replace(/[\u0300-\u036f]/g,'')));
   if(videos.length>1)throw new CatalogPhotoError('drive_duplicate_video');
   if(new Set(selected.map(row=>row.angle)).size!==selected.length)throw new CatalogPhotoError('drive_duplicate_angle');
   if(!selected.length&&!videos.length)throw new CatalogPhotoError('drive_no_named_photos');
   for(const {file,angle} of selected){
    const key=`drive:${file.id}:${file.md5Checksum}:${file.modifiedTime}:${angle}`;
    if((await client.query(`SELECT 1 FROM commerce.matrix_catalog_photos WHERE environment=$1 AND product_id=$2 AND source_key=$3`,
     [env.FAREJADOR_ENV,binding.product_id,key])).rowCount)continue;
    const bytes=await drive.download(file,token);
    if(createHash('md5').update(bytes).digest('hex')!==file.md5Checksum)throw new CatalogPhotoError('drive_photo_changed');
    await saveCatalogPhoto(db,{environment:env.FAREJADOR_ENV,productId:binding.product_id,angle:angle!,bytes,
     source:'drive',sourceKey:key,sourceFileId:file.id,actor:'Google Drive',expectedFolder:binding.drive_folder_id,expectedVersion:binding.version},storage,client);
   }
   for(const file of videos){
    const key=`drive:${file.id}:${file.md5Checksum}:${file.modifiedTime}:video`;
    if((await client.query('SELECT 1 FROM commerce.matrix_catalog_videos WHERE environment=$1 AND product_id=$2 AND source_key=$3',
     [env.FAREJADOR_ENV,binding.product_id,key])).rowCount)continue;
    const bytes=await drive.download(file,token);
    if(createHash('md5').update(bytes).digest('hex')!==file.md5Checksum)throw new CatalogPhotoError('drive_photo_changed');
    await saveCatalogVideo(db,{environment:env.FAREJADOR_ENV,productId:binding.product_id,bytes,source:'drive',sourceKey:key,
     actor:'Google Drive',expectedFolder:binding.drive_folder_id,expectedVersion:binding.version},videoStorage,undefined,client);
   }
  }catch(error){errorCode=error instanceof CatalogPhotoError?error.code:'drive_sync_failed';}
  await client.query(`UPDATE commerce.matrix_photo_settings SET drive_checked_at=now(),drive_error=$3
   WHERE environment=$1 AND product_id=$2 AND version=$4 AND drive_folder_id=$5`,
   [env.FAREJADOR_ENV,binding.product_id,errorCode,binding.version,binding.drive_folder_id]);
  await client.query('COMMIT');committed=true;
 }finally{
  if(!committed)await client.query('ROLLBACK').catch(()=>{});
  client.release();
 }
}
export function startCatalogPhotoWorker(){
 if(!env.MATRIZ_CATALOG_PHOTOS_ENABLED)return ()=>undefined;
 let running=false,stopped=false;
 const tick=async()=>{
  if(running||stopped||!catalogDriveStatus().configured)return;
  running=true;try{await syncOneCatalogFolder();}
  catch{logger.warn('matrix catalog photo import unavailable; will retry');}finally{running=false;}
 };
 const timer=setInterval(()=>void tick(),5000);void tick();
 return ()=>{stopped=true;clearInterval(timer);};
}
