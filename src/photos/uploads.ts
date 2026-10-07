import { withPartnerContext } from '../parceiro/db.js';
import type { PartnerContext } from '../parceiro/auth.js';
import { TirePhotoStorage } from './storage.js';

export function tirePhotoPath(row: { environment: string; unit_id: string; photo_request_id: string; id: string },
  file: 'upload.jpg' | 'photo.webp') {
  return `${row.environment}/${row.unit_id}/${row.photo_request_id}/${row.id}/${file}`;
}
export class PhotoUploadError extends Error {
  constructor(public readonly code: string, public readonly status = 409) { super(code); }
}

/** Primeiro prova posse usando a conexão restrita/RLS, depois opera só a mesma unidade/ambiente. */
export async function assertPartnerPhoto(ctx: PartnerContext, requestId: string) {
  const owned = await withPartnerContext(ctx.partnerUnitId, async client => client.query(
    'SELECT id FROM commerce.photo_requests WHERE id=$1 AND environment=$2 AND unit_id=$3',
    [requestId,ctx.environment,ctx.unitId]));
  if (owned.rowCount !== 1) throw new PhotoUploadError('photo_request_not_found', 404);
}

export async function reservePhotoUpload(ctx: PartnerContext, requestId: string, uploadId: string) {
  await assertPartnerPhoto(ctx, requestId);
  const state = await withPartnerContext(ctx.partnerUnitId,async client => {
    const request = await client.query<{ status: string; purged: boolean }>(
      `SELECT status,EXISTS (SELECT 1 FROM commerce.photo_request_blobs b
        WHERE b.photo_request_id=p.id AND b.environment=p.environment AND b.deleted_at IS NOT NULL) AS purged
       FROM commerce.photo_requests p WHERE id=$1 AND environment=$2 AND unit_id=$3 FOR UPDATE`,
      [requestId,ctx.environment,ctx.unitId]);
    if (!request.rows[0] || request.rows[0].status === 'cancelled' || request.rows[0].purged) {
      throw new PhotoUploadError('photo_request_not_found',404);
    }
    const prior = await client.query<{ state: string }>(
      'SELECT state FROM commerce.photo_uploads WHERE id=$1 AND photo_request_id=$2 AND environment=$3 AND unit_id=$4',
      [uploadId,requestId,ctx.environment,ctx.unitId]);
    const state = prior.rows[0]?.state ?? 'uploading';
    if (!prior.rowCount) {
      const count = await client.query<{ n: number }>(
        `SELECT (SELECT count(*) FROM commerce.photo_request_blobs WHERE photo_request_id=$1 AND environment=$2)
         + (SELECT count(*) FROM commerce.photo_uploads WHERE photo_request_id=$1 AND environment=$2
            AND state IN ('uploading','queued') AND created_at>now()-interval '24 hours') AS n`,
        [requestId,ctx.environment]);
      if (Number(count.rows[0]?.n) >= 3) throw new PhotoUploadError('photo_limit');
      await client.query(`INSERT INTO commerce.photo_uploads (id,environment,unit_id,photo_request_id)
        VALUES ($1,$2,$3,$4)`, [uploadId,ctx.environment,ctx.unitId,requestId]);
    }
    return state;
  });
  if (state !== 'uploading') return { id: uploadId, state };
  const row = { id: uploadId, photo_request_id: requestId, environment: ctx.environment, unit_id: ctx.unitId };
  return { id: uploadId, state, upload_url: await new TirePhotoStorage().uploadUrl(tirePhotoPath(row,'upload.jpg')) };
}

export async function completePhotoUpload(ctx: PartnerContext, requestId: string, uploadId: string) {
  await assertPartnerPhoto(ctx, requestId);
  return withPartnerContext(ctx.partnerUnitId,async client=> {
    await client.query(`UPDATE commerce.photo_uploads SET state='queued',updated_at=now()
      WHERE id=$1 AND environment=$2 AND unit_id=$3 AND photo_request_id=$4
        AND state='uploading' AND created_at>now()-interval '24 hours'`,[uploadId,ctx.environment,ctx.unitId,requestId]);
    const result=await client.query<{state:string}>(`SELECT state FROM commerce.photo_uploads
      WHERE id=$1 AND environment=$2 AND unit_id=$3 AND photo_request_id=$4 AND created_at>now()-interval '24 hours'`,
      [uploadId,ctx.environment,ctx.unitId,requestId]);
    if (!result.rowCount) throw new PhotoUploadError('photo_upload_not_found',404);
    return {id:uploadId,state:result.rows[0]!.state};
  });
}

export async function photoUploadState(ctx: PartnerContext, requestId: string, uploadId: string) {
  await assertPartnerPhoto(ctx,requestId);
  const result = await withPartnerContext(ctx.partnerUnitId,async client=>client.query<{ state: string; error_code: string | null }>(
    `SELECT state,error_code FROM commerce.photo_uploads
      WHERE id=$1 AND environment=$2 AND unit_id=$3 AND photo_request_id=$4`,
    [uploadId,ctx.environment,ctx.unitId,requestId]));
  if (!result.rowCount) throw new PhotoUploadError('photo_upload_not_found',404);
  return { id: uploadId,...result.rows[0], attached: result.rows[0]!.state === 'ready' };
}
