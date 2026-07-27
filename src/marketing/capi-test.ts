/** Test Events isolado: envia uma compra recente sem tocar na fila de produção. */
import type { Pool } from 'pg';
import { pool as defaultPool } from '../persistence/db.js';
import { env } from '../shared/config/env.js';
import { buildCapiPayload } from './capi.js';
import { loadLatestCapiTestSource } from './capi-source.js';
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

export async function sendLatestCapiTestPurchase(options: {
  dbPool?: Pool;
  fetcher?: typeof fetch;
  config?: CapiTestConfig;
} = {}): Promise<CapiTestResult> {
  const config = options.config ?? {};
  const whatsappBusinessAccountId = config.whatsappBusinessAccountId
    ?? env.META_WHATSAPP_BUSINESS_ACCOUNT_ID;
  const testEventCode = config.testEventCode ?? env.META_CAPI_TEST_EVENT_CODE;
  if (!whatsappBusinessAccountId) throw new Error('marketing_capi_waba_not_configured');
  if (!testEventCode) throw new Error('capi_test_event_code_not_configured');

  const source = await loadLatestCapiTestSource(options.dbPool ?? defaultPool);
  if (!source) return { processed: false, events_received: 0, fbtrace_id: null };
  const payload = buildCapiPayload(source, {
    whatsappBusinessAccountId,
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
