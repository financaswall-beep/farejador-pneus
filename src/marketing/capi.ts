import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { pool as defaultPool } from '../persistence/db.js';
import { env } from '../shared/config/env.js';
import { logger } from '../shared/logger.js';

const MAX_ATTEMPTS = 5;
const WORKER_ID = `marketing-capi-${randomUUID().slice(0, 8)}`;

interface CapiSourceRow {
  attribution_id: string;
  order_number: string;
  total_amount: string;
  realized_at: string;
  phone_e164: string | null;
  ctwa_clid: string;
  city_name: string | null;
  state_code: string | null;
  postal_code_prefix: string | null;
}

export interface CapiOutboxRow {
  id: string;
  environment: 'prod' | 'test';
  payload: Record<string, unknown>;
  attempts: number;
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
  const source = await dbPool.query<CapiSourceRow>(
    `SELECT a.id AS attribution_id,o.order_number,o.total_amount::text,
            a.realized_at::text,c.phone_e164,r.ctwa_clid,
            g.city_name,g.state_code,g.postal_code_prefix
       FROM marketing.order_attributions a
       JOIN marketing.ad_referrals r
         ON r.environment=a.environment AND r.id=a.referral_id
       JOIN commerce.orders o
         ON o.environment=a.environment AND o.id=a.order_id
       JOIN core.contacts c
         ON c.environment=o.environment AND c.id=o.contact_id
       LEFT JOIN commerce.geo_resolutions g
         ON g.environment=o.environment AND g.id=o.geo_resolution_id
      WHERE a.environment=$1 AND a.status='active' AND a.superseded_by IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM marketing.capi_outbox q
           WHERE q.environment=a.environment AND q.attribution_id=a.id
        )
      ORDER BY a.realized_at,a.id`,
    [env.FAREJADOR_ENV],
  );
  let enqueued = 0;
  for (const row of source.rows) {
    const payload = buildCapiPayload(row, {
      whatsappBusinessAccountId: env.META_WHATSAPP_BUSINESS_ACCOUNT_ID,
      pageId: env.META_CAPI_PAGE_ID,
      testEventCode: env.META_CAPI_TEST_EVENT_CODE,
      extendedMatching: env.CAPI_EXTENDED_MATCHING,
    });
    const inserted = await dbPool.query(
      `INSERT INTO marketing.capi_outbox
         (environment,attribution_id,event_name,event_id,payload)
       VALUES ($1,$2,'Purchase',$3,$4)
       ON CONFLICT (environment,event_name,event_id) DO NOTHING`,
      [env.FAREJADOR_ENV, row.attribution_id, row.order_number, JSON.stringify(payload)],
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
     RETURNING q.id,q.environment,q.payload,q.attempts`,
    [env.FAREJADOR_ENV, WORKER_ID],
  );
  return result.rows[0] ?? null;
}

async function sendCapi(row: CapiOutboxRow, fetcher: typeof fetch): Promise<{
  eventsReceived: number;
  fbtraceId: string | null;
}> {
  if (!env.META_CAPI_DATASET_ID || !env.META_CAPI_ACCESS_TOKEN) {
    throw new Error('marketing_capi_not_configured');
  }
  const url = new URL(
    `https://graph.facebook.com/${encodeURIComponent(env.META_GRAPH_API_VERSION)}/${encodeURIComponent(env.META_CAPI_DATASET_ID)}/events`,
  );
  const response = await fetcher(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.META_CAPI_ACCESS_TOKEN}`,
    },
    body: JSON.stringify(row.payload),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json().catch(() => ({})) as {
    events_received?: unknown;
    fbtrace_id?: unknown;
    error?: { code?: unknown; message?: unknown };
  };
  if (!response.ok || body.error) {
    const code = body.error?.code ? String(body.error.code) : String(response.status);
    throw new Error(`meta_capi_${code}`);
  }
  return {
    eventsReceived: Number(body.events_received ?? 0),
    fbtraceId: body.fbtrace_id ? String(body.fbtrace_id) : null,
  };
}

export async function pollCapiOutbox(options: {
  dbPool?: Pool;
  fetcher?: typeof fetch;
} = {}): Promise<boolean> {
  const dbPool = options.dbPool ?? defaultPool;
  const client = await dbPool.connect();
  let row: CapiOutboxRow | null = null;
  try {
    await client.query('BEGIN');
    row = await pickCapiEvent(client);
    await client.query('COMMIT');
    if (!row) return false;
    const ack = await sendCapi(row, options.fetcher ?? fetch);
    await client.query(
      `UPDATE marketing.capi_outbox
          SET status='sent',events_received=$2,fbtrace_id=$3,sent_at=now(),
              locked_at=NULL,locked_by=NULL,last_error_code=NULL,last_error_kind=NULL,
              last_error_summary=NULL,updated_at=now()
        WHERE environment=$1 AND id=$4`,
      [row.environment, ack.eventsReceived, ack.fbtraceId, row.id],
    );
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
