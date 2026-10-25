import { createHash,randomUUID } from 'node:crypto';
import type { Pool,PoolClient } from 'pg';
import type { Environment } from '../shared/types/chatwoot.js';
import { prepareCatalogPhoto } from './codec.js';
import { CatalogPhotoError,type CatalogPhoto,type PhotoAngle } from './model.js';
import { CatalogPhotoStorage } from './storage.js';
export const photoProjection=`id,angle,is_primary,width,height,source,created_at`;
export async function listCatalogPhotos(db:Pool,environment:Environment){
 const result=await db.query(`SELECT p.id product_id,p.product_name,p.brand,p.tire_condition,t.tire_size,
  COALESCE(s.enabled,true) enabled,s.version,s.drive_folder_id,s.drive_enabled,s.drive_checked_at,s.drive_error,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id',f.id,'angle',f.angle,'is_primary',f.is_primary,
   'width',f.width,'height',f.height,'source',f.source) ORDER BY f.is_primary DESC,f.angle)
   FROM commerce.matrix_catalog_photos f WHERE f.environment=p.environment AND f.product_id=p.id AND f.retired_at IS NULL),'[]') photos
  FROM commerce.products p JOIN commerce.tire_specs t ON t.environment=p.environment AND t.product_id=p.id
  LEFT JOIN commerce.matrix_photo_settings s ON s.environment=p.environment AND s.product_id=p.id
  WHERE p.environment=$1 AND p.deleted_at IS NULL AND p.product_type='tire' ORDER BY t.tire_size,p.brand,p.id LIMIT 2001`,[environment]);
 return {rows:result.rows.slice(0,2000),truncated:result.rows.length>2000};
}
export async function ensurePhotoProduct(db:Pick<Pool,'query'>,environment:Environment,productId:string){
 if(!(await db.query(`SELECT 1 FROM commerce.products WHERE environment=$1 AND id=$2
  AND product_type='tire' AND deleted_at IS NULL`,[environment,productId])).rowCount)throw new CatalogPhotoError('product_not_found',404);
}
export async function saveCatalogPhoto(db:Pool,input:{environment:Environment;productId:string;angle:PhotoAngle;
 bytes:Buffer;source:'upload'|'drive';sourceKey:string;actor:string;expectedFolder?:string;expectedVersion?:number;sourceFileId?:string},
 storage=new CatalogPhotoStorage(),connection?:PoolClient){
 const queryDb=connection??db;
 await ensurePhotoProduct(queryDb,input.environment,input.productId);
 const prior=await queryDb.query('SELECT id FROM commerce.matrix_catalog_photos WHERE environment=$1 AND product_id=$2 AND source_key=$3',
  [input.environment,input.productId,input.sourceKey]);
 if(prior.rowCount)return {id:prior.rows[0].id,duplicate:true};
 const prepared=await prepareCatalogPhoto(input.bytes),id=randomUUID();
 const base=`${input.environment}/${input.productId}/${id}/`;
 await storage.ensureBucket();
 await storage.put(base+'original.webp',prepared.original);await storage.put(base+'photo.webp',prepared.photo);
 const client=connection??await db.connect();
 try{
  await client.query(connection?'SAVEPOINT matrix_catalog_save':'BEGIN');
  await client.query(`INSERT INTO commerce.matrix_photo_settings(environment,product_id) VALUES($1,$2) ON CONFLICT DO NOTHING`,[input.environment,input.productId]);
  const settings=(await client.query(`SELECT * FROM commerce.matrix_photo_settings WHERE environment=$1 AND product_id=$2 FOR UPDATE`,[input.environment,input.productId])).rows[0];
  if(input.expectedFolder&&(settings.drive_folder_id!==input.expectedFolder||!settings.drive_enabled
   ||settings.version!==input.expectedVersion))throw new CatalogPhotoError('drive_binding_changed',409);
  await ensurePhotoProduct(client,input.environment,input.productId);
  const duplicate=await client.query('SELECT id FROM commerce.matrix_catalog_photos WHERE environment=$1 AND product_id=$2 AND source_key=$3',
   [input.environment,input.productId,input.sourceKey]);
  if(duplicate.rowCount){await client.query(connection?'RELEASE SAVEPOINT matrix_catalog_save':'ROLLBACK');return {id:duplicate.rows[0].id,duplicate:true};}
  const current=(await client.query<{angle:PhotoAngle;is_primary:boolean;source_key:string}>(`SELECT angle,is_primary,source_key FROM commerce.matrix_catalog_photos
   WHERE environment=$1 AND product_id=$2 AND retired_at IS NULL`,[input.environment,input.productId])).rows;
  const primary=!current.length||current.some(row=>row.is_primary&&(row.angle===input.angle
   ||!!input.sourceFileId&&row.source_key.split(':')[1]===input.sourceFileId));
  await client.query(`UPDATE commerce.matrix_catalog_photos SET retired_at=now() WHERE environment=$1 AND product_id=$2
   AND (angle=$3 OR ($4::text IS NOT NULL AND source='drive' AND split_part(source_key,':',2)=$4)) AND retired_at IS NULL`,
   [input.environment,input.productId,input.angle,input.sourceFileId??null]);
  await client.query(`INSERT INTO commerce.matrix_catalog_photos
   (id,environment,product_id,angle,is_primary,storage_path,original_path,sha256,width,height,source,source_key,actor_label)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[id,input.environment,input.productId,input.angle,primary,
   base+'photo.webp',base+'original.webp',createHash('sha256').update(input.bytes).digest('hex'),prepared.width,prepared.height,
   input.source,input.sourceKey,input.actor.slice(0,120)]);
  await client.query(connection?'RELEASE SAVEPOINT matrix_catalog_save':'COMMIT');return {id,duplicate:false};
 }catch(error){
  await client.query(connection?'ROLLBACK TO SAVEPOINT matrix_catalog_save':'ROLLBACK');
  if(connection)await client.query('RELEASE SAVEPOINT matrix_catalog_save');throw error;
 }finally{if(!connection)client.release();}
}
export async function updatePhotoSettings(db:Pool,environment:Environment,productId:string,input:{
 version:number;enabled?:boolean;drive_folder_id?:string|null;drive_enabled?:boolean;primary_id?:string}){
 const client=await db.connect();try{
  await client.query('BEGIN');await ensurePhotoProduct(client,environment,productId);
  await client.query(`INSERT INTO commerce.matrix_photo_settings(environment,product_id) VALUES($1,$2) ON CONFLICT DO NOTHING`,[environment,productId]);
  const current=(await client.query('SELECT * FROM commerce.matrix_photo_settings WHERE environment=$1 AND product_id=$2 FOR UPDATE',[environment,productId])).rows[0];
  if(current.version!==input.version)throw new CatalogPhotoError('settings_changed',409);
  const folder=input.drive_folder_id===undefined?current.drive_folder_id:input.drive_folder_id;
  const driveEnabled=input.drive_enabled??current.drive_enabled;
  if(driveEnabled&&!folder)throw new CatalogPhotoError('drive_folder_required');
  if(input.primary_id){
   const owned=await client.query('SELECT 1 FROM commerce.matrix_catalog_photos WHERE environment=$1 AND product_id=$2 AND id=$3 AND retired_at IS NULL',[environment,productId,input.primary_id]);
   if(!owned.rowCount)throw new CatalogPhotoError('photo_not_found',404);
   await client.query(`UPDATE commerce.matrix_catalog_photos SET is_primary=false WHERE environment=$1 AND product_id=$2 AND retired_at IS NULL`,[environment,productId]);
   await client.query(`UPDATE commerce.matrix_catalog_photos SET is_primary=true WHERE environment=$1 AND product_id=$2 AND id=$3`,[environment,productId,input.primary_id]);
  }
  await client.query(`UPDATE commerce.matrix_photo_settings SET enabled=$3,drive_folder_id=$4,drive_enabled=$5,
   version=version+1,drive_checked_at=NULL,drive_error=NULL,updated_at=now() WHERE environment=$1 AND product_id=$2`,
   [environment,productId,input.enabled??current.enabled,folder,driveEnabled]);
  await client.query('COMMIT');
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
export async function readCatalogPhoto(db:Pick<Pool,'query'>,environment:Environment,id:string){
 return (await db.query<CatalogPhoto>(`SELECT f.* FROM commerce.matrix_catalog_photos f
  JOIN commerce.products p ON p.id=f.product_id AND p.environment=f.environment
  WHERE f.environment=$1 AND f.id=$2 AND f.retired_at IS NULL AND p.deleted_at IS NULL`,[environment,id])).rows[0];
}
