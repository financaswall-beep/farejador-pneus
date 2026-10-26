import type { FastifyInstance,FastifyRequest,FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireAdminOwner } from '../auth.js';
import { env } from '../../shared/config/env.js';
import { rateLimitHit } from '../../shared/rate-limit.js';
import { operatorLabel } from './route-helpers.js';
import { CatalogPhotoError } from '../../catalog-photos/model.js';
import { CatalogVideoStorage } from '../../catalog-photos/video-storage.js';
import { saveCatalogVideo,readCatalogVideo } from '../../catalog-photos/video-repository.js';
import { catalogVideoMimes,MAX_CATALOG_VIDEO_UPLOAD } from '../../catalog-photos/video-codec.js';
const database=async()=> (await import('../../persistence/db.js')).pool;
type Guard=(request:FastifyRequest,reply:FastifyReply)=>Promise<void>;
let activeUploads=0;
const leases=new WeakSet<FastifyRequest>();
function release(request:FastifyRequest){if(leases.delete(request))activeUploads--;}
export function registerCatalogVideoRoutes(app:FastifyInstance,options:{base?:string;guards?:Guard[];actor?:(request:FastifyRequest)=>string}={}){
 const base=options.base??'/admin/api/catalog',guards=options.guards??[requireAdminOwner];
 for(const mime of catalogVideoMimes)if(!app.hasContentTypeParser(mime))
  app.addContentTypeParser(mime,{parseAs:'buffer'},(_request,body,done)=>done(null,body));
 app.post(base+'/:productId/videos',{
  bodyLimit:MAX_CATALOG_VIDEO_UPLOAD,
  preHandler:guards,
  onRequest:[...guards,async(request,reply)=>{
   if(!env.MATRIZ_CATALOG_PHOTOS_ENABLED)return reply.code(404).send({error:'feature_off'});
   if(activeUploads>=1)return reply.code(429).send({error:'video_processing_busy'});
   activeUploads++;leases.add(request);
  }],
  onResponse:async request=>release(request),onError:async request=>release(request),
  onRequestAbort:async request=>release(request),onTimeout:async request=>release(request),
 },async(request,reply)=>{
  const product=z.object({productId:z.string().uuid()}).safeParse(request.params);
  const upload=z.string().uuid().safeParse(request.headers['x-upload-id']);
  if(!product.success||!upload.success)return reply.code(400).send({error:'invalid_video_upload'});
  if(!Buffer.isBuffer(request.body))return reply.code(415).send({error:'video_invalid'});
  if(rateLimitHit('catalog-video:'+request.ip,6,60000))return reply.code(429).send({error:'rate_limited'});
  try{return await saveCatalogVideo(await database(),{environment:env.FAREJADOR_ENV,productId:product.data.productId,
   bytes:request.body,source:'upload',sourceKey:'upload:'+upload.data,actor:options.actor?.(request)??operatorLabel(request)});}
  catch(error){if(error instanceof CatalogPhotoError)return reply.code(error.status).send({error:error.code});throw error;}
  finally{release(request);}
 });
 app.get(base+'/videos/:videoId/file',{preHandler:guards},async(request,reply)=>{
  if(!env.MATRIZ_CATALOG_PHOTOS_ENABLED)return reply.code(404).send({error:'feature_off'});
  const parsed=z.object({videoId:z.string().uuid()}).safeParse(request.params);
  if(!parsed.success)return reply.code(404).send({error:'video_not_found'});
  const video=await readCatalogVideo(await database(),env.FAREJADOR_ENV,parsed.data.videoId);
  if(!video)return reply.code(404).send({error:'video_not_found'});
  reply.header('Cache-Control','private, no-store').header('X-Content-Type-Options','nosniff');
  return reply.type('video/mp4').send(await new CatalogVideoStorage().read(video.storage_path));
 });
}
