import type { PoolClient } from 'pg';
import { sendAttachmentOnce, sendMessageOnce, type SendMessageResult } from './sender.js';
import type { OutboundRow } from './outbound-worker.js';

export async function deliverOutboundRow(
  client: PoolClient,
  row: OutboundRow,
): Promise<SendMessageResult> {
  if (row.kind !== 'photo_attachment') {
    return sendMessageOnce(Number(row.chatwoot_conversation_id), row.body, row.echo_id ?? undefined);
  }
  const parsed = JSON.parse(row.body) as { photo_request_id?: unknown; caption?: unknown };
  if (typeof parsed.photo_request_id !== 'string' || typeof parsed.caption !== 'string') {
    throw new Error('invalid photo attachment outbox payload');
  }
  const blob = await client.query<{ photo_bytes: Buffer; photo_mime: string }>(
    `SELECT photo_bytes,photo_mime FROM commerce.photo_request_blobs
      WHERE environment=$1 AND photo_request_id=$2`,
    [row.environment, parsed.photo_request_id],
  );
  const photo = blob.rows[0];
  if (!photo) throw new Error('photo attachment blob missing');
  return sendAttachmentOnce(Number(row.chatwoot_conversation_id), {
    buffer: photo.photo_bytes,
    filename: `pneu-${parsed.photo_request_id.slice(0, 8)}.jpg`,
    contentType: photo.photo_mime,
  }, parsed.caption);
}

export async function markPhotoRequestSent(
  client: PoolClient,
  row: OutboundRow,
): Promise<void> {
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
