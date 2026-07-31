import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { pool as defaultPool } from '../persistence/db.js';
import { env } from '../shared/config/env.js';
import { logger } from '../shared/logger.js';
import {
  loadProductionCapiSources,
  type CapiSourceRow,
} from './capi-source.js';
import { sendCapiPayload } from './capi-transport.js';

const MAX_ATTEMPTS = 5;
const META_MAX_EVENT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const WORKER_ID = `marketing-capi-${randomUUID().slice(0, 8)}`;

export interface CapiOutboxRow {
  id: string;
  environment: 'prod' | 'test';
  payload: Record<string, unknown>;
  attempts: number;
  attribution_id: string;
  campaign_scope_id: string | null;
}

function normalize(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase().normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');
  return normalized.length > 0 ? normalized : null;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function hashed(value: string | null): string[] | undefined {
  const normalized = normalize(value);
  return normalized ? [sha256(normalized)] : undefined;
}

export function buildCapiPayload(row: CapiSourceRow, options: {
  whatsappBusinessAccountId: string;
  pageId?: string;
  testEventCode?: string;
  extendedMatching?: boolean;
}): Record<string, unknown> {
  const phone = row.phone_e164?.replace(/\D/g, '') ?? '';
  const userData: Record<string, unknown> = {
    ctwa_clid: row.ctwa_clid,
    whatsapp_business_account_id: options.whatsappBusinessAccountId,
  };
  if (options.pageId) userData.page_id = options.pageId;
  if (phone) userData.ph = [sha256(phone)];
  if (options.extendedMatching) {
    const city = hashed(row.city_name);
    const state = hashed(row.state_code);
    const postal = hashed(row.postal_code_prefix?.replace(/\D/g, '') ?? null);
    if (city) userData.ct = city;
    if (state) userData.st = state;
    if (postal) userData.zp = postal;
    userData.country = [sha256('br')];
  }
  const payload: Record<string, unknown> = {
    data: [{
      event_name: 'Purchase',
      event_time: Math.floor(new Date(row.realized_at).getTime() / 1000),
      event_id: row.order_number,
      action_source: 'business_messaging',
      messaging_channel: 'whatsapp',
      user_data: userData,
      custom_data: {
        value: Math.round(Number(row.total_amount) * 100) / 100,
        currency: 'BRL',
        order_id: row.order_number,
      },
    }],
  };
  if (options.testEventCode) payload.test_event_code = options.testEventCode;
  return payload;
}

export async function enqueueCapiPurchases(options: {
  dbPool?: Pool;
  enabled?: boolean;
} = {}): Promise<number> {
  const enabled = options.enabled ?? env.MARKETING_CAPI_ENABLED;
  if (!enabled) return 0;
  if (!env.META_WHATSAPP_BUSINESS_ACCOUNT_ID) {
    throw new Error('marketing_capi_waba_not_configured');
  }
  const dbPool = options.dbPool ?? defaultPool;
  const source = await loadProductionCapiSources(dbPool);
  let enqueued = 0;
  for (const row of source) {
    const payload = buildCapiPayload(row, {
      whatsappBusinessAccountId: env.META_WHATSAPP_BUSINESS_ACCOUNT_ID,
      pageId: env.META_CAPI_PAGE_ID,
      extendedMatching: env.CAPI_EXTENDED_MATCHING,
    });
    const inserted = await dbPool.query(
      `INSERT INTO marketing.capi_outbox
         (environment,attribution_id,campaign_scope_id,event_name,event_id,payload)
       VALUES ($1,$2,$3,'Purchase',$4,$5)
       ON CONFLICT (environment,event_name,event_id) DO UPDATE
         SET attribution_id=EXCLUDED.attribution_id,
             campaign_scope_id=EXCLUDED.campaign_scope_id,
             payload=EXCLUDED.payload,status='pending',attempts=0,not_before=now(),
             suppressed_at=NULL,suppression_reason=NULL,updated_at=now()
       WHERE marketing.capi_outbox.status='suppressed'`,
      [
        env.FAREJADOR_ENV,
        row.attribution_id,
        row.campaign_scope_id,
        row.order_number,
        JSON.stringify(payload),
      ],
    );
    enqueued += inserted.rowCount ?? 0;
  }
  return enqueued;
}

async function pickCapiEvent(client: PoolClient): Promise<CapiOutboxRow | null> {
  await client.query(
    `UPDATE marketing.capi_outbox
        SET status='failed',not_before=now(),locked_at=NULL,locked_by=NULL,
            last_error_code='worker_restarted',last_error_kind='retryable',
            last_error_summary='processing lease expired',updated_at=now()
      WHERE environment=$1 AND status='processing'
        AND locked_at<now()-interval '10 minutes'`,
    [env.FAREJADOR_ENV],
  );
  const result = await client.query<CapiOutboxRow>(
    `WITH candidate AS (
       SELECT id FROM marketing.capi_outbox
        WHERE environment=$1 AND status IN ('pending','failed') AND not_before<=now()
        ORDER BY not_before,created_at LIMIT 1 FOR UPDATE SKIP LOCKED
     )
     UPDATE marketing.capi_outbox q
        SET status='processing',attempts=attempts+1,locked_at=now(),locked_by=$2,updated_at=now()
       FROM candidate c WHERE q.id=c.id
     RETURNING q.id,q.environment,q.payload,q.attempts,q.attribution_id,
               q.campaign_scope_id`,
    [env.FAREJADOR_ENV, WORKER_ID],
  );
  return result.rows[0] ?? null;
}

async function lockCapiCampaignScope(
  client: PoolClient,
  row: CapiOutboxRow,
): Promise<'matrix' | 'pending' | 'external' | 'unresolved'> {
  if (!row.campaign_scope_id) return 'unresolved';
  const result = await client.query<{ scope: 'matrix' | 'pending' | 'external' }>(
    `SELECT s.scope
       FROM marketing.campaign_scopes s
       JOIN marketing.capi_outbox q
         ON q.environment=s.environment AND q.campaign_scope_id=s.id
      WHERE q.environment=$1 AND q.id=$2
      FOR SHARE OF s`,
    [row.environment, row.id],
  );
  return result.rows[0]?.scope ?? 'unresolved';
}

function capiPayloadExpired(payload: Record<string, unknown>, now: Date): boolean {
  const data = Array.isArray(payload.data) ? payload.data : [];
  const event = data[0];
  if (!event || typeof event !== 'object') return false;
  const eventTime = Number((event as Record<string, unknown>).event_time);
  return Number.isFinite(eventTime)
    && eventTime * 1000 < now.getTime() - META_MAX_EVENT_AGE_MS;
}

export async function pollCapiOutbox(options: {
  dbPool?: Pool;
  fetcher?: typeof fetch;
  now?: Date;
  scopeEnforcement?: boolean;
} = {}): Promise<boolean> {
  const dbPool = options.dbPool ?? defaultPool;
  const client = await dbPool.connect();
  let row: CapiOutboxRow | null = null;
  try {
    await client.query('BEGIN');
    row = await pickCapiEvent(client);
    await client.query('COMMIT');
    if (!row) return false;
    await client.query('BEGIN');
    const scopeEnforcement = options.scopeEnforcement
      ?? env.MARKETING_SCOPE_ENFORCEMENT_ENABLED;
    const campaignScope = scopeEnforcement
      ? await lockCapiCampaignScope(client, row)
      : 'matrix';
    if (scopeEnforcement && campaignScope !== 'matrix') {
      await client.query(
        `UPDATE marketing.capi_outbox
            SET status='suppressed',locked_at=NULL,locked_by=NULL,
                suppressed_at=now(),suppression_reason=$3,updated_at=now()
          WHERE environment=$1 AND id=$2`,
        [row.environment, row.id, `campaign_scope_${campaignScope}`],
      );
      await client.query('COMMIT');
      return true;
    }
    if (capiPayloadExpired(row.payload, options.now ?? new Date())) {
      await client.query(
        `UPDATE marketing.capi_outbox
            SET status='dead_letter',locked_at=NULL,locked_by=NULL,
                last_error_code='event_time_expired',last_error_kind='terminal',
                last_error_summary='event_time older than 7 days',
                dead_lettered_at=now(),updated_at=now()
          WHERE environment=$1 AND id=$2`,
        [row.environment, row.id],
      );
      await client.query('COMMIT');
      return true;
    }
    const ack = await sendCapiPayload(row.payload, { fetcher: options.fetcher });
    await client.query(
      `UPDATE marketing.capi_outbox
          SET status='sent',events_received=$2,fbtrace_id=$3,sent_at=now(),
              locked_at=NULL,locked_by=NULL,last_error_code=NULL,last_error_kind=NULL,
              last_error_summary=NULL,updated_at=now()
        WHERE environment=$1 AND id=$4`,
      [row.environment, ack.eventsReceived, ack.fbtraceId, row.id],
    );
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (row) {
      const terminal = row.attempts >= MAX_ATTEMPTS;
      const summary = error instanceof Error ? error.message.slice(0, 200) : 'unknown';
      await client.query(
        `UPDATE marketing.capi_outbox
            SET status=$2,not_before=CASE WHEN $2='failed'
                 THEN now()+(LEAST(900,30*power(2,$3-1))||' seconds')::interval
                 ELSE not_before END,
                locked_at=NULL,locked_by=NULL,last_error_code=$4,
                last_error_kind=$5,last_error_summary=$6,
                dead_lettered_at=CASE WHEN $2='dead_letter' THEN now() ELSE NULL END,
                updated_at=now()
          WHERE environment=$1 AND id=$7`,
        [
          row.environment, terminal ? 'dead_letter' : 'failed', row.attempts,
          summary.split(':')[0], terminal ? 'terminal' : 'retryable', summary, row.id,
        ],
      );
    } else {
      logger.error({ err: error }, 'marketing CAPI poll failed');
    }
    return false;
  } finally {
    client.release();
  }
}

export function startMarketingCapiWorker(): () => void {
  if (!env.MARKETING_CAPI_ENABLED) return () => undefined;
  let stopped = false;
  const loop = async (): Promise<void> => {
    if (stopped) return;
    await pollCapiOutbox();
    if (!stopped) setTimeout(() => void loop(), env.MARKETING_CAPI_POLL_MS);
  };
  void loop();
  logger.info({ worker_id: WORKER_ID }, 'marketing CAPI worker started');
  return () => { stopped = true; };
}
