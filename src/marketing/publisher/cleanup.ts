import type { Pool } from 'pg';
import { PublisherError, type Environment } from './model.js';
import type { Media } from './media.js';
import { PublisherStorage } from './storage.js';

// A assinatura pode iniciar um envio por 2h, e a sessão TUS dura até 24h.
// Mantemos a exclusão pendente por 27h para limpar bytes que outra aba termine depois.
// https://supabase.com/docs/guides/storage/uploads/resumable-uploads#upload-url
const CANCELLED_UPLOAD = 'publisher_upload_cancelled';
const CANCELLED_UPLOAD_GRACE_HOURS = 27;

/** Falha de processamento não autoriza apagar um arquivo totalmente recebido. */
export async function deleteMedia(pool: Pool, environment: Environment, id: string,
  automatic: boolean, storage = new PublisherStorage()): Promise<boolean> {
  const client = await pool.connect();
  let media: Media | undefined;
  try {
    await client.query('BEGIN');
    media = (await client.query<Media>('SELECT * FROM ops.publisher_media WHERE environment=$1 AND id=$2 FOR UPDATE', [environment, id])).rows[0];
    if (!media) throw new PublisherError('publisher_media_not_found', 404);
    if (media.status === 'deleted') {
      await client.query('COMMIT');
      return true;
    }
    const expired = Boolean((await client.query(`SELECT 1 FROM ops.publisher_media
      WHERE environment=$1 AND id=$2 AND updated_at<now()-interval '24 hours'`, [environment, id])).rowCount);
    const references = await client.query<{ id: string }>(`SELECT p.id FROM ops.publisher_posts p
      WHERE p.environment=$1 AND p.media_id=$2 AND
      (p.status NOT IN ('published','cancelled') OR ($3::boolean AND p.status='published' AND NOT p.delete_after_publish)
        OR EXISTS (SELECT 1 FROM ops.publisher_destinations d WHERE d.environment=p.environment AND d.post_id=p.id
          AND d.status<>'published' AND p.status<>'cancelled'))`, [environment, id, automatic]);
    if (references.rowCount) {
      if (!automatic) throw new PublisherError('publisher_media_in_use');
      await client.query('COMMIT');
      return false;
    }
    if (automatic && media.status !== 'deleting') {
      const published = await client.query(`SELECT 1 FROM ops.publisher_posts
        WHERE environment=$1 AND media_id=$2 AND status='published' AND delete_after_publish`, [environment, id]);
      const pending = ['uploading', 'failed'].includes(media.status) && !media.upload_completed_at && expired;
      if (!published.rowCount && !pending) {
        await client.query('COMMIT');
        return false;
      }
      if (pending && !published.rowCount) {
        // A energia pode ter acabado depois do upload e antes de registrar sua conclusão.
        // Ausência de timestamp não comprova que o objeto está incompleto.
        try {
          const object = await storage.info(media.original_path);
          if (object.bytes === Number(media.bytes) && object.mime === media.mime) {
            await client.query(`UPDATE ops.publisher_media SET status='failed',upload_completed_at=now(),
              error_code='publisher_processing_required',updated_at=now() WHERE environment=$1 AND id=$2`, [environment, id]);
            await client.query('COMMIT');
            return false;
          }
        } catch (error) {
          if (!(error instanceof PublisherError) || error.code !== 'publisher_storage_object_missing') throw error;
        }
      }
    }
    const cancelPendingUpload = !automatic && ['uploading', 'failed'].includes(media.status) && !media.upload_completed_at;
    await client.query(`UPDATE ops.publisher_media SET status='deleting',
      error_code=CASE WHEN $3 THEN $4 ELSE error_code END,
      updated_at=CASE WHEN status='deleting' THEN updated_at ELSE now() END
      WHERE environment=$1 AND id=$2`, [environment, id, cancelPendingUpload, CANCELLED_UPLOAD]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
  // deleting retira da biblioteca e bloqueia retomada, conferência e novos rascunhos.
  // Remoção explícita não exige original completo. Miniatura leve é preservada no histórico.
  await storage.remove([media.original_path,
    ...(media.kind === 'photo' ? [`${environment}/${id}/publish.jpg`] : []),
    ...(media.publish_path ? [media.publish_path] : []),
    ...(!media.thumbnail_path ? [`${environment}/${id}/thumbnail.jpg`] : [])]);
  await pool.query(`UPDATE ops.publisher_media SET status='deleted',deleted_at=now(),updated_at=now()
    WHERE environment=$1 AND id=$2 AND status='deleting'
      AND (error_code IS DISTINCT FROM $3 OR updated_at<now()-$4*interval '1 hour')`,
  [environment, id, CANCELLED_UPLOAD, CANCELLED_UPLOAD_GRACE_HOURS]);
  return true;
}

export async function cleanupMedia(pool: Pool, environment: Environment, storage = new PublisherStorage()) {
  const ids = (await pool.query<{ id: string }>(`SELECT m.id FROM ops.publisher_media m WHERE m.environment=$1 AND
    (m.status='deleting' AND (m.error_code IS DISTINCT FROM $2 OR m.updated_at<now()-$3*interval '1 hour')
      OR m.status IN ('uploading','failed') AND m.upload_completed_at IS NULL AND m.updated_at<now()-interval '24 hours'
      OR m.status='ready' AND EXISTS(SELECT 1 FROM ops.publisher_posts p WHERE p.environment=m.environment
        AND p.media_id=m.id AND p.status='published' AND p.delete_after_publish))
    ORDER BY m.updated_at LIMIT 20`, [environment, CANCELLED_UPLOAD, CANCELLED_UPLOAD_GRACE_HOURS])).rows;
  let failure: unknown;
  for (const { id } of ids) {
    try { await deleteMedia(pool, environment, id, true, storage); }
    catch (error) { failure ??= error; }
  }
  // Um erro não impede limpar outros objetos elegíveis, mas continua visível no log do worker.
  if (failure) throw failure;
}
