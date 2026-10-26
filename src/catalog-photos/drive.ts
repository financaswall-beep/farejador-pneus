import { env } from '../shared/config/env.js';
import { googleServiceAccountTokenBody,GOOGLE_TOKEN_URL } from '../marketing/google-service-account.js';
import { CatalogPhotoError } from './model.js';
import { readLimited,MAX_CATALOG_PHOTO_BYTES } from './storage.js';
import { catalogVideoMimes,MAX_CATALOG_VIDEO_UPLOAD } from './video-codec.js';
export function catalogDriveStatus(){
 try{
  const raw=env.MATRIZ_PHOTOS_DRIVE_SERVICE_ACCOUNT_JSON;
  if(!raw)return {configured:false,email:null};
  googleServiceAccountTokenBody(raw,Date.now(),'drive');
  return {configured:true,email:String(JSON.parse(raw).client_email)};
 }catch{return {configured:false,email:null};}
}
export interface DrivePhoto {id:string;name:string;mimeType:string;modifiedTime:string;size:string;md5Checksum:string;capabilities?:{canDownload?:boolean}}
/** Dedicated read-only identity; only explicitly bound folders, never arbitrary URLs. */
export class CatalogDrive {
 constructor(private fetcher:typeof fetch=fetch){}
 private async access(){
  if(!catalogDriveStatus().configured)throw new CatalogPhotoError('drive_not_configured',503);
  const response=await this.fetcher(GOOGLE_TOKEN_URL,{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),
   headers:{'Content-Type':'application/x-www-form-urlencoded'},
   body:googleServiceAccountTokenBody(env.MATRIZ_PHOTOS_DRIVE_SERVICE_ACCOUNT_JSON!,Date.now(),'drive')});
  const data=await response.json() as {access_token?:unknown};
  if(!response.ok||typeof data.access_token!=='string')throw new CatalogPhotoError('drive_authorization_failed',503);
  return data.access_token;
 }
 private async request(path:string,token:string){
  const response=await this.fetcher('https://www.googleapis.com/drive/v3/'+path,{redirect:'error',
   signal:AbortSignal.timeout(20000),headers:{Authorization:'Bearer '+token}});
  if(!response.ok){await response.body?.cancel();throw new CatalogPhotoError(response.status===403||response.status===404?'drive_folder_access_denied':'drive_unavailable',503);}
  return response;
 }
 async folderPhotos(folder:string){
  if(!/^[A-Za-z0-9_-]{10,200}$/.test(folder))throw new CatalogPhotoError('invalid_drive_folder');
  const token=await this.access();
  const metadata=await (await this.request(`files/${folder}?fields=id,mimeType,trashed&supportsAllDrives=true`,token)).json() as {mimeType?:string;trashed?:boolean};
  if(metadata.mimeType!=='application/vnd.google-apps.folder'||metadata.trashed)throw new CatalogPhotoError('invalid_drive_folder');
  const query=new URLSearchParams({q:`'${folder}' in parents and trashed = false and (mimeType = 'image/jpeg' or mimeType = 'image/png' or mimeType = 'image/webp' or mimeType = 'video/mp4' or mimeType = 'video/quicktime' or mimeType = 'video/webm')`,
   fields:'nextPageToken,incompleteSearch,files(id,name,mimeType,size,modifiedTime,md5Checksum,capabilities(canDownload))',
   pageSize:'100',supportsAllDrives:'true',includeItemsFromAllDrives:'true'});
  const data=await (await this.request('files?'+query,token)).json() as {nextPageToken?:string;incompleteSearch?:boolean;files?:DrivePhoto[]};
  if(data.nextPageToken||data.incompleteSearch)throw new CatalogPhotoError('drive_folder_too_large');
  return {files:data.files??[],token};
 }
 async download(file:DrivePhoto,token:string){
  if(!/^[A-Za-z0-9_-]{10,200}$/.test(file.id)||file.capabilities?.canDownload!==true
   ||!['image/jpeg','image/png','image/webp',...catalogVideoMimes].includes(file.mimeType)||!file.md5Checksum||!file.modifiedTime)
   throw new CatalogPhotoError('drive_photo_unavailable');
  const max=catalogVideoMimes.includes(file.mimeType)?MAX_CATALOG_VIDEO_UPLOAD:MAX_CATALOG_PHOTO_BYTES;
  if(Number(file.size)>max)throw new CatalogPhotoError(catalogVideoMimes.includes(file.mimeType)?'video_too_large':'photo_too_large',413);
  return readLimited(await this.request(`files/${file.id}?alt=media&supportsAllDrives=true`,token),max,catalogVideoMimes.includes(file.mimeType)?'video_too_large':'photo_too_large');
 }
}
