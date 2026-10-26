import { createHash,randomUUID } from 'node:crypto';
import type { Pool,PoolClient } from 'pg';
import type { Environment } from '../shared/types/chatwoot.js';
import { ensurePhotoProduct } from './repository.js';
import { CatalogPhotoError } from './model.js';
import { prepareCatalogVideo,type PreparedCatalogVideo } from './video-codec.js';
import { CatalogVideoStorage } from './video-storage.js';
import { logger } from '../shared/logger.js';
export interface CatalogVideo {
 id:string;environment:Environment;product_id:string;storage_path:string;width:number;height:number;
 duration_seconds:number|string;file_bytes:number;source_bytes:number;created_at:Date;
}
export async function readCatalogVideo(db:Pick<Pool,'query'>,environment:Environment,id:string){
 return (await db.query<CatalogVideo>(`SELECT v.* FROM commerce.matrix_catalog_videos v JOIN commerce.products p
 ON p.environment=v.environment AND p.id=v.product_id AND p.deleted_at IS NULL
 WHERE v.environment=$1 AND v.id=$2 AND v.retired_at IS NULL`,[environment,id])).rows[0]??null;
}
export async function saveCatalogVideo(db:Pool,input:{environment:Environment;productId:string;bytes:Buffer;
 source:'upload'|'drive';sourceKey:string;actor:string;expectedFolder?:string;expectedVersion?:number},
 storage=new CatalogVideoStorage(),prepare:(bytes:Buffer)=>Promise<PreparedCatalogVideo>=prepareCatalogVideo,connection?:PoolClient){
 const queryDb=connection??db;
 await ensurePhotoProduct(queryDb,input.environment,input.productId);
 const prior=(await queryDb.query('SELECT id FROM commerce.matrix_catalog_videos WHERE environment=$1 AND product_id=$2 AND source_key=$3',
  [input.environment,input.productId,input.sourceKey])).rows[0];
 if(prior)return {id:prior.id,duplicate:true};
 const prepared=await prepare(input.bytes),id=randomUUID(),path=`${input.environment}/${input.productId}/${id}/video.mp4`;
 const discard=()=>storage.remove(path).catch(()=>logger.warn({code:'catalog_video_orphan_cleanup_failed'},'Temporary catalog video cleanup failed'));
 await storage.ensureBucket();
 try{await storage.put(path,prepared.video);}catch(error){await discard();throw error;}
 const client=connection??await db.connect().catch(async error=>{await discard();throw error;});let saved=false,committing=false;
 try{
  await client.query(connection?'SAVEPOINT matrix_video_save':'BEGIN');
  await client.query(`INSERT INTO commerce.matrix_photo_settings(environment,product_id) VALUES($1,$2) ON CONFLICT DO NOTHING`,[input.environment,input.productId]);
  const settings=(await client.query(`SELECT * FROM commerce.matrix_photo_settings WHERE environment=$1 AND product_id=$2 FOR UPDATE`,[input.environment,input.productId])).rows[0];
  if(input.expectedFolder&&(settings.drive_folder_id!==input.expectedFolder||!settings.drive_enabled||settings.version!==input.expectedVersion))throw new CatalogPhotoError('drive_binding_changed',409);
  await ensurePhotoProduct(client,input.environment,input.productId);
  const duplicate=(await client.query('SELECT id FROM commerce.matrix_catalog_videos WHERE environment=$1 AND product_id=$2 AND source_key=$3',
   [input.environment,input.productId,input.sourceKey])).rows[0];
  if(duplicate){await client.query(connection?'RELEASE SAVEPOINT matrix_video_save':'ROLLBACK');return {id:duplicate.id,duplicate:true};}
  await client.query('UPDATE commerce.matrix_catalog_videos SET retired_at=now() WHERE environment=$1 AND product_id=$2 AND retired_at IS NULL',[input.environment,input.productId]);
  await client.query(`INSERT INTO commerce.matrix_catalog_videos(id,environment,product_id,storage_path,sha256,width,height,duration_seconds,
   file_bytes,source_bytes,source,source_key,actor_label) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
   [id,input.environment,input.productId,path,createHash('sha256').update(input.bytes).digest('hex'),prepared.width,prepared.height,
    prepared.duration,prepared.video.length,input.bytes.length,input.source,input.sourceKey,input.actor.slice(0,120)]);
  committing=true;await client.query(connection?'RELEASE SAVEPOINT matrix_video_save':'COMMIT');saved=true;
  return {id,duplicate:false,width:prepared.width,height:prepared.height,duration_seconds:prepared.duration,file_bytes:prepared.video.length};
 }catch(error){await client.query(connection?'ROLLBACK TO SAVEPOINT matrix_video_save':'ROLLBACK');
  if(connection)await client.query('RELEASE SAVEPOINT matrix_video_save');throw error;
 }finally{
  if(!connection)client.release();
  // An uncertain COMMIT may already reference this file: preserve it rather than deleting live media.
  if(!saved&&!committing)await discard();
 }
}
