import { env } from '../shared/config/env.js';
import { CatalogPhotoError } from './model.js';
export const CATALOG_PHOTO_BUCKET='farejador-matrix-catalog';
export const MAX_CATALOG_PHOTO_BYTES=10*1024*1024;
export const catalogStorageReady=()=>!!(env.SUPABASE_STORAGE_URL&&env.SUPABASE_STORAGE_SERVICE_KEY);
const valid=/^(prod|test)\/[a-f0-9-]{36}\/[a-f0-9-]{36}\/(original|photo)\.webp$/;
export class CatalogPhotoStorage {
 constructor(private fetcher:typeof fetch=fetch){}
 private async request(path:string,method='GET',bytes?:Buffer|string){
  if(!catalogStorageReady())throw new CatalogPhotoError('storage_not_configured',503);
  const response=await this.fetcher(env.SUPABASE_STORAGE_URL!.replace(/\/$/,'')+'/storage/v1'+path,{
   method,redirect:'error',signal:AbortSignal.timeout(20000),
   headers:{Authorization:'Bearer '+env.SUPABASE_STORAGE_SERVICE_KEY,apikey:env.SUPABASE_STORAGE_SERVICE_KEY!,
    'Content-Type':Buffer.isBuffer(bytes)?'image/webp':'application/json'},
   ...(bytes?{body:typeof bytes==='string'?bytes:new Uint8Array(bytes)}:{}),
  });
  if(!response.ok){await response.body?.cancel();throw new CatalogPhotoError('photo_storage_unavailable',503);}
  return response;
 }
 async ensureBucket(){
  if(!catalogStorageReady())throw new CatalogPhotoError('storage_not_configured',503);
  const base=env.SUPABASE_STORAGE_URL!.replace(/\/$/,'')+'/storage/v1';
  const headers={Authorization:'Bearer '+env.SUPABASE_STORAGE_SERVICE_KEY,apikey:env.SUPABASE_STORAGE_SERVICE_KEY!,'Content-Type':'application/json'};
  let response=await this.fetcher(base+'/bucket/'+CATALOG_PHOTO_BUCKET,{headers,redirect:'error',signal:AbortSignal.timeout(15000)});
  if(response.status===404||response.status===400){
   await response.body?.cancel();
   const created=await this.fetcher(base+'/bucket',{method:'POST',headers,redirect:'error',signal:AbortSignal.timeout(15000),
    body:JSON.stringify({id:CATALOG_PHOTO_BUCKET,name:CATALOG_PHOTO_BUCKET,public:false,
     file_size_limit:MAX_CATALOG_PHOTO_BYTES,allowed_mime_types:['image/webp']})});
   await created.body?.cancel();
   response=await this.request('/bucket/'+CATALOG_PHOTO_BUCKET);
  }
  if(!response.ok)throw new CatalogPhotoError('photo_storage_unavailable',503);
  const bucket=await response.json() as {public?:unknown;file_size_limit?:unknown;allowed_mime_types?:unknown};
  if(bucket.public!==false||Number(bucket.file_size_limit)!==MAX_CATALOG_PHOTO_BYTES
   ||JSON.stringify(bucket.allowed_mime_types)!==JSON.stringify(['image/webp']))throw new CatalogPhotoError('catalog_bucket_policy_invalid',503);
 }
 async put(path:string,bytes:Buffer){
  if(!valid.test(path))throw new Error('invalid_catalog_path');
  const response=await this.request('/object/'+CATALOG_PHOTO_BUCKET+'/'+path,'POST',bytes);
  await response.body?.cancel();
 }
 async read(path:string){
  if(!valid.test(path))throw new Error('invalid_catalog_path');
  const response=await this.request('/object/'+CATALOG_PHOTO_BUCKET+'/'+path);
  return readLimited(response,MAX_CATALOG_PHOTO_BYTES);
 }
 async remove(path:string){
  if(!valid.test(path))throw new Error('invalid_catalog_path');
  const response=await this.request('/object/'+CATALOG_PHOTO_BUCKET,'DELETE',JSON.stringify({prefixes:[path]}));
  await response.body?.cancel();
 }
}
export async function readLimited(response:Response,max:number,tooLarge='photo_too_large'){
 if(Number(response.headers.get('content-length')??0)>max){await response.body?.cancel();throw new CatalogPhotoError(tooLarge,413);}
 const reader=response.body?.getReader();if(!reader)throw new CatalogPhotoError('empty_photo');
 const chunks:Uint8Array[]=[];let size=0;
 try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;
  if(size>max)throw new CatalogPhotoError(tooLarge,413);chunks.push(part.value);}}
 finally{await reader.cancel();}
 return Buffer.concat(chunks);
}
