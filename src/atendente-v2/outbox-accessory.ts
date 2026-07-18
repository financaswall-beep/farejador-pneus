import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { Environment } from '../shared/types/chatwoot.js';

type Queryable = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export async function enqueueAccessoryText(
  db: Queryable,
  input: { environment: Environment; chatwootConversationId: number; kind: 'survey_text' | 'photo_text';
    body: string; idempotencyKey: string },
): Promise<boolean> {
  const result = await db.query(
    `INSERT INTO ops.outbound_messages (
       environment,conversation_id,chatwoot_conversation_id,echo_id,kind,body,body_sha256,status
     )
     SELECT $1,c.id,$2,$3,$4,$5,$6,'pending'
       FROM core.conversations c
      WHERE c.environment=$1 AND c.chatwoot_conversation_id=$2
     ON CONFLICT (environment,echo_id) WHERE echo_id IS NOT NULL DO NOTHING`,
    [input.environment, input.chatwootConversationId, input.idempotencyKey,
      input.kind, input.body, hash(input.body)],
  );
  return result.rowCount === 1;
}

export async function enqueuePhotoAttachment(
  db: Queryable,
  input: { environment: Environment; chatwootConversationId: number;
    photoRequestId: string; caption: string },
): Promise<boolean> {
  const body = JSON.stringify({ photo_request_id: input.photoRequestId, caption: input.caption });
  const result = await db.query(
    `INSERT INTO ops.outbound_messages (
       environment,conversation_id,chatwoot_conversation_id,echo_id,kind,body,body_sha256,status
     )
     SELECT $1,c.id,$2,$3,'photo_attachment',$4,$5,'pending'
       FROM core.conversations c
      WHERE c.environment=$1 AND c.chatwoot_conversation_id=$2
     ON CONFLICT (environment,echo_id) WHERE echo_id IS NOT NULL DO NOTHING`,
    [input.environment, input.chatwootConversationId,
      `photo:${input.photoRequestId}`, body, hash(body)],
  );
  return result.rowCount === 1;
}
