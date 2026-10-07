import type { PoolClient } from 'pg';
import { resolveConversationOnce, sendAttachmentOnce, sendMessageOnce, type SendMessageResult } from './sender.js';
import type { OutboundRow } from './outbound-worker.js';
import { readStoredTirePhoto, type StoredTirePhoto } from '../photos/storage.js';
import { tirePhotoForWhatsApp } from '../photos/codec.js';

export async function deliverOutboundRow(
  client: PoolClient,
  row: OutboundRow,
): Promise<SendMessageResult> {
  if (row.kind === 'operator_attachment') {
    const result = await client.query<{ bytes: Buffer; mime: string; filename: string }>(
      `SELECT bytes,mime,filename FROM ops.operator_messages WHERE environment=$1 AND outbound_id=$2`,
      [row.environment, row.id]);
    const file = result.rows[0];
    if (!file?.bytes) throw Error('operator_attachment_missing');
    return sendAttachmentOnce(Number(row.chatwoot_conversation_id), {
      buffer: file.bytes, filename: file.filename, contentType: file.mime,
    }, row.body, row.echo_id ?? undefined);
  }
  if (row.kind === 'conversation_resolution') {
    await resolveConversationOnce(Number(row.chatwoot_conversation_id));
    return { chatwootMessageId: null };
  }
  if (row.kind !== 'photo_attachment') {
    return sendMessageOnce(Number(row.chatwoot_conversation_id), row.body, row.echo_id ?? undefined);
  }
  const parsed = JSON.parse(row.body) as { photo_request_id?: unknown; photo_blob_id?: unknown; caption?: unknown };
  if (typeof parsed.photo_request_id !== 'string' || typeof parsed.caption !== 'string') {
    throw new Error('invalid photo attachment outbox payload');
  }
  if (parsed.photo_blob_id !== undefined && typeof parsed.photo_blob_id !== 'string') throw Error('invalid photo blob id');
  const blob = await client.query<StoredTirePhoto>(
    `SELECT photo_bytes AS bytes,photo_mime AS mime,storage_path FROM commerce.photo_request_blobs
      WHERE environment=$1 AND photo_request_id=$2 AND deleted_at IS NULL
        AND ($3::uuid IS NULL OR id=$3) ORDER BY created_at,id LIMIT 1`,
    [row.environment, parsed.photo_request_id, parsed.photo_blob_id ?? null],
  );
  const photo = await readStoredTirePhoto(blob.rows[0]);
  if (!photo) throw new Error('photo attachment blob missing');
  const jpeg = await tirePhotoForWhatsApp(photo.bytes,photo.mime);
  return sendAttachmentOnce(Number(row.chatwoot_conversation_id), {
    buffer: jpeg.bytes,
    filename: `pneu-${parsed.photo_request_id.slice(0, 8)}.jpg`,
    contentType: jpeg.mime,
  }, parsed.caption, row.echo_id ?? undefined);
}

export async function markPhotoRequestSent(
  client: PoolClient,
  row: OutboundRow,
): Promise<void> {
  if (row.kind === 'operator_attachment') {
    await client.query(`UPDATE commerce.photo_requests p SET status='sent',sent_to_customer_at=now()
      FROM ops.operator_messages m WHERE m.environment=$1 AND m.outbound_id=$2
      AND p.environment=m.environment AND p.id=m.photo_request_id AND p.status='answered'`,
    [row.environment,row.id]);
    return;
  }
  if (row.kind !== 'photo_attachment') return;
  const parsed = JSON.parse(row.body) as { photo_request_id?: unknown };
  if (typeof parsed.photo_request_id !== 'string') {
    throw new Error('invalid photo attachment outbox payload after send');
  }
  await client.query(
    `UPDATE commerce.photo_requests SET status='sent',sent_to_customer_at=now()
      WHERE environment=$1 AND id=$2 AND status='answered'`,
    [row.environment, parsed.photo_request_id],
  );
}
