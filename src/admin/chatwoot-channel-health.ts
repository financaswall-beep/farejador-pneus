import { env } from '../shared/config/env.js';

type Channel = 'instagram' | 'facebook';
interface Config { baseUrl: string; apiToken: string; accountId: number }
export interface ChannelHealth {
  status: 'ok' | 'unavailable' | 'not_configured';
  checked_at: string | null;
  channels: Array<{
    inbox_id: number; channel: Channel;
    authorization: 'reauthorization_required' | 'no_reauthorization_required' | 'unknown';
    reconnect_url: string;
  }>;
}

/** Só consulta autorização. Não testa envio, renova tokens nem altera caixas. */
export function createChannelHealthReader(config: Config | null, fetchFn: typeof fetch = fetch) {
  let snapshot: ChannelHealth = { status: 'unavailable', checked_at: null, channels: [] };
  let expires = 0;
  let pending: Promise<ChannelHealth> | null = null;
  return async function read(): Promise<ChannelHealth> {
    if (!config) return { status: 'not_configured', checked_at: null, channels: [] };
    if (pending) return pending;
    if (Date.now() < expires) return snapshot;
    pending = (async () => {
      try {
        const root = new URL(config.baseUrl.replace(/\/api\/v1\/?$/, '').replace(/\/$/, ''));
        if (!['https:', 'http:'].includes(root.protocol) || root.username || root.password
          || !Number.isSafeInteger(config.accountId) || config.accountId <= 0) throw Error('invalid_config');
        const response = await fetchFn(`${root.href.replace(/\/$/, '')}/api/v1/accounts/${config.accountId}/inboxes`, {
          headers: { api_access_token: config.apiToken }, signal: AbortSignal.timeout(4000), redirect: 'error',
        });
        if (!response.ok) throw Error('unavailable');
        const body = await response.json() as { payload?: unknown };
        if (!Array.isArray(body.payload)) throw Error('invalid_response');
        const channels: ChannelHealth['channels'] = [];
        for (const value of body.payload) {
          if (!value || typeof value !== 'object') throw Error('invalid_inbox');
          const inbox = value as Record<string, unknown>;
          const type = String(inbox.channel_type ?? '').toLowerCase();
          const channel = ['channel::instagram', 'instagram'].includes(type) ? 'instagram'
            : ['channel::facebookpage', 'facebook'].includes(type) ? 'facebook' : null;
          if (!channel) continue;
          if (!Number.isSafeInteger(inbox.id) || Number(inbox.id) <= 0) throw Error('invalid_inbox');
          // A conta é determinada pelo servidor; não aceita conta/URL fornecida pelo navegador.
          if (inbox.account_id != null && Number(inbox.account_id) !== config.accountId) continue;
          channels.push({ inbox_id: Number(inbox.id), channel,
            authorization: inbox.reauthorization_required === true ? 'reauthorization_required'
              : inbox.reauthorization_required === false ? 'no_reauthorization_required' : 'unknown',
            reconnect_url: new URL(`/app/accounts/${config.accountId}/inbox/${inbox.id}`, root).href,
          });
        }
        snapshot = { status: 'ok', checked_at: new Date().toISOString(), channels };
        expires = Date.now() + 30_000;
      } catch {
        // Falha de consulta não significa canal conectado nem apaga um alerta já confirmado.
        snapshot = { ...snapshot, status: 'unavailable' };
        expires = Date.now() + 15_000;
      }
      return snapshot;
    })();
    try { return await pending; } finally { pending = null; }
  };
}

// Uma consulta compartilhada por processo, independente do carregamento das conversas.
export const getChatwootChannelHealth = createChannelHealthReader(
  env.CHATWOOT_API_BASE_URL && env.CHATWOOT_API_TOKEN && env.CHATWOOT_ACCOUNT_ID
    ? { baseUrl: env.CHATWOOT_API_BASE_URL, apiToken: env.CHATWOOT_API_TOKEN, accountId: env.CHATWOOT_ACCOUNT_ID }
    : null,
);
