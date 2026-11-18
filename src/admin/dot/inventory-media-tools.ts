import {mkdtemp,readFile,unlink,rmdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {z} from 'zod';
import {pool} from '../../persistence/db.js';
import {env} from '../../shared/config/env.js';
import {angleSchema,folderSchema} from '../../catalog-photos/model.js';
import {MAX_CATALOG_PHOTO_BYTES} from '../../catalog-photos/storage.js';
import {MAX_CATALOG_VIDEO_UPLOAD} from '../../catalog-photos/video-codec.js';
import {listCatalogPhotos,saveCatalogPhoto,updatePhotoSettings} from '../../catalog-photos/repository.js';
import {saveCatalogVideo} from '../../catalog-photos/video-repository.js';
import {downloadPublisherFile} from './publisher-download.js';
import {registerInventoryRead as read,registerInventoryWrite as write} from './inventory-registry.js';

const file=z.object({download_url:z.string().url().max(8192),file_id:z.string().min(1).max(256),file_name:z.string().max(256).optional(),mime_type:z.string().max(128).optional()}).passthrough();
const media=z.object({product_id:z.string().uuid(),arquivo:file,idempotency_key:z.string().uuid()}).strict();
let activeUploads=0;
function available(){if(!env.MATRIZ_CATALOG_PHOTOS_ENABLED)throw Error('catalog_media_disabled');}
async function withAttachment<T>(url:string,limit:number,use:(bytes:Buffer)=>Promise<T>){
  available();if(activeUploads>=1)throw Error('catalog_media_busy');
  activeUploads++;
  let directory:string|undefined;
  try{
    directory=await mkdtemp(join(tmpdir(),'milly-catalog-'));
    const source=join(directory,'source');
    await downloadPublisherFile(url,source,limit);
    return await use(await readFile(source));
  }finally{
    activeUploads--;
    // Apenas o arquivo fixo e o diretório vazio criados por esta chamada.
    if(directory){await unlink(join(directory,'source')).catch(()=>undefined);await rmdir(directory).catch(()=>undefined);}
  }
}
write('catalog','anexar_foto_catalogo','Anexa/substitui a foto do pneu no ângulo identificado. Use um anexo do dono e confirme o produto; até 10 MiB.',media.extend({angle:angleSchema}),
  (db,data,actor,identity)=>withAttachment(data.arquivo.download_url,MAX_CATALOG_PHOTO_BYTES,bytes=>saveCatalogPhoto(pool,{
    environment:env.FAREJADOR_ENV,productId:data.product_id,angle:data.angle,bytes,source:'upload',
    sourceKey:'milly:'+identity.grant_id+':'+data.idempotency_key,actor},undefined,db)),true);
write('catalog','anexar_video_catalogo','Anexa/substitui o vídeo do produto. Use um anexo do dono; o mesmo processamento e limites do catálogo se aplicam.',media,
  (db,data,actor,identity)=>withAttachment(data.arquivo.download_url,MAX_CATALOG_VIDEO_UPLOAD,bytes=>saveCatalogVideo(pool,{
    environment:env.FAREJADOR_ENV,productId:data.product_id,bytes,source:'upload',
    sourceKey:'milly:'+identity.grant_id+':'+data.idempotency_key,actor},undefined,undefined,db)),true);
write('catalog','configurar_midias_catalogo','Configura exibição de fotos, foto principal e a pasta já autorizada do Google Drive. Consulte a versão atual; mudança concorrente exige revisão.',z.object({
  product_id:z.string().uuid(),version:z.number().int().positive(),enabled:z.boolean().optional(),
  drive_folder_id:folderSchema.optional(),drive_enabled:z.boolean().optional(),primary_id:z.string().uuid().optional(),
}).strict(),async(db,{product_id,...data})=>{available();await updatePhotoSettings(pool,env.FAREJADOR_ENV,product_id,data,db);return {ok:true};});
read('consultar_midias_catalogo','Lista fotos, vídeo e versão das configurações dos produtos do catálogo.',z.object({
  product_id:z.string().uuid().optional(),pagina:z.number().int().min(1).max(40).default(1),
}).strict(),async data=>{
  available();const result=await listCatalogPhotos(pool,env.FAREJADOR_ENV);
  const rows=data.product_id?result.rows.filter(row=>row.product_id===data.product_id):result.rows;
  return {rows:rows.slice((data.pagina-1)*50,data.pagina*50),pagina:data.pagina,mais:rows.length>data.pagina*50,truncado:result.truncated};
});
