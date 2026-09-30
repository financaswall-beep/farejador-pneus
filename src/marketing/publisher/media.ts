import type { Pool } from 'pg';
import sharp from 'sharp';
import type { z } from 'zod';
import { publisherConfig } from './config.js';
import { PublisherError, type Environment, type uploadSchema, type finalizeSchema } from './model.js';
import { PublisherStorage, type BucketPolicy } from './storage.js';
import { decodeHeic, inspectVideo, type MediaInspection } from './media-inspection.js';
import { withMediaSlot } from './media-process.js';

export interface Media {
  id: string; name: string; kind: 'photo' | 'video'; mime: string; bytes: string; status: string;
  original_path: string; publish_path: string | null; thumbnail_path: string | null;
  width: number | null; height: number | null; duration: string | null;
  inspection?: MediaInspection; error_code?: string | null;
  upload_completed_at?: Date | null; updated_at?: Date;
}
const PHOTO_BYTES = 8 * 1024 * 1024;
const THUMB_BYTES = 256 * 1024;
const extensions: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif',
  'video/mp4': 'mp4', 'video/quicktime': 'mov',
};
export function assertUploadPolicy(policy: BucketPolicy, bytes: number, mime: string): void {
  if (policy.maxBytes !== null && bytes > policy.maxBytes) throw new PublisherError('publisher_bucket_file_limit', 413);
  if (policy.allowedMimes && !policy.allowedMimes.some(allowed => allowed === mime || allowed === '*' || allowed === mime.split('/')[0] + '/*')) {
    throw new PublisherError('publisher_bucket_mime_rejected', 400);
  }
}

