/** Transporte Meta CAPI compartilhado; credenciais nunca entram no payload ou log. */
import { env } from '../shared/config/env.js';

export interface CapiAck {
  eventsReceived: number;
  fbtraceId: string | null;
}

export interface CapiTransportOptions {
  fetcher?: typeof fetch;
  datasetId?: string;
  accessToken?: string;
  apiVersion?: string;
}

function sanitizeMetaErrorDetail(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/access_token\s*[=:]\s*[^\s&,]+/gi, 'access_token=[redacted]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[redacted]')
    .replace(/\+?\b\d{8,}\b/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

export async function sendCapiPayload(
  payload: Record<string, unknown>,
  options: CapiTransportOptions = {},
): Promise<CapiAck> {
  const datasetId = options.datasetId ?? env.META_CAPI_DATASET_ID;
  const accessToken = options.accessToken ?? env.META_CAPI_ACCESS_TOKEN;
  const apiVersion = options.apiVersion ?? env.META_GRAPH_API_VERSION;
  if (!datasetId || !accessToken) throw new Error('marketing_capi_not_configured');

  const url = new URL(
    `https://graph.facebook.com/${encodeURIComponent(apiVersion)}/${encodeURIComponent(datasetId)}/events`,
  );
  const response = await (options.fetcher ?? fetch)(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json().catch(() => ({})) as {
    events_received?: unknown;
    fbtrace_id?: unknown;
    error?: {
      code?: unknown;
      message?: unknown;
      error_user_title?: unknown;
      error_user_msg?: unknown;
    };
  };
  if (!response.ok || body.error) {
    const code = body.error?.code ? String(body.error.code) : String(response.status);
    const detail = [
      sanitizeMetaErrorDetail(body.error?.message),
      sanitizeMetaErrorDetail(body.error?.error_user_title),
      sanitizeMetaErrorDetail(body.error?.error_user_msg),
    ].filter((item, index, items) => item && items.indexOf(item) === index)
      .join(' - ')
      .slice(0, 300);
    throw new Error(detail ? `meta_capi_${code}:${detail}` : `meta_capi_${code}`);
  }
  return {
    eventsReceived: Number(body.events_received ?? 0),
    fbtraceId: body.fbtrace_id ? String(body.fbtrace_id) : null,
  };
}
