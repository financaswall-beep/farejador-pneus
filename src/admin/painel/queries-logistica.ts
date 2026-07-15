// Obra 300 (2026-07-05): fatia do banco da MATRIZ — logística (0121) leitura: entregas, rotas, status, falha.
// VERBATIM das linhas 2442-2666 do queries.ts pré-obra (commit 2628748).
// Porta de entrada continua sendo ./queries.js (barrel) — importadores não mudam.
import type { Pool, PoolClient } from 'pg';
import { randomBytes } from 'node:crypto';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { normalizeBrazilianPhone } from '../../shared/phone.js';
import { applyWholesaleStockDecrement, applyWholesaleStockReturn } from './wholesale-stock.js';
import { resolveMeasureInCatalog } from './wholesale-catalog.js';
import { applyMatrizGalpaoDecrement, applyMatrizGalpaoReturn, applyMatrizRetailCostSnapshot } from '../../atendente-v2/wholesale-stock-read.js';
import { hashPassword } from '../../parceiro/password.js';

export const MAIN_DELIVERY_GUARD = `
  o.fulfillment_mode = 'delivery'
  AND EXISTS (SELECT 1 FROM core.units u
               WHERE u.id = o.unit_id AND u.environment = o.environment AND u.slug = 'main')`;

export interface MatrizDeliveryRow {
  order_id: string;
  order_number: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  delivery_address: string | null;
  total_amount: string;
  payment_method: string | null;
  status: string;
  delivery_status: 'pending' | 'dispatched' | 'delivered' | 'failed';
  delivery_courier: string | null;
  /** 0125: motivo do não-entregue REPORTADO pelo portal (failed sem cancelar =
   *  aguardando o dono confirmar ou recolocar). NULL fora desse limbo. */
  delivery_failure_reason: string | null;
  trip_id: string | null;
  created_at: string;
  dispatched_at: string | null;
  delivered_at: string | null;
  /** Data EFETIVA de entrega prevista (YYYY-MM-DD): a remarcada, ou o padrão D+1
   *  (created_at+1, fuso SP) quando nunca foi remarcada. */
  scheduled_date: string;
  /** A data remarcada crua (NULL = usando o padrão D+1). Só pra UI saber se o dono
   *  já mexeu na data. */
  scheduled_raw: string | null;
  items: Array<{ quantity: number; label: string }>;
}

export interface MatrizTripRow {
  id: string;
  /** Número amigável (0129): ROTA-0001, ... — o que o dono fala/audita. */
  trip_number: string;
  courier_name: string;
  status: 'open' | 'closed';
  km_start: string | null;
  km_end: string | null;
  fuel_spent: string | null;
  fuel_expense_id: string | null;
  notes: string | null;
  started_at: string;
  ended_at: string | null;
  deliveries_count: number;
  /** "A rota se pagou?" — SÓ das entregas DELIVERED da rota (failed/cancelada fora).
   *  Régua do lucro = a MESMA do varejo 0117 (custo congelado; item sem custo fica
   *  fora do lucro e é CONTADO pra UI avisar — nunca chuta). Frete = total_amount −
   *  itens (o bot embute o frete no total; walk-in sem frete → 0, nunca negativo). */
  resumo: {
    entregues: number;
    nao_entregues: number;
    faturamento_total: number;
    frete_total: number;
    faturamento_pneus: number;
    custo_pneus: number;
    lucro_pneus: number;
    itens_sem_custo: number;
  };
  /** Σ despesas vivas amarradas à rota (fechamento ∪ comprovantes lidos — o IN
   *  dedup cobre o linked_existing; deleted_at IS NULL = dono apagou, rota reflete). */
  despesas_total: string;
  /** Pedidos entregues que formam o resultado. Valores de custo continuam
   *  parciais quando algum item não tinha snapshot — a UI sinaliza, nunca estima. */
  pedidos_resultado: Array<{
    order_id: string;
    order_number: string | null;
    customer_name: string | null;
    total: number;
    faturamento_pneus: number;
    custo_pneus: number;
    frete: number;
    margem_antes_rota: number;
    itens_sem_custo: number;
  }>;
  /** Despesas únicas realmente vinculadas à rota. O mesmo expense pode ser
   *  lastreado por mais de um comprovante; DISTINCT evita dupla contagem. */
  despesas: Array<{
    id: string;
    category: string;
    description: string | null;
    amount: number;
    occurred_at: string;
    source: 'comprovante' | 'fechamento';
    receipt_id: string | null;
    receipt_summary: string | null;
  }>;
  receipts: Array<{
    id: string;
    ai_status: 'pending' | 'parsed' | 'unreadable' | 'skipped';
    ai_summary: string | null;
    ai_expense_id: string | null;
    expense_category: string | null;
    expense_amount: number | null;
    created_at: string;
  }>;
}

