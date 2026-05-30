/**
 * Reconciliação do chat do Portal Parceiro (a "rede de segurança").
 *
 * O fan-out (partner-chat.fanout.ts) copia cada mensagem do Chatwoot pro chat
 * do parceiro DURANTE a normalização. Se ele tropeçar num momento de carga
 * (ex.: o banco lento logo após o Agent V2 responder), o SAVEPOINT desfaz só
 * aquela cópia e a mensagem fica de fora do portal — embora siga intacta em
 * raw.raw_events / core.messages.
 *
 * Este reconciliador roda periodicamente, acha os `message_created` já
 * processados que NÃO têm cópia em commerce.partner_messages, e reprocessa
 * cada um pelo MESMO fan-out. É idempotente (ON CONFLICT DO NOTHING + dedup do
 * eco), então recopiar algo que já está lá é no-op, e mensagens inelegíveis
 * (nota interna, atividade, vazia) são puladas pela mesma projeção do fan-out.
 *
 * Defensivo: cada mensagem roda em transação própria; um erro numa não derruba
 * as outras nem o loop. NUNCA toca no bot nem no caminho crítico de ingestão.
 */
import type { PoolClient } from 'pg';
import { pool } from '../persistence/db.js';
import { env } from '../shared/config/env.js';
import { logger } from '../shared/logger.js';
import { mapMessage } from './message.mapper.js';
import { fanOutMessageToPartnerChat } from './partner-chat.fanout.js';

const RECONCILE_INTERVAL_MS = 30_000;
const LOOKBACK_MINUTES = 15;
const MAX_PER_RUN = 200;

interface PendingRow {
  id: number;
  payload: Record<string, unknown>;
  chatwoot_timestamp: Date | null;
}

/**
 * Uma passada do reconciliador, usando o client recebido. Retorna quantos
 * candidatos achou e quantas mensagens recuperou (inseriu de fato).
 * Recebe o client pra ser testável e reutilizável (backfill manual).
 */
export async function reconcilePartnerChatOnce(
  client: PoolClient,
  opts: { lookbackMinutes?: number; max?: number } = {},
): Promise<{ candidates: number; recovered: number }> {
  const lookback = opts.lookbackMinutes ?? LOOKBACK_MINUTES;
  const max = opts.max ?? MAX_PER_RUN;

  // message_created já processados, do ambiente atual, recentes, cuja cópia
  // não existe em partner_messages (LEFT JOIN ... IS NULL).
  const result = await client.query<PendingRow>(
    `SELECT e.id, e.payload, e.chatwoot_timestamp
       FROM raw.raw_events e
       LEFT JOIN commerce.partner_messages pm
         ON pm.environment = e.environment
        AND pm.chatwoot_message_id = (e.payload->>'id')::bigint
      WHERE e.event_type = 'message_created'
        AND e.processing_status = 'processed'
        AND e.environment = $1
        AND e.received_at > now() - ($2 * interval '1 minute')
        AND (e.payload->>'id') ~ '^[0-9]+$'
        AND pm.id IS NULL
      ORDER BY e.received_at ASC
      LIMIT $3`,
    [env.FAREJADOR_ENV, lookback, max],
  );

  let recovered = 0;
  for (const row of result.rows) {
    try {
      const message = mapMessage(row.payload, env.FAREJADOR_ENV, row.chatwoot_timestamp ?? new Date());
      // Transação própria por mensagem: o fan-out usa SAVEPOINT e precisa de tx.
      await client.query('BEGIN');
      await fanOutMessageToPartnerChat(client, message, row.payload);
      await client.query('COMMIT');
      recovered += 1;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      logger.warn({ err, raw_event_id: row.id }, 'partner chat reconcile: falha ao reprocessar evento (ignorado)');
    }
  }

  return { candidates: result.rowCount ?? 0, recovered };
}

/** Conecta no pool do bot e roda uma passada. Nunca lança. */
export async function runPartnerChatReconcile(): Promise<void> {
  if (!env.PARTNER_CHAT_FANOUT_ENABLED) return;
  const client = await pool.connect();
  try {
    const { candidates, recovered } = await reconcilePartnerChatOnce(client);
    if (recovered > 0) {
      logger.info({ candidates, recovered }, 'partner chat reconcile: mensagens recuperadas pro portal');
    }
  } catch (err) {
    logger.error({ err }, 'partner chat reconcile failed (sem impacto no bot/ingestão)');
  } finally {
    client.release();
  }
}

/** Inicia o loop periódico. Retorna função pra parar. */
export function startPartnerChatReconciler(): () => void {
  let stopped = false;

  async function loop(): Promise<void> {
    if (stopped) return;
    await runPartnerChatReconcile();
    setTimeout(loop, RECONCILE_INTERVAL_MS);
  }

  // Primeiro tick só depois de um intervalo: deixa o fan-out normal agir antes.
  setTimeout(loop, RECONCILE_INTERVAL_MS);

  return function stop(): void {
    stopped = true;
  };
}
