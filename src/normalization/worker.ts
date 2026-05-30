import { Client, type PoolClient } from 'pg';
import { pool } from '../persistence/db.js';
import { env } from '../shared/config/env.js';
import { logger } from '../shared/logger.js';
import { dispatch, SkipEventError } from './dispatcher.js';

const MAX_PER_POLL = 50; // máximo de eventos drenados por ciclo de poll; encerra mais cedo se a fila esvaziar
const POLL_INTERVAL_MS = 5_000;
const LISTEN_CHANNEL = 'raw_events_new';
const LISTEN_RECONNECT_MS = 3_000;

function usesSupabase(url: string): boolean {
  return url.includes('supabase.co') || url.includes('supabase.com');
}

interface RawEventRow {
  id: number;
  event_type: string;
  payload: unknown;
  environment: string;
  chatwoot_timestamp: Date | null;
}

export async function pollAndNormalize(): Promise<void> {
  let client: PoolClient | null = null;

  try {
    client = await pool.connect();
    for (let processedCount = 0; processedCount < MAX_PER_POLL; processedCount++) {
      let row: RawEventRow | undefined;

      try {
        await client.query('BEGIN');

        const result = await client.query<RawEventRow>(
          `SELECT id, event_type, payload, environment, chatwoot_timestamp
           FROM raw.raw_events
           WHERE processing_status = 'pending'
             AND environment = $1
           ORDER BY received_at
           LIMIT 1
           FOR UPDATE SKIP LOCKED`,
          [env.FAREJADOR_ENV],
        );

        row = result.rows[0];
        if (!row) {
          await client.query('COMMIT');
          return;
        }

        await client.query('SAVEPOINT normalize_event');
        await dispatch(client, row);
        await client.query(
          `UPDATE raw.raw_events
           SET processing_status = 'processed',
               processed_at = now()
           WHERE id = $1`,
          [row.id],
        );
        await client.query('RELEASE SAVEPOINT normalize_event');
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT normalize_event').catch(() => {});

        if (!row) {
          throw err;
        }

        if (err instanceof SkipEventError) {
          await client.query(
            `UPDATE raw.raw_events
             SET processing_status = 'skipped',
                 processed_at = now()
             WHERE id = $1`,
            [row.id],
          );
          await client.query('COMMIT');
          continue;
        }

        const errorMessage = err instanceof Error ? err.message : String(err);
        logger.error(
          { err, raw_event_id: row.id, event_type: row.event_type },
          'normalization failed',
        );

        await client.query(
          `UPDATE raw.raw_events
           SET processing_status = 'failed',
               processing_error = $1,
               processed_at = now()
           WHERE id = $2`,
          [errorMessage, row.id],
        );
        await client.query('COMMIT');
      }
    }
  } catch (err) {
    if (client) {
      await client.query('ROLLBACK').catch(() => {});
    }
    logger.error({ err }, 'worker poll failed');
  } finally {
    client?.release();
  }
}

export function startWorker(): () => void {
  let stopped = false;
  let draining = false;
  let wakePending = false;
  let pollTimer: NodeJS.Timeout | null = null;
  let listenClient: Client | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;

  // Serializa as drenagens: se chega um wake enquanto ja esta drenando, marca
  // pra rodar de novo no fim (em vez de abrir drenagens concorrentes).
  async function drain(): Promise<void> {
    if (draining) {
      wakePending = true;
      return;
    }
    draining = true;
    try {
      do {
        wakePending = false;
        await pollAndNormalize();
      } while (wakePending && !stopped);
    } finally {
      draining = false;
    }
  }

  // Poll de seguranca (fallback): garante o processamento mesmo se um NOTIFY se
  // perder (worker offline na hora do aviso, queda da conexao LISTEN, etc.).
  async function loop(): Promise<void> {
    if (stopped) return;
    await drain();
    pollTimer = setTimeout(() => void loop(), POLL_INTERVAL_MS);
  }

  // Tempo real: webhook faz pg_notify('raw_events_new') ao gravar evento novo;
  // aqui escutamos e drenamos na hora, sem esperar o ciclo de 5s.
  function scheduleReconnect(): void {
    if (stopped || reconnectTimer) return;
    if (listenClient) {
      listenClient.removeAllListeners();
      listenClient.end().catch(() => undefined);
      listenClient = null;
    }
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connectListen();
    }, LISTEN_RECONNECT_MS);
  }

  async function connectListen(): Promise<void> {
    if (stopped) return;
    const client = new Client({
      connectionString: env.DATABASE_URL,
      ssl: env.DATABASE_SSL || usesSupabase(env.DATABASE_URL) ? { rejectUnauthorized: false } : undefined,
    });
    client.on('error', (err) => {
      logger.error({ err }, 'normalization worker LISTEN client error');
      scheduleReconnect();
    });
    client.on('end', () => {
      if (!stopped) scheduleReconnect();
    });
    client.on('notification', (msg) => {
      if (msg.channel === LISTEN_CHANNEL) void drain();
    });
    try {
      await client.connect();
      await client.query(`LISTEN ${LISTEN_CHANNEL}`);
      listenClient = client;
      logger.info('normalization worker: LISTEN raw_events_new ativo (tempo real)');
    } catch (err) {
      logger.error({ err }, 'normalization worker: falha no LISTEN; seguindo só com o poll de 5s');
      scheduleReconnect();
    }
  }

  void loop();
  void connectListen();

  return function stop(): void {
    stopped = true;
    if (pollTimer) clearTimeout(pollTimer);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (listenClient) {
      listenClient.removeAllListeners();
      listenClient.end().catch(() => undefined);
      listenClient = null;
    }
  };
}
