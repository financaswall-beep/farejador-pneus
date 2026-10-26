import { env } from '../shared/config/env.js';
import { CatalogPhotoError } from './model.js';
import { catalogStorageReady,readLimited } from './storage.js';
import { MAX_CATALOG_VIDEO_BYTES } from './video-codec.js';
export const CATALOG_VIDEO_BUCKET='farejador-matrix-catalog-videos';
const valid=/^(prod|test)\/[a-f0-9-]{36}\/[a-f0-9-]{36}\/video\.mp4$/;
export class CatalogVideoStorage {
 constructor(private fetcher:typeof fetch=fetch){}
 private headers(mime='application/json'){
  if(!catalogStorageReady())throw new CatalogPhotoError('storage_not_configured',503);
  return {Authorization:'Bearer '+env.SUPABASE_STORAGE_SERVICE_KEY,apikey:env.SUPABASE_STORAGE_SERVICE_KEY!,'Content-Type':mime};
 }
 private async request(path:string,method='GET',body?:Uint8Array|string,mime?:string){
  const headers=this.headers(mime);
  const response=await this.fetcher(env.SUPABASE_STORAGE_URL!.replace(/\/$/,'')+'/storage/v1'+path,
   {method,...(body?{body:typeof body==='string'?body:new Uint8Array(body)}:{}),headers,redirect:'error',signal:AbortSignal.timeout(25000)});
  if(!response.ok){await response.body?.cancel();throw new CatalogPhotoError('video_storage_unavailable',503);}
  return response;
 }
 async ensureBucket(){
  const base=env.SUPABASE_STORAGE_URL?.replace(/\/$/,'')+'/storage/v1/bucket/'+CATALOG_VIDEO_BUCKET;
  let response=await this.fetcher(base,{headers:this.headers(),redirect:'error',signal:AbortSignal.timeout(15000)});
  if(response.status===400||response.status===404){
   await response.body?.cancel();
   const created=await this.request('/bucket','POST',JSON.stringify({id:CATALOG_VIDEO_BUCKET,name:CATALOG_VIDEO_BUCKET,
    public:false,file_size_limit:MAX_CATALOG_VIDEO_BYTES,allowed_mime_types:['video/mp4']}));await created.body?.cancel();
   response=await this.request('/bucket/'+CATALOG_VIDEO_BUCKET);
  }
  if(!response.ok)throw new CatalogPhotoError('video_storage_unavailable',503);
  const bucket=await response.json() as {public?:unknown;file_size_limit?:unknown;allowed_mime_types?:unknown};
  if(bucket.public!==false||Number(bucket.file_size_limit)!==MAX_CATALOG_VIDEO_BYTES
   ||JSON.stringify(bucket.allowed_mime_types)!==JSON.stringify(['video/mp4']))throw new CatalogPhotoError('catalog_video_bucket_policy_invalid',503);
 }
 async put(path:string,bytes:Buffer){
  if(!valid.test(path)||bytes.length>MAX_CATALOG_VIDEO_BYTES)throw new CatalogPhotoError('video_output_too_large',413);
  const response=await this.request('/object/'+CATALOG_VIDEO_BUCKET+'/'+path,'POST',new Uint8Array(bytes),'video/mp4');await response.body?.cancel();
 }
 async read(path:string){
  if(!valid.test(path))throw new Error('invalid_catalog_video_path');
  return readLimited(await this.request('/object/'+CATALOG_VIDEO_BUCKET+'/'+path),MAX_CATALOG_VIDEO_BYTES,'video_output_too_large');
 }
 async remove(path:string){
  if(!valid.test(path))throw new Error('invalid_catalog_video_path');
  const response=await this.request('/object/'+CATALOG_VIDEO_BUCKET,'DELETE',JSON.stringify({prefixes:[path]}));await response.body?.cancel();
 }
}