export interface MatrizLogistica {
  abertas: MatrizDeliveryRow[];
  /** O LIMBO do portal (0125): o entregador REPORTOU não-entregue (failed) e o pedido
   *  ainda NÃO foi cancelado — o dono decide: recolocar na fila ou confirmar (cancela
   *  e o galpão volta). Bloco próprio da tela (auditoria 07-08 — antes se perdia nas
   *  finalizadas sem motivo nem botão). */
  reportadas: MatrizDeliveryRow[];
  finalizadas: MatrizDeliveryRow[];
  rotas_abertas: MatrizTripRow[];
  rotas_recentes: MatrizTripRow[];
}

/** A tela Logística num GET: entregas da main (abertas + últimas finalizadas) + rotas. */
export async function getMatrizLogistica(
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<MatrizLogistica> {
  const deliverySelect = `
    SELECT o.id AS order_id, o.order_number, c.name AS customer_name, c.phone_e164 AS customer_phone,
           o.delivery_address, o.total_amount::text, o.payment_method, o.status, o.delivery_status,
           o.delivery_courier, o.delivery_failure_reason, o.trip_id, o.created_at, o.dispatched_at, o.delivered_at,
           o.scheduled_delivery_date::text AS scheduled_raw,
           COALESCE(o.scheduled_delivery_date, ((o.created_at AT TIME ZONE 'America/Sao_Paulo')::date + 1))::text AS scheduled_date,
           COALESCE((SELECT jsonb_agg(jsonb_build_object(
                       'quantity', oi.quantity,
                       'label', COALESCE(pr.product_name, 'item')) ORDER BY oi.created_at)
                       FROM commerce.order_items oi
                       LEFT JOIN commerce.products pr ON pr.id = oi.product_id
                      WHERE oi.order_id = o.id AND oi.environment = o.environment), '[]'::jsonb) AS items
      FROM commerce.orders o
      LEFT JOIN core.contacts c ON c.id = o.contact_id
     WHERE o.environment = $1 AND ${MAIN_DELIVERY_GUARD}`;

  const tripSelect = `
    SELECT t.id, t.trip_number, t.courier_name, t.status, t.km_start::text, t.km_end::text,
           t.fuel_spent::text, t.fuel_expense_id, t.notes, t.started_at, t.ended_at,
           (SELECT COUNT(*)::int FROM commerce.orders o
             WHERE o.trip_id = t.id AND o.environment = t.environment) AS deliveries_count,
           (SELECT jsonb_build_object(
                     'entregues', COUNT(*),
                     'nao_entregues', (SELECT COUNT(*)::int FROM commerce.orders o3
                                        WHERE o3.trip_id = t.id AND o3.environment = t.environment
                                          AND (o3.delivery_status = 'failed' OR o3.status = 'cancelled')),
                     'faturamento_total', COALESCE(ROUND(SUM(x.total_amount), 2), 0),
                     'frete_total', COALESCE(ROUND(SUM(GREATEST(x.total_amount - x.itens_valor, 0)), 2), 0),
                     'faturamento_pneus', COALESCE(ROUND(SUM(x.itens_valor), 2), 0),
                     'custo_pneus', COALESCE(ROUND(SUM(x.custo_valor), 2), 0),
                     'lucro_pneus', COALESCE(ROUND(SUM(x.lucro_valor), 2), 0),
                     'itens_sem_custo', COALESCE(SUM(x.itens_sem_custo), 0))
              FROM (SELECT o2.id, o2.total_amount,
                           COALESCE(SUM(oi.quantity * oi.unit_price - oi.discount_amount), 0) AS itens_valor,
                           COALESCE(SUM(CASE WHEN oi.matriz_unit_cost IS NOT NULL
                                             THEN oi.matriz_unit_cost * oi.quantity END), 0) AS custo_valor,
                           COALESCE(SUM(CASE WHEN oi.matriz_unit_cost IS NOT NULL
                                             THEN (oi.quantity * oi.unit_price - oi.discount_amount)
                                                  - oi.matriz_unit_cost * oi.quantity END), 0) AS lucro_valor,
                           COUNT(*) FILTER (WHERE oi.matriz_unit_cost IS NULL)::int AS itens_sem_custo
                      FROM commerce.orders o2
                      JOIN commerce.order_items oi
                        ON oi.order_id = o2.id AND oi.environment = o2.environment
                     WHERE o2.trip_id = t.id AND o2.environment = t.environment
                       AND o2.delivery_status = 'delivered' AND o2.status <> 'cancelled'
                     GROUP BY o2.id, o2.total_amount) x) AS resumo,
           COALESCE((SELECT jsonb_agg(jsonb_build_object(
                       'order_id', x.order_id,
                       'order_number', x.order_number,
                       'customer_name', x.customer_name,
                       'total', x.total_amount,
                       'faturamento_pneus', x.itens_valor,
                       'custo_pneus', x.custo_valor,
                       'frete', GREATEST(x.total_amount - x.itens_valor, 0),
                       'margem_antes_rota', GREATEST(x.total_amount - x.itens_valor, 0) + x.lucro_valor,
                       'itens_sem_custo', x.itens_sem_custo)
                       ORDER BY x.delivered_at DESC, x.order_number DESC)
              FROM (SELECT o4.id AS order_id, o4.order_number, c4.name AS customer_name,
                           o4.total_amount, o4.delivered_at,
                           COALESCE(SUM(oi4.quantity * oi4.unit_price - oi4.discount_amount), 0) AS itens_valor,
                           COALESCE(SUM(CASE WHEN oi4.matriz_unit_cost IS NOT NULL
                                             THEN oi4.matriz_unit_cost * oi4.quantity END), 0) AS custo_valor,
                           COALESCE(SUM(CASE WHEN oi4.matriz_unit_cost IS NOT NULL
                                             THEN (oi4.quantity * oi4.unit_price - oi4.discount_amount)
                                                  - oi4.matriz_unit_cost * oi4.quantity END), 0) AS lucro_valor,
                           COUNT(*) FILTER (WHERE oi4.matriz_unit_cost IS NULL)::int AS itens_sem_custo
                      FROM commerce.orders o4
                      JOIN commerce.order_items oi4
                        ON oi4.order_id = o4.id AND oi4.environment = o4.environment
                      LEFT JOIN core.contacts c4 ON c4.id = o4.contact_id
                     WHERE o4.trip_id = t.id AND o4.environment = t.environment
                       AND o4.delivery_status = 'delivered' AND o4.status <> 'cancelled'
                     GROUP BY o4.id, o4.order_number, c4.name, o4.total_amount, o4.delivered_at) x), '[]'::jsonb) AS pedidos_resultado,
           (SELECT COALESCE(SUM(e.amount), 0)::text
              FROM commerce.matriz_expenses e
             WHERE e.environment = t.environment AND e.deleted_at IS NULL
               AND (e.id = t.fuel_expense_id
                    OR e.id IN (SELECT r2.ai_expense_id FROM commerce.matriz_trip_receipts r2
                                 WHERE r2.trip_id = t.id AND r2.ai_expense_id IS NOT NULL))) AS despesas_total,
           COALESCE((SELECT jsonb_agg(jsonb_build_object(
                       'id', x.id, 'category', x.category, 'description', x.description,
                       'amount', x.amount, 'occurred_at', x.occurred_at,
                       'source', x.source, 'receipt_id', x.receipt_id,
                       'receipt_summary', x.receipt_summary)
                       ORDER BY x.occurred_at, x.id)
              FROM (SELECT DISTINCT ON (e2.id)
                           e2.id, e2.category, e2.description, e2.amount, e2.occurred_at,
                           CASE WHEN r3.id IS NULL THEN 'fechamento' ELSE 'comprovante' END AS source,
                           r3.id AS receipt_id, r3.ai_summary AS receipt_summary
                      FROM commerce.matriz_expenses e2
                      LEFT JOIN commerce.matriz_trip_receipts r3
                        ON r3.trip_id = t.id AND r3.ai_expense_id = e2.id
                     WHERE e2.environment = t.environment AND e2.deleted_at IS NULL
                       AND (e2.id = t.fuel_expense_id
                            OR e2.id IN (SELECT r4.ai_expense_id FROM commerce.matriz_trip_receipts r4
                                         WHERE r4.trip_id = t.id AND r4.ai_expense_id IS NOT NULL))
                     ORDER BY e2.id, r3.created_at DESC) x), '[]'::jsonb) AS despesas,
           COALESCE((SELECT jsonb_agg(jsonb_build_object(
                       'id', r.id, 'ai_status', r.ai_status, 'ai_summary', r.ai_summary,
                       'ai_expense_id', r.ai_expense_id,
                       'expense_category', e3.category, 'expense_amount', e3.amount,
                       'created_at', r.created_at)
                       ORDER BY r.created_at DESC)
                       FROM commerce.matriz_trip_receipts r
                       LEFT JOIN commerce.matriz_expenses e3
                         ON e3.id = r.ai_expense_id AND e3.deleted_at IS NULL
                      WHERE r.trip_id = t.id), '[]'::jsonb) AS receipts
      FROM commerce.matriz_delivery_trips t
     WHERE t.environment = $1 AND t.deleted_at IS NULL`;

  const [abertas, reportadas, finalizadas, rotasAbertas, rotasRecentes] = await Promise.all([
    dbPool.query<MatrizDeliveryRow>(
      `${deliverySelect} AND o.status <> 'cancelled' AND o.delivery_status IN ('pending','dispatched')
       ORDER BY scheduled_date ASC, o.created_at ASC`, [environment]),
    // o limbo do portal (failed SEM cancelar) — mesma régua do sino (queries-notificacoes)
    dbPool.query<MatrizDeliveryRow>(
      `${deliverySelect} AND o.status <> 'cancelled' AND o.delivery_status = 'failed'
       ORDER BY o.updated_at DESC`, [environment]),
    dbPool.query<MatrizDeliveryRow>(
      `${deliverySelect} AND (o.delivery_status = 'delivered' OR o.status = 'cancelled')
       ORDER BY COALESCE(o.delivered_at, o.updated_at) DESC LIMIT 30`, [environment]),
    dbPool.query<MatrizTripRow>(
      `${tripSelect} AND t.status = 'open' ORDER BY t.started_at DESC`, [environment]),
    dbPool.query<MatrizTripRow>(
      `${tripSelect} AND t.status = 'closed' ORDER BY t.started_at DESC LIMIT 10`, [environment]),
  ]);
  return {
    abertas: abertas.rows,
    reportadas: reportadas.rows,
    finalizadas: finalizadas.rows,
    rotas_abertas: rotasAbertas.rows,
    rotas_recentes: rotasRecentes.rows,
  };
}

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
