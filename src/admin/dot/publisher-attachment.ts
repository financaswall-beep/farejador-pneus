import { createHash } from 'node:crypto';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { z } from 'zod';
import { pool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { publisherConfig, requirePublisher } from '../../marketing/publisher/config.js';
import { finalizeMedia, reserveMedia } from '../../marketing/publisher/media.js';
import { MAX_PHOTO_SOURCE_BYTES } from '../../marketing/publisher/media-formats.js';
import { PublisherError, uploadSchema } from '../../marketing/publisher/model.js';
import { PublisherStorage } from '../../marketing/publisher/storage.js';
import type { PoolClient } from 'pg';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { completeIntegrityOperation, operationFingerprint } from '../painel/stage5-integrity.js';
import { lockGrant, transact } from './installment-reviews.js';
import type { DotIdentity } from './token-store.js';
import { downloadPublisherFile } from './publisher-download.js';

export const attachmentInput = z.object({
  arquivo: z.object({ download_url:z.string().url().max(8192), file_id:z.string().min(1).max(256),
    file_name:z.string().max(256).optional(), mime_type:z.string().max(128).optional(),
  }).passthrough(),
  nome:z.string().trim().min(1).max(180).optional(),
  mime:uploadSchema.shape.mime.optional(), idempotency_key:z.string().uuid(),
}).strict();
const extensions: Record<string, string> = {'.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png',
  '.heic':'image/heic','.heif':'image/heif','.webp':'image/webp','.mp4':'video/mp4','.mov':'video/quicktime'};

function fileUuid(actor: string, fileId: string, key: string) {
  const hash = createHash('sha256').update(JSON.stringify(['dot-publisher',env.FAREJADOR_ENV,actor,fileId,key])).digest();
  hash[6] = (hash[6]! & 15) | 80;
  hash[8] = (hash[8]! & 63) | 128;
  return hash.subarray(0,16).toString('hex').replace(/^(........)(....)(....)(....)(............)$/, '$1-$2-$3-$4-$5');
}

async function fileMime(file: string) {
  const source = await open(file, 'r');
  try {
    const head = Buffer.alloc(32);
    const {bytesRead} = await source.read(head, 0, head.length, 0);
    if (bytesRead < 12) return;
    if (head[0] === 255 && head[1] === 216 && head[2] === 255) return 'image/jpeg';
    if (head.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))) return 'image/png';
    if (head.toString('ascii',0,4)==='RIFF' && head.toString('ascii',8,12)==='WEBP') return 'image/webp';
    if (head.toString('ascii',4,8)!=='ftyp') return;
    const brand = head.toString('ascii',8,12);
    if (['heic','heix','hevc','hevx'].includes(brand)) return 'image/heic';
    if (['mif1','msf1'].includes(brand)) return 'image/heif';
    return brand === 'qt  ' ? 'video/quicktime' : 'video/mp4';
  } finally { await source.close(); }
}

export async function assertPublisherPermission(db: PoolClient, identity: DotIdentity) {
  const grant = await lockGrant(db, identity.person_id, identity.grant_id);
  if (!grant.publisher_enabled) throw new McpError(ErrorCode.InvalidRequest,'Publicador em modo de consulta. O dono pode liberar posts em Permissões da Milly.');
  requirePublisher();
  return grant;
}

