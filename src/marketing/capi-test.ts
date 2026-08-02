/** Test Events isolado: envia uma compra recente sem tocar na fila de produção. */
import type { Pool } from 'pg';
import { pool as defaultPool } from '../persistence/db.js';
import { env } from '../shared/config/env.js';
import { buildCapiPayload } from './capi.js';
import { loadLatestCapiTestSource, type CapiSourceRow } from './capi-source.js';
import { sendCapiPayload } from './capi-transport.js';

interface CapiTestConfig {
  whatsappBusinessAccountId?: string;
  pageId?: string;
  testEventCode?: string;
  extendedMatching?: boolean;
  datasetId?: string;
  accessToken?: string;
  apiVersion?: string;
}

export interface CapiTestResult {
  processed: boolean;
  events_received: number;
  fbtrace_id: string | null;
}

async function sendTestSource(
  source: CapiSourceRow,
  options: { fetcher?: typeof fetch; config?: CapiTestConfig },
): Promise<CapiTestResult> {
  const config = options.config ?? {};
  const testEventCode = config.testEventCode ?? env.META_CAPI_TEST_EVENT_CODE;
  if (!testEventCode) throw new Error('capi_test_event_code_not_configured');
  const payload = buildCapiPayload(source, {
    whatsappBusinessAccountId: config.whatsappBusinessAccountId
      ?? env.META_WHATSAPP_BUSINESS_ACCOUNT_ID,
    pageId: config.pageId ?? env.META_CAPI_PAGE_ID,
    testEventCode,
    extendedMatching: config.extendedMatching ?? env.CAPI_EXTENDED_MATCHING,
  });
  const ack = await sendCapiPayload(payload, {
    fetcher: options.fetcher,
    datasetId: config.datasetId,
    accessToken: config.accessToken,
    apiVersion: config.apiVersion,
  });
  return {
    processed: true,
    events_received: ack.eventsReceived,
    fbtrace_id: ack.fbtraceId,
  };
}

export async function sendLatestCapiTestPurchase(options: {
  dbPool?: Pool;
  fetcher?: typeof fetch;
  config?: CapiTestConfig;
} = {}): Promise<CapiTestResult> {
  const source = await loadLatestCapiTestSource(options.dbPool ?? defaultPool);
  if (!source) return { processed: false, events_received: 0, fbtrace_id: null };
  return sendTestSource(source, options);
}

/** Simula Purchase somente no Test Events a partir de um referral real; não cria pedido. */
export async function sendLatestWhatsappReferralTestPurchase(options: {
  dbPool?: Pool;
  fetcher?: typeof fetch;
  config?: CapiTestConfig;
  now?: Date;
} = {}): Promise<CapiTestResult> {
  const dbPool = options.dbPool ?? defaultPool;
  const result = await dbPool.query<{
    referral_id: string;
    ctwa_clid: string;
    phone_e164: string | null;
  }>(
    `SELECT r.id::text AS referral_id,r.ctwa_clid,c.phone_e164
       FROM marketing.ad_referrals r
       JOIN core.conversations conv
         ON conv.environment=r.environment AND conv.id=r.conversation_id
       LEFT JOIN core.contacts c
         ON c.environment=conv.environment AND c.id=conv.contact_id
      WHERE r.environment=$1 AND r.channel='whatsapp' AND r.ctwa_clid IS NOT NULL
      ORDER BY r.captured_at DESC,r.id DESC
      LIMIT 1`,
    [env.FAREJADOR_ENV],
  );
  const referral = result.rows[0];
  if (!referral) return { processed: false, events_received: 0, fbtrace_id: null };
  const now = options.now ?? new Date();
  const source: CapiSourceRow = {
    attribution_id: `test:${referral.referral_id}`,
    order_number: `TEST-WHATSAPP-${now.getTime()}`,
    total_amount: '1.00',
    realized_at: now.toISOString(),
    phone_e164: referral.phone_e164,
    channel: 'whatsapp',
    ctwa_clid: referral.ctwa_clid,
    user_scoped_id: null,
    business_account_id: null,
    ad_account_id: null,
    campaign_id: null,
    campaign_scope_id: null,
    city_name: null,
    state_code: null,
    postal_code_prefix: null,
  };
  return sendTestSource(source, options);
}
