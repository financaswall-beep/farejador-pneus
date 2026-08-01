import type { Pool, PoolClient } from 'pg';
import { pool as defaultPool } from '../persistence/db.js';
import { env } from '../shared/config/env.js';
import { logger } from '../shared/logger.js';
import {
  extractMetaMessagingReferrals,
  persistObservedMetaReferral,
  reconcilePendingMetaReferrals,
} from './meta-messaging-referrals.js';

const POLL_MS = 5_000;
const MAX_ATTEMPTS = 5;

interface RawMetaEvent {
  id: number;
  payload: unknown;
  received_at: Date;
}

export async function pollMetaMessagingEvents(
  dbPool: Pool = defaultPool,
): Promise<boolean> {
  if (!env.META_MESSAGING_WEBHOOK_ENABLED) return false;
  const client: PoolClient = await dbPool.connect();
  let row: RawMetaEvent | undefined;
  try {
    await client.query('BEGIN');
    const result = await client.query<RawMetaEvent>(
      `SELECT id,payload,received_at
         FROM raw.meta_messaging_events
        WHERE environment=$1 AND processing_status IN ('pending','failed')
          AND attempts<$2
        ORDER BY received_at,id
        LIMIT 1
        FOR UPDATE SKIP LOCKED`,
      [env.FAREJADOR_ENV, MAX_ATTEMPTS],
    );
    row = result.rows[0];
    if (!row) {
      await client.query('COMMIT');
      return false;
    }
    const referrals = extractMetaMessagingReferrals(row.payload, row.received_at);
    for (const referral of referrals) {
      await persistObservedMetaReferral(client, env.FAREJADOR_ENV, row.id, referral);
    }
    await reconcilePendingMetaReferrals(client, env.FAREJADOR_ENV, { rawEventId: row.id });
    await client.query(
      `UPDATE raw.meta_messaging_events
          SET processing_status='processed',processing_error=NULL,processed_at=now(),
              attempts=attempts+1
        WHERE environment=$1 AND id=$2`,
      [env.FAREJADOR_ENV, row.id],
    );
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (row) {
      const summary = error instanceof Error ? error.message.slice(0, 300) : 'unknown';
      await dbPool.query(
        `UPDATE raw.meta_messaging_events
            SET processing_status='failed',processing_error=$3,processed_at=now(),
                attempts=attempts+1
          WHERE environment=$1 AND id=$2`,
        [env.FAREJADOR_ENV, row.id, summary],
      ).catch(() => undefined);
    }
    logger.warn({ err: error, raw_meta_event_id: row?.id }, 'Meta messaging normalization deferred');
    return false;
  } finally {
    client.release();
  }
}

export function startMetaMessagingWorker(): () => void {
  if (!env.META_MESSAGING_WEBHOOK_ENABLED) return () => undefined;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const loop = async (): Promise<void> => {
    if (stopped) return;
    await pollMetaMessagingEvents();
    if (!stopped) timer = setTimeout(() => void loop(), POLL_MS);
  };
  void loop();
  logger.info('Meta messaging referral worker started');
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
