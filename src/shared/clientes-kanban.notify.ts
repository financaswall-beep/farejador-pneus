import { Client, type PoolClient } from 'pg';
import { env } from './config/env.js';
import { logger } from './logger.js';

const CHANNEL = 'clientes_kanban';
const RECONNECT_DELAY_MS = 3000;

export interface ClientesKanbanEvent {
  environment: 'prod' | 'test';
  conversation_id: string;
  reason: 'message' | 'conversation' | 'order' | 'agent_turn';
}

type Subscriber = (event: ClientesKanbanEvent) => void;

const subscribers = new Map<string, Set<Subscriber>>();
let listenClient: Client | null = null;
let started = false;
let reconnectTimer: NodeJS.Timeout | null = null;

function usesSupabase(url: string): boolean {
  return url.includes('supabase.co') || url.includes('supabase.com');
}

function dispatch(event: ClientesKanbanEvent): void {
  const listeners = subscribers.get(event.environment);
  if (!listeners) return;
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (err) {
      logger.warn({ err }, 'clientes kanban notify: subscriber falhou');
    }
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  if (listenClient) {
    listenClient.removeAllListeners();
    listenClient.end().catch(() => undefined);
    listenClient = null;
  }
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect().catch((err) => {
      logger.error({ err }, 'clientes kanban notify: falha ao reconectar');
      scheduleReconnect();
    });
  }, RECONNECT_DELAY_MS);
}

async function connect(): Promise<void> {
  const client = new Client({
    connectionString: env.DATABASE_URL,
    ssl: env.DATABASE_SSL || usesSupabase(env.DATABASE_URL) ? { rejectUnauthorized: false } : undefined,
  });
  client.on('error', (err) => {
    logger.error({ err }, 'clientes kanban notify: erro na conexao LISTEN');
    scheduleReconnect();
  });
  client.on('end', () => {
    logger.warn('clientes kanban notify: conexao encerrada; reconectando');
    scheduleReconnect();
  });
  client.on('notification', (message) => {
    if (message.channel !== CHANNEL || !message.payload) return;
    try {
      dispatch(JSON.parse(message.payload) as ClientesKanbanEvent);
    } catch (err) {
      logger.warn({ err }, 'clientes kanban notify: payload invalido');
    }
  });
  await client.connect();
  await client.query(`LISTEN ${CHANNEL}`);
  listenClient = client;
  logger.info('clientes kanban notify: LISTEN ativo');
}

export function startClientesKanbanNotifyHub(): void {
  if (started) return;
  started = true;
  connect().catch((err) => {
    logger.error({ err }, 'clientes kanban notify: falha no start');
    scheduleReconnect();
  });
}

export function subscribeClientesKanban(environment: 'prod' | 'test', subscriber: Subscriber): () => void {
  let listeners = subscribers.get(environment);
  if (!listeners) {
    listeners = new Set();
    subscribers.set(environment, listeners);
  }
  listeners.add(subscriber);
  return () => {
    const current = subscribers.get(environment);
    current?.delete(subscriber);
    if (current?.size === 0) subscribers.delete(environment);
  };
}

export async function notifyClientesKanban(
  client: PoolClient,
  environment: string,
  conversationId: string,
  reason: ClientesKanbanEvent['reason'],
): Promise<void> {
  const payload: ClientesKanbanEvent = {
    environment: environment === 'prod' ? 'prod' : 'test',
    conversation_id: conversationId,
    reason,
  };
  try {
    await client.query('SELECT pg_notify($1, $2)', [CHANNEL, JSON.stringify(payload)]);
  } catch (err) {
    // O Kanban e acessorio: uma queda no NOTIFY nunca pode desfazer/repetir
    // pedido, mensagem ou normalizacao ja concluida.
    logger.warn({ err, environment: payload.environment, reason }, 'clientes kanban notify: aviso ignorado');
  }
}
