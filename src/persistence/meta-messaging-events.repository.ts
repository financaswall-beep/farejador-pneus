import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { env } from '../shared/config/env.js';

export async function insertRawMetaMessagingEvent(
  client: PoolClient,
  input: {
    rawBody: Buffer;
    signature: string;
    objectType: string;
    payload: unknown;
  },
): Promise<number | null> {
  const payloadSha256 = createHash('sha256').update(input.rawBody).digest('hex');
  const result = await client.query<{ id: number }>(
    `INSERT INTO raw.meta_messaging_events (
       environment,payload_sha256,signature,object_type,payload
     ) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (environment,payload_sha256) DO NOTHING
     RETURNING id`,
    [
      env.FAREJADOR_ENV,
      payloadSha256,
      input.signature,
      input.objectType,
      JSON.stringify(input.payload),
    ],
  );
  return result.rows[0]?.id ?? null;
}
