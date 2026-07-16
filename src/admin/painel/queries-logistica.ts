// Acoes operacionais da Logistica da Matriz.
import type { Pool, PoolClient } from 'pg';
import { randomBytes } from 'node:crypto';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { normalizeBrazilianPhone } from '../../shared/phone.js';
import { applyWholesaleStockDecrement, applyWholesaleStockReturn } from './wholesale-stock.js';
import { resolveMeasureInCatalog } from './wholesale-catalog.js';
import { applyMatrizGalpaoDecrement, applyMatrizGalpaoReturn, applyMatrizRetailCostSnapshot } from '../../atendente-v2/wholesale-stock-read.js';
import { hashPassword } from '../../parceiro/password.js';
import { MAIN_DELIVERY_GUARD } from './queries-logistica-read.js';
export * from './queries-logistica-read.js';

/** Saiu pra entrega / entregue. "Não entregue" NÃO passa aqui — é failMatrizDelivery. */
export async function setMatrizDeliveryStatus(
  input: {
    order_id: string;
    status: 'dispatched' | 'delivered';
    courier?: string | null;
    payment_method?: string | null;
    environment?: 'prod' | 'test';
  },
  dbPool: Pool = defaultPool,
): Promise<{ order_id: string; delivery_status: string }> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  // Entregue também fecha o PEDIDO (status delivered — verdade comercial do 0013);
  // a régua de faturamento (0117) não muda: já contava o pedido não-cancelado.
  const r = await dbPool.query<{ order_id: string; delivery_status: string }>(
    `UPDATE commerce.orders o
        SET delivery_status = $3,
            delivery_courier = COALESCE(NULLIF($4, ''), o.delivery_courier),
            dispatched_at = CASE WHEN $3 = 'dispatched' THEN COALESCE(o.dispatched_at, now()) ELSE o.dispatched_at END,
            delivered_at  = CASE WHEN $3 = 'delivered'  THEN now() ELSE o.delivered_at END,
            status        = CASE WHEN $3 = 'delivered'  THEN 'delivered' ELSE o.status END,
            payment_method = CASE WHEN $3 = 'delivered' THEN COALESCE(NULLIF($5, ''), o.payment_method) ELSE o.payment_method END,
            closed_at     = CASE WHEN $3 = 'delivered'  THEN COALESCE(o.closed_at, now()) ELSE o.closed_at END,
            closed_by     = CASE WHEN $3 = 'delivered'  THEN COALESCE(o.closed_by, 'logistica-matriz') ELSE o.closed_by END,
            updated_at    = now()
      WHERE o.id = $2 AND o.environment = $1
        AND o.status <> 'cancelled' AND o.delivery_status <> 'delivered'
        AND ${MAIN_DELIVERY_GUARD}
      RETURNING o.id AS order_id, o.delivery_status`,
    [environment, input.order_id, input.status, input.courier ?? null, input.payment_method ?? null],
  );
  if (!r.rows[0]) throw new Error('delivery_not_found');
  return r.rows[0];
}

/** NÃO ENTREGUE: marca failed E CANCELA o pedido no MESMO caminho atômico do
 *  cancelamento (fdd9148) — galpão volta guiado pela trilha; falhou a devolução,
 *  volta tudo. O motivo fica na trilha do cancel_manual_order. */
export async function failMatrizDelivery(
  input: { order_id: string; reason?: string | null; actor_label?: string | null; environment?: 'prod' | 'test' },
  dbPool: Pool = defaultPool,
): Promise<{ order_id: string; delivery_status: 'failed' }> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const marked = await client.query(
      `UPDATE commerce.orders o
          SET delivery_status = 'failed', updated_at = now()
        WHERE o.id = $2 AND o.environment = $1
          AND o.status <> 'cancelled' AND o.delivery_status <> 'delivered'
          AND ${MAIN_DELIVERY_GUARD}
        RETURNING o.id`,
      [environment, input.order_id],
    );
    if (!marked.rows[0]) throw new Error('delivery_not_found');
    await client.query('SELECT commerce.cancel_manual_order($1, $2, $3)', [
      input.order_id,
      input.actor_label ?? 'logistica-matriz',
      input.reason ?? 'entrega falhou',
    ]);
    await applyMatrizGalpaoReturn(client, environment, input.order_id);
    await client.query('COMMIT');
    return { order_id: input.order_id, delivery_status: 'failed' };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** ABRE a rota do dia: cria o diário e pendura as entregas escolhidas (elas saem
 *  pra entrega juntas — dispatched + entregador da rota). */
