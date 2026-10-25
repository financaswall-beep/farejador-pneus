import type { FastifyInstance,FastifyRequest,FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireAdminOwner } from '../auth.js';
import { env } from '../../shared/config/env.js';
import { rateLimitHit } from '../../shared/rate-limit.js';
import { operatorLabel } from './route-helpers.js';
import { CatalogPhotoError,angleSchema,folderSchema } from '../../catalog-photos/model.js';
import { catalogDriveStatus } from '../../catalog-photos/drive.js';
import { CatalogPhotoStorage,catalogStorageReady,MAX_CATALOG_PHOTO_BYTES } from '../../catalog-photos/storage.js';
import { listCatalogPhotos,readCatalogPhoto,saveCatalogPhoto,updatePhotoSettings } from '../../catalog-photos/repository.js';
const database=async()=> (await import('../../persistence/db.js')).pool;
const productParams=z.object({productId:z.string().uuid()});
const photoParams=z.object({photoId:z.string().uuid()});
const settingsBody=z.object({version:z.number().int().positive(),enabled:z.boolean().optional(),
 drive_folder_id:folderSchema.optional(),drive_enabled:z.boolean().optional(),primary_id:z.string().uuid().optional()}).strict();
type Guard=(request:FastifyRequest,reply:FastifyReply)=>Promise<void>;
export function registerCatalogPhotoRoutes(app:FastifyInstance,options:{base?:string;guards?:Guard[];actor?:(request:FastifyRequest)=>string}={}){
 const base=options.base??'/admin/api/catalog',guard=options.guards??[requireAdminOwner];
 for(const mime of ['image/jpeg','image/png','image/webp'])if(!app.hasContentTypeParser(mime))
  app.addContentTypeParser(mime,{parseAs:'buffer'},(_request,body,done)=>done(null,body));
 app.get(base+'/photos',{preHandler:guard},async(_request,reply)=>{
  reply.header('Cache-Control','no-store');
  if(!env.MATRIZ_CATALOG_PHOTOS_ENABLED)return {enabled:false,rows:[],storage_ready:catalogStorageReady(),drive:catalogDriveStatus()};
  return {enabled:true,bot_ready:env.PHOTO_REQUESTS&&env.BOT_OUTBOX,
   ...await listCatalogPhotos(await database(),env.FAREJADOR_ENV),storage_ready:catalogStorageReady(),drive:catalogDriveStatus()};
 });
 app.post(base+'/:productId/photos',{preHandler:guard,bodyLimit:MAX_CATALOG_PHOTO_BYTES},async(request,reply)=>{
  if(!env.MATRIZ_CATALOG_PHOTOS_ENABLED)return reply.code(404).send({error:'feature_off'});
  const params=productParams.safeParse(request.params),angle=angleSchema.safeParse((request.query as {angle?:unknown}).angle);
  const uploadId=z.string().uuid().safeParse(request.headers['x-upload-id']);
  if(!params.success||!angle.success||!uploadId.success)return reply.code(400).send({error:'invalid_photo_upload'});
  if(!Buffer.isBuffer(request.body))return reply.code(415).send({error:'not_an_image'});
  if(rateLimitHit('catalog-photo:'+request.ip,20,60000))return reply.code(429).send({error:'rate_limited'});
  try{return await saveCatalogPhoto(await database(),{environment:env.FAREJADOR_ENV,productId:params.data.productId,angle:angle.data,
   bytes:request.body,source:'upload',sourceKey:'upload:'+uploadId.data,actor:options.actor?.(request)??operatorLabel(request)});}
  catch(error){if(error instanceof CatalogPhotoError)return reply.code(error.status).send({error:error.code});throw error;}
 });
 app.patch(base+'/:productId/photo-settings',{preHandler:guard},async(request,reply)=>{
  if(!env.MATRIZ_CATALOG_PHOTOS_ENABLED)return reply.code(404).send({error:'feature_off'});
  const params=productParams.safeParse(request.params),body=settingsBody.safeParse(request.body);
  if(!params.success||!body.success)return reply.code(400).send({error:'invalid_photo_settings'});
  try{await updatePhotoSettings(await database(),env.FAREJADOR_ENV,params.data.productId,body.data);return {ok:true};}
  catch(error){if(error instanceof CatalogPhotoError)return reply.code(error.status).send({error:error.code});throw error;}
 });
 app.get(base+'/photos/:photoId/image',{preHandler:guard},async(request,reply)=>{
  if(!env.MATRIZ_CATALOG_PHOTOS_ENABLED)return reply.code(404).send({error:'feature_off'});
  const params=photoParams.safeParse(request.params);if(!params.success)return reply.code(404).send({error:'photo_not_found'});
  const photo=await readCatalogPhoto(await database(),env.FAREJADOR_ENV,params.data.photoId);
  if(!photo)return reply.code(404).send({error:'photo_not_found'});
  const original=(request.query as {original?:string}).original==='true';
  reply.header('Cache-Control','private, no-store').header('X-Content-Type-Options','nosniff');
  return reply.type('image/webp').send(await new CatalogPhotoStorage().read(original?photo.original_path:photo.storage_path));
 });
}
