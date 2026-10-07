import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Environment } from '../shared/types/chatwoot.js';
import { PhotoRejectedError } from '../parceiro/photo-upload.js';
import { compactTirePhoto } from './codec.js';
import { enqueueStoredPhoto } from './dispatch.js';
import { TirePhotoStorage,photoStorageConfigured } from './storage.js';
import { tirePhotoPath } from './uploads.js';

interface Upload { id:string; environment:Environment; unit_id:string; photo_request_id:string }
interface Blob extends Upload { photo_bytes:Buffer; photo_mime:string }

/** Executado dentro da transação/lock do worker. Um decode e um arquivo por vez. */
export async function processPhotoUpload(client: PoolClient, environment: Environment, storage: TirePhotoStorage) {
  const work=await client.query<Upload>(`SELECT id,environment,unit_id,photo_request_id
    FROM commerce.photo_uploads WHERE environment=$1 AND state='queued'
      AND created_at>now()-interval '24 hours'
      AND updated_at<=now()-make_interval(secs=>least(attempts*5,300))
    ORDER BY updated_at LIMIT 1 FOR UPDATE SKIP LOCKED`,[environment]);
  const row=work.rows[0]; if (!row) return false;
  const request=await client.query<{ status:string; was_late:boolean; conversation_id:string; n:number; purged:boolean }>(
    `SELECT p.status,p.was_late,p.conversation_id,
      (SELECT count(*) FROM commerce.photo_request_blobs b WHERE b.photo_request_id=p.id AND b.environment=p.environment) AS n,
      EXISTS (SELECT 1 FROM commerce.photo_request_blobs b WHERE b.photo_request_id=p.id AND b.deleted_at IS NOT NULL) AS purged
     FROM commerce.photo_requests p WHERE p.id=$1 AND p.environment=$2 AND p.unit_id=$3 FOR UPDATE`,
    [row.photo_request_id,environment,row.unit_id]);
  const pr=request.rows[0];
  if (!pr || pr.status==='cancelled' || pr.purged || Number(pr.n)>=3) {
    await client.query(`UPDATE commerce.photo_uploads SET state='rejected',error_code='photo_request_closed',updated_at=now()
      WHERE id=$1 AND environment=$2`,[row.id,environment]);
    return true;
  }
  try {
    const photo=await compactTirePhoto(await storage.read(tirePhotoPath(row,'upload.jpg')));
    const path=tirePhotoPath(row,'photo.webp');
    await storage.put(path,photo.bytes);
    await client.query(`INSERT INTO commerce.photo_request_blobs
      (id,environment,unit_id,photo_request_id,photo_mime,photo_size_bytes,storage_path,sha256,width,height)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [row.id,environment,row.unit_id,row.photo_request_id,photo.mime,photo.bytes.length,path,
        createHash('sha256').update(photo.bytes).digest('hex'),photo.width,photo.height]);
    const late=pr.was_late || ['expired','expired_after_answer'].includes(pr.status);
    await client.query(`UPDATE commerce.photo_requests SET status=CASE WHEN status='sent' THEN status ELSE 'answered' END,
      was_late=$3,answered_at=COALESCE(answered_at,now()) WHERE id=$1 AND environment=$2`,
      [row.photo_request_id,environment,late]);
    await enqueueStoredPhoto(client,{ environment,conversationId:Number(pr.conversation_id),
      requestId:row.photo_request_id,blobId:row.id,wasLate:late });
    await client.query(`UPDATE commerce.photo_uploads SET state='ready',updated_at=now(),error_code=NULL
      WHERE id=$1 AND environment=$2`,[row.id,environment]);
  } catch (error) {
    // Só erros de imagem são definitivos. Storage indisponível permite retry após restart.
    if (!(error instanceof PhotoRejectedError)) {
      if (error instanceof Error) Object.assign(error,{ photoUploadId:row.id });
      throw error;
    }
    await client.query(`UPDATE commerce.photo_uploads SET state='rejected',error_code=$3,updated_at=now()
      WHERE id=$1 AND environment=$2`,[row.id,environment,error.reason]);
  }
  return true;
}

/** Migração gradual dos anexos legados, sem carregá-los todos na RAM ou apagá-los antes do PUT. */
export async function migrateOnePhoto(client: PoolClient, environment: Environment, storage: TirePhotoStorage) {
  const result=await client.query<Blob>(`SELECT id,environment,unit_id,photo_request_id,photo_bytes,photo_mime
    FROM commerce.photo_request_blobs WHERE environment=$1 AND photo_bytes IS NOT NULL AND deleted_at IS NULL
      AND ($2::boolean OR photo_mime<>'image/webp') ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`,
    [environment,photoStorageConfigured()]);
  const row=result.rows[0]; if (!row) return false;
  const photo=row.photo_mime==='image/webp' ? { bytes:row.photo_bytes,mime:'image/webp' as const,
    width:null,height:null } : await compactTirePhoto(row.photo_bytes);
  const path=photoStorageConfigured()?tirePhotoPath(row,'photo.webp'):null;
  if (path) await storage.put(path,photo.bytes);
  await client.query(`UPDATE commerce.photo_request_blobs SET photo_bytes=$3,storage_path=$4,photo_mime='image/webp',
    photo_size_bytes=$5,sha256=$6,width=COALESCE($7,width),height=COALESCE($8,height) WHERE id=$1 AND environment=$2`,
    [row.id,environment,path?null:photo.bytes,path,photo.bytes.length,
      createHash('sha256').update(photo.bytes).digest('hex'),photo.width,photo.height]);
  return true;
}

/** URL de upload assinada vale 2h. Mantém staging 24h, depois remove mesmo se nunca finalizado. */
export async function removeOneTemporaryPhoto(client: PoolClient, environment: Environment, storage: TirePhotoStorage) {
  const result=await client.query<Upload>(`SELECT id,environment,unit_id,photo_request_id FROM commerce.photo_uploads
    WHERE environment=$1 AND temporary_deleted_at IS NULL AND created_at<now()-interval '24 hours'
    ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`,[environment]);
  const row=result.rows[0]; if (!row) return false;
  // Um PUT final pode ter ocorrido antes de uma transação abortar. Esse órfão também sai.
  const live=await client.query(`SELECT 1 FROM commerce.photo_request_blobs WHERE id=$1 AND environment=$2 AND deleted_at IS NULL`,
    [row.id,environment]);
  await storage.remove([tirePhotoPath(row,'upload.jpg'),...(live.rowCount?[]:[tirePhotoPath(row,'photo.webp')])]);
  await client.query(`UPDATE commerce.photo_uploads SET temporary_deleted_at=now(),
    state=CASE WHEN state IN ('uploading','queued') THEN 'rejected' ELSE state END,
    error_code=CASE WHEN state IN ('uploading','queued') THEN 'upload_expired' ELSE error_code END
    WHERE id=$1 AND environment=$2`,[row.id,environment]);
  return true;
}
