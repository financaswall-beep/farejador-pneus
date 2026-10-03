import type { PoolClient } from 'pg';
import { buildOrderIdempotencyKey, type OrderFingerprintItem } from './order-idempotency.js';

type Environment = 'prod' | 'test';
export interface BotOrderExecution { triggerMessageId: string }

/** A identidade vem do job, nunca de argumentos escolhidos pelo modelo. */
export async function botOrderRequestId(client: PoolClient, environment: Environment,
  conversationId: string, execution?: BotOrderExecution): Promise<string | null> {
  if (execution) return execution.triggerMessageId;
  const latest = await client.query<{ id: string }>(`SELECT id FROM core.messages
    WHERE environment=$1 AND conversation_id=$2 AND sender_type='contact'
      AND message_type=0 AND NOT is_private AND deleted_at IS NULL
    ORDER BY sent_at DESC,chatwoot_message_id DESC LIMIT 1`, [environment, conversationId]);
  return latest.rows[0]?.id ?? null;
}

export async function previousBotOrderAttempt(client: PoolClient, environment: Environment,
  conversationId: string, requestId: string | null): Promise<string | null> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
    [`bot-order:${environment}:${conversationId}`]);
  if (!requestId) return null;
  const prior = await client.query<{ order_id: string }>(`SELECT order_id FROM ops.bot_order_attempts
    WHERE environment=$1 AND conversation_id=$2 AND request_message_id=$3`,
  [environment, conversationId, requestId]);
  return prior.rows[0] ? botOrderReplay(client, environment, prior.rows[0].order_id) : null;
}

export async function botOrderReplay(client: PoolClient, environment: Environment,
  orderId: string): Promise<string> {
  const link = await client.query<{ partner_order_id: string | null }>(
    `SELECT partner_order_id FROM commerce.orders WHERE environment=$1 AND id=$2`, [environment, orderId]);
  if (link.rows[0]?.partner_order_id) await client.query(`SELECT id FROM commerce.partner_orders
    WHERE environment=$1 AND id=$2 FOR UPDATE`, [environment, link.rows[0].partner_order_id]);
  await client.query(`SELECT id FROM commerce.orders WHERE environment=$1 AND id=$2 FOR UPDATE`,
    [environment, orderId]);
  const result = await client.query<{ order_number: string; total_amount: string; live: boolean }>(
    `SELECT o.order_number,o.total_amount,
      CASE WHEN o.partner_order_id IS NULL THEN o.status='open'
        AND o.retrieved_at IS NULL AND o.delivered_at IS NULL
      ELSE po.status<>'cancelled' AND po.deleted_at IS NULL
        AND (po.awaiting_pickup OR (po.fulfillment_mode='delivery' AND po.delivery_status IN ('pending','dispatched')))
      END AS live
    FROM commerce.orders o LEFT JOIN commerce.partner_orders po
      ON po.environment=o.environment AND po.id=o.partner_order_id
    WHERE o.environment=$1 AND o.id=$2`, [environment, orderId]);
  const row = result.rows[0];
  if (!row?.live) return JSON.stringify({ erro: 'pedido_desta_solicitacao_encerrado',
    order_number: row?.order_number, mensagem: 'Esta solicitação já foi atendida e o pedido foi encerrado. Não confirme uma nova reserva sem uma nova solicitação do cliente.' });
  return JSON.stringify({ ok: true, order_number: row.order_number, total: row.total_amount,
    repetido: true, mensagem: `Pedido ${row.order_number} já registrado e aguardando atendimento.` });
}

export async function resolveBotOrderKey(client: PoolClient, environment: Environment,
  conversationId: string, unitId: string | null, items: OrderFingerprintItem[], modality: string,
  requestId: string | null): Promise<{ key: string; existingId: string | null }> {
  const base = buildOrderIdempotencyKey(conversationId, unitId, items, modality);
  const prior = await client.query<{ id: string; idempotency_key: string }>(
    `SELECT o.id,o.idempotency_key FROM commerce.orders o
     LEFT JOIN commerce.partner_orders po ON po.environment=o.environment AND po.id=o.partner_order_id
     WHERE o.environment=$1 AND (o.idempotency_key=$2 OR o.idempotency_key LIKE $2||':request:%')
       AND o.status='open' AND o.retrieved_at IS NULL AND o.delivered_at IS NULL
       AND (o.partner_order_id IS NULL OR (po.status<>'cancelled' AND po.deleted_at IS NULL
         AND (po.awaiting_pickup OR (po.fulfillment_mode='delivery' AND po.delivery_status IN ('pending','dispatched')))))
     ORDER BY o.created_at DESC LIMIT 1`, [environment, base]);
  const row = prior.rows[0];
  if (!row && !requestId) {
    const ended = await client.query(`SELECT 1 FROM commerce.orders
      WHERE environment=$1 AND idempotency_key=$2`, [environment, base]);
    if (ended.rows[0]) throw new Error('nova_solicitacao_cliente_obrigatoria');
  }
  return { key: row?.idempotency_key ?? (requestId ? `${base}:request:${requestId}` : base),
    existingId: row?.id ?? null };
}

export async function recordBotOrderAttempt(client: PoolClient, environment: Environment,
  conversationId: string, requestId: string | null, orderId: string): Promise<void> {
  if (!requestId) return;
  await client.query(`INSERT INTO ops.bot_order_attempts
    (environment,conversation_id,request_message_id,order_id) VALUES ($1,$2,$3,$4)
    ON CONFLICT (environment,conversation_id,request_message_id) DO NOTHING`,
  [environment, conversationId, requestId, orderId]);
}