let activeImports = 0;
async function storeAttachment(input: z.infer<typeof attachmentInput>, identity: DotIdentity) {
  const actor='Milly · '+identity.person_id;
  if (activeImports >= 2) throw new PublisherError('publisher_media_processing_busy', 503);
  activeImports++;
  let directory: string | undefined;
  try {
    const id = fileUuid(identity.grant_id, input.arquivo.file_id, input.idempotency_key);
    const name = input.nome ?? input.arquivo.file_name?.slice(0,180) ?? input.arquivo.file_id.slice(0,180);
    const prior = (await pool.query('SELECT status,name,kind FROM ops.publisher_media WHERE environment=$1 AND id=$2',
      [env.FAREJADOR_ENV,id])).rows[0];
    if (prior?.status === 'ready') return {media_id:id, nome:prior.name, tipo:prior.kind, status:'ready'};
    const storage = new PublisherStorage();
    const policy = await storage.assertPrivateBucket();
    const hint = input.mime ?? input.arquivo.mime_type ?? extensions[extname(name).toLowerCase()];
    const limit = Math.min(publisherConfig().max_file_bytes, policy.maxBytes ?? Infinity, hint?.startsWith('image/') ? MAX_PHOTO_SOURCE_BYTES : Infinity);
    directory = await mkdtemp(join(tmpdir(), 'milly-post-'));
    const file = join(directory, 'source');
    const {bytes,mime} = await downloadPublisherFile(input.arquivo.download_url, file, limit);
    const supplied = [await fileMime(file),input.mime, input.arquivo.mime_type, mime, extensions[extname(name).toLowerCase()]]
      .find(value => uploadSchema.shape.mime.safeParse(value).success);
    const data = uploadSchema.parse({id,name,mime:supplied,bytes});
    const reservation = await reserveMedia(pool, env.FAREJADOR_ENV, data, actor, storage).catch(async error => {
      if (!(error instanceof PublisherError) || error.code !== 'publisher_upload_conflict') throw error;
      const ready = await pool.query("SELECT 1 FROM ops.publisher_media WHERE environment=$1 AND id=$2 AND status='ready'",[env.FAREJADOR_ENV,id]);
      if (!ready.rowCount) throw error;
      return null;
    });
    if (reservation && !reservation.already_uploaded) {
      await transact(async db=>{
        await assertPublisherPermission(db,identity);
        const pending=(await db.query('SELECT status,upload_completed_at FROM ops.publisher_media WHERE environment=$1 AND id=$2 FOR UPDATE',[env.FAREJADOR_ENV,id])).rows[0];
        if (!pending || !['failed','uploading','ready'].includes(pending.status)) throw new PublisherError('publisher_upload_conflict');
        if (pending.status==='ready' || pending.upload_completed_at) return;
        await storage.putFile(reservation.resumable.object, file, data.mime);
        await db.query('UPDATE ops.publisher_media SET upload_completed_at=now() WHERE environment=$1 AND id=$2',[env.FAREJADOR_ENV,id]);
      });
    }
    await finalizeMedia(pool, env.FAREJADOR_ENV, id, {}, storage);
    return {media_id:id, nome:name, tipo:data.mime.startsWith('image/')?'photo':'video', status:'ready'};
  } finally {
    activeImports--;
    if (directory) await rm(directory, {recursive:true, force:true});
  }
}

/** Reserva recuperável: download, Storage e transcodificação não dependem de duas conexões simultâneas. */
export async function importAttachment(identity: DotIdentity, args: unknown) {
  const {input,operation,previous}=await transact(async db=>{
    await assertPublisherPermission(db,identity);
    const input=attachmentInput.parse(args);
    const {file_id,file_name,mime_type}=input.arquivo;
    const operation={environment:env.FAREJADOR_ENV,domain:'dot.importar_midia_publicacao',idempotencyKey:input.idempotency_key,
      fingerprint:operationFingerprint({grant:identity.grant_id, file_id,file_name,mime_type,nome:input.nome,mime:input.mime})};
    const params=[operation.environment,operation.domain,operation.idempotencyKey];
    await db.query(`INSERT INTO audit.operation_idempotency(environment,domain,idempotency_key,request_fingerprint)
      VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,[...params,operation.fingerprint]);
    const row=(await db.query(`SELECT request_fingerprint,result FROM audit.operation_idempotency
      WHERE environment=$1 AND domain=$2 AND idempotency_key=$3 FOR UPDATE`,params)).rows[0];
    if (row.request_fingerprint!==operation.fingerprint) throw Error('idempotency_conflict');
    return {input,operation,previous:row.result as object|null};
  });
  if (previous) return previous;
  const result=await storeAttachment(input,identity);
  return transact(async db=>{
    await assertPublisherPermission(db,identity);
    const saved=(await db.query(`SELECT result FROM audit.operation_idempotency
      WHERE environment=$1 AND domain=$2 AND idempotency_key=$3 FOR UPDATE`,
      [operation.environment,operation.domain,operation.idempotencyKey])).rows[0];
    if (saved?.result) return saved.result as object;
    await completeIntegrityOperation(db,operation,'ops.publisher_media',result.media_id,result);
    return result;
  });
}
