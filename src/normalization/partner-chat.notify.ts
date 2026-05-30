/**
 * Hub de tempo real do chat do parceiro (Fatia 3).
 *
 * Mantém UMA conexão dedicada fazendo `LISTEN partner_chat` por processo. O
 * fan-out (partner-chat.fanout.ts) emite `pg_notify('partner_chat', ...)` ao
 * gravar uma mensagem nova; este hub recebe e reentrega pros endpoints SSE
 * conectados, filtrando por unidade.
 *
 * Por que um Client dedicado (e não o Pool): LISTEN precisa ficar preso a UMA
 * conexão viva. Um client tirado do pool seria devolvido e perderia o LISTEN.
 *
 * Defensivo: reconecta com backoff e NUNCA derruba o processo. Se o hub cair,
 * os clientes SSE caem no fallback de polling do front — nada quebra.
 *
 * Plano: docs/PLANO_CHAT_UNIFICADO_PARCEIRO_2026-05-29.md (Fatia 3).
 */
import { Client } from 'pg';
import { env } from '../shared/config/env.js';
import { logger } from '../shared/logger.js';

const CHANNEL = 'partner_chat';
const RECONNECT_DELAY_MS = 3000;

export interface PartnerChatEvent {
  /** core.units.id da unidade dona da conversa (mesma que vem nos claims do token). */
  unit_id: string;
  conversation_id: string;
  chatwoot_conversation_id?: number;
  kind: string;
}

type Subscriber = (event: PartnerChatEvent) => void;

// unit_id (core.units.id) -> callbacks (um por conexão SSE aberta).
const subscribers = new Map<string, Set<Subscriber>>();

let client: Client | null = null;
let started = false;
let reconnectTimer: NodeJS.Timeout | null = null;

function usesSupabase(url: string): boolean {
  return url.includes('supabase.co') || url.includes('supabase.com');
}

function dispatch(event: PartnerChatEvent): void {
  const set = subscribers.get(event.unit_id);
  if (!set) return;
  for (const cb of set) {
    try {
      cb(event);
    } catch (err) {
      logger.warn({ err }, 'partner chat notify: subscriber falhou');
    }
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  if (client) {
    client.removeAllListeners();
    client.end().catch(() => undefined);
    client = null;
  }
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect().catch((err) => {
      logger.error({ err }, 'partner chat notify hub: falha ao reconectar');
      scheduleReconnect();
    });
  }, RECONNECT_DELAY_MS);
}

async function connect(): Promise<void> {
  const c = new Client({
    connectionString: env.DATABASE_URL,
    ssl: env.DATABASE_SSL || usesSupabase(env.DATABASE_URL) ? { rejectUnauthorized: false } : undefined,
  });
  c.on('error', (err) => {
    logger.error({ err }, 'partner chat notify client error');
    scheduleReconnect();
  });
  c.on('end', () => {
    logger.warn('partner chat notify client encerrou — reconectando');
    scheduleReconnect();
  });
  c.on('notification', (msg) => {
    if (msg.channel !== CHANNEL || !msg.payload) return;
    let event: PartnerChatEvent;
    try {
      event = JSON.parse(msg.payload) as PartnerChatEvent;
    } catch (err) {
      logger.warn({ err, payload: msg.payload }, 'partner chat notify: payload inválido');
      return;
    }
    dispatch(event);
  });
  await c.connect();
  await c.query(`LISTEN ${CHANNEL}`);
  client = c;
  logger.info('partner chat notify hub: LISTEN ativo');
}

/** Liga o hub (idempotente). Chamar uma vez no boot do processo. */
export function startPartnerChatNotifyHub(): void {
  if (started) return;
  started = true;
  connect().catch((err) => {
    logger.error({ err }, 'partner chat notify hub: falha no start');
    scheduleReconnect();
  });
}

/** Registra um listener pra uma unidade. Retorna a função de cancelamento. */
export function subscribePartnerChat(unitId: string, cb: Subscriber): () => void {
  let set = subscribers.get(unitId);
  if (!set) {
    set = new Set();
    subscribers.set(unitId, set);
  }
  set.add(cb);
  return () => {
    const s = subscribers.get(unitId);
    if (!s) return;
    s.delete(cb);
    if (s.size === 0) subscribers.delete(unitId);
  };
}