export async function reserveMedia(pool: Pool, environment: Environment, data: z.infer<typeof uploadSchema>,
  actor: string, storage = new PublisherStorage()) {
  const config = publisherConfig();
  const kind = data.mime.startsWith('image/') ? 'photo' : 'video';
  if (data.bytes > config.max_file_bytes || kind === 'photo' && data.bytes > PHOTO_BYTES) {
    throw new PublisherError('publisher_media_too_large', 413);
  }
  const policy = await storage.assertPrivateBucket();
  assertUploadPolicy(policy, data.bytes, data.mime);
  // Toda mídia terá miniatura JPEG, mesmo quando o original for vídeo ou HEIC.
  assertUploadPolicy(policy, THUMB_BYTES, 'image/jpeg');
  const client = await pool.connect();
  const path = `${environment}/${data.id}/original.${extensions[data.mime]}`;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`publisher-library:${environment}`]);
    const prior = (await client.query<Media>('SELECT * FROM ops.publisher_media WHERE environment=$1 AND id=$2 FOR UPDATE', [environment, data.id])).rows[0];
    if (prior && (!['uploading', 'failed'].includes(prior.status) || prior.mime !== data.mime || Number(prior.bytes) !== data.bytes || prior.name !== data.name)) {
      throw new PublisherError('publisher_upload_conflict');
    }
    if (!prior) {
      const usage = await client.query<{ bytes: string }>(`SELECT coalesce(sum(CASE WHEN status='deleted'
        THEN CASE WHEN thumbnail_path IS NOT NULL THEN 262144 ELSE 0 END
        ELSE bytes+262144+CASE WHEN kind='photo' THEN 8388608 ELSE 0 END END),0)::text bytes
        FROM ops.publisher_media WHERE environment=$1 AND status IN ('uploading','ready','deleting','failed','deleted')`, [environment]);
      const reservation = data.bytes + THUMB_BYTES + (kind === 'photo' ? PHOTO_BYTES : 0);
      if (Number(usage.rows[0]?.bytes) + reservation > config.library_limit_bytes) throw new PublisherError('publisher_library_full', 413);
      await client.query(`INSERT INTO ops.publisher_media(environment,id,name,kind,mime,bytes,original_path,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [environment, data.id, data.name, kind, data.mime, data.bytes, path, actor]);
    } else {
      await client.query(`UPDATE ops.publisher_media SET updated_at=now() WHERE environment=$1 AND id=$2`, [environment, data.id]);
    }
    let alreadyUploaded = false;
    if (prior) {
      try {
        const object = await storage.info(path);
        alreadyUploaded = object.bytes === data.bytes && object.mime === data.mime;
      } catch (error) {
        if (!(error instanceof PublisherError) || error.code !== 'publisher_storage_object_missing') throw error;
      }
    }
    const session = await storage.uploadSession(path);
    await client.query('COMMIT');
    return { id: data.id, ...session, already_uploaded: alreadyUploaded };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export function validVideoHeader(buffer: Buffer): boolean {
  return buffer.length >= 12 && buffer.subarray(4, 8).toString() === 'ftyp';
}
async function processPhoto(storage: PublisherStorage, media: Media, policy: BucketPolicy,
  environment: Environment, id: string) {
  let image = await storage.read(media.original_path, PHOTO_BYTES);
  if (['image/heic', 'image/heif'].includes(media.mime)) image = await decodeHeic(image);
  const processor = sharp(image, { limitInputPixels: 40_000_000 }).rotate();
  const meta = await processor.metadata();
  if (!['jpeg', 'png', 'webp'].includes(meta.format ?? '')) throw new PublisherError('publisher_media_invalid', 400);
  const jpeg = await processor.clone().resize({ width: 1440, height: 2560, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 90 }).toBuffer({ resolveWithObject: true });
  if (jpeg.data.length > PHOTO_BYTES) throw new PublisherError('publisher_media_too_large', 413);
  const thumbnail = await processor.clone().resize(400, 400, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 72 }).toBuffer();
  const publishPath = `${environment}/${id}/publish.jpg`;
  assertUploadPolicy(policy, jpeg.data.length, 'image/jpeg');
  await storage.put(publishPath, jpeg.data);
  return { publishPath, thumbnail, width: jpeg.info.width, height: jpeg.info.height,
    duration: null, inspection: { verified: true } as MediaInspection };
}

/** Metadados recebidos do navegador não autorizam publicação; o servidor inspeciona o arquivo real. */
export async function finalizeMedia(pool: Pool, environment: Environment, id: string,
  _data: z.infer<typeof finalizeSchema>, storage = new PublisherStorage(), videoInspector = inspectVideo) {
  return withMediaSlot(async () => {
    const policy = await storage.assertPrivateBucket();
    const client = await pool.connect();
    let media: Media | undefined;
    let completed = false;
    try {
      await client.query('BEGIN');
      media = (await client.query<Media>('SELECT * FROM ops.publisher_media WHERE environment=$1 AND id=$2 FOR UPDATE', [environment, id])).rows[0];
      if (!media) throw new PublisherError('publisher_media_not_found', 404);
      if (media.status === 'ready' && (media.kind === 'photo' || media.inspection?.verified)) {
        await client.query('COMMIT');
        return { id };
      }
      if (!['uploading', 'failed', 'ready'].includes(media.status)) throw new PublisherError('publisher_upload_conflict');
      const info = await storage.info(media.original_path);
      if (info.bytes !== Number(media.bytes) || info.mime !== media.mime) throw new PublisherError('publisher_upload_mismatch', 400);
      completed = true;
      assertUploadPolicy(policy, info.bytes, info.mime);
      if (media.kind === 'video' && !validVideoHeader(await storage.read(media.original_path, 32, true))) {
        throw new PublisherError('publisher_media_invalid', 400);
      }
      const result = media.kind === 'photo' ? await processPhoto(storage, media, policy, environment, id)
        : { ...(await videoInspector(storage, media.original_path, info.bytes)), publishPath: media.original_path };
      if (result.thumbnail.length > THUMB_BYTES) throw new PublisherError('publisher_media_invalid', 400);
      assertUploadPolicy(policy, result.thumbnail.length, 'image/jpeg');
      const thumbnail = `${environment}/${id}/thumbnail.jpg`;
      await storage.put(thumbnail, result.thumbnail);
      await client.query(`UPDATE ops.publisher_media SET status='ready',publish_path=$3,thumbnail_path=$4,width=$5,height=$6,
        duration=$7,inspection=$8,error_code=NULL,upload_completed_at=coalesce(upload_completed_at,now()),updated_at=now()
        WHERE environment=$1 AND id=$2`, [environment, id, result.publishPath, thumbnail, result.width, result.height,
        result.duration, JSON.stringify(result.inspection)]);
      await client.query('COMMIT');
      return { id };
    } catch (error) {
      await client.query('ROLLBACK');
      const incomplete = error instanceof PublisherError && error.code === 'publisher_storage_object_missing';
      const failure = incomplete ? new PublisherError('publisher_upload_incomplete')
        : error instanceof PublisherError ? error : new PublisherError('publisher_media_invalid', 400);
      if (media && ['uploading', 'failed', 'ready'].includes(media.status)) {
        await client.query(`UPDATE ops.publisher_media SET status=$3,error_code=$4,
          upload_completed_at=CASE WHEN $6 THEN NULL WHEN $5 THEN coalesce(upload_completed_at,now()) ELSE upload_completed_at END,updated_at=now()
          WHERE environment=$1 AND id=$2 AND status IN ('uploading','failed','ready')`,
        [environment, id, incomplete ? 'uploading' : 'failed', failure.code, completed, incomplete]);
      }
      throw failure;
    } finally { client.release(); }
  });
}

/** Falhas por miniatura são isoladas e a concorrência de assinaturas fica limitada. */
export async function listMedia(pool: Pool, environment: Environment, storage = new PublisherStorage()) {
  const media = (await pool.query<Media>(`SELECT id,name,kind,mime,bytes,status,original_path,publish_path,thumbnail_path,
    width,height,duration,inspection,error_code,upload_completed_at,updated_at FROM ops.publisher_media
    WHERE environment=$1 AND status IN ('ready','uploading','failed') ORDER BY created_at DESC LIMIT 100`, [environment])).rows;
  const results: { [key: string]: unknown }[] = [];
  for (let offset = 0; offset < media.length; offset += 8) {
    results.push(...await Promise.all(media.slice(offset, offset + 8).map(async ({ original_path: _original,
      publish_path: _publish, thumbnail_path, ...item }) => {
      let thumbnail_url: string | null = null;
      let thumbnail_error = false;
      if (thumbnail_path) {
        try { thumbnail_url = await storage.signedUrl(thumbnail_path); } catch { thumbnail_error = true; }
      }
      return { ...item, thumbnail_url, thumbnail_error,
        can_finalize: ['uploading', 'failed'].includes(item.status)
          || item.status === 'ready' && item.kind === 'video' && !item.inspection?.verified };
    })));
  }
  return results;
}
