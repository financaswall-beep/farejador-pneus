// Leitura da Logistica da Matriz: entregas, rotas e memoria do resultado.
import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
export const MAIN_DELIVERY_GUARD = `
  o.fulfillment_mode = 'delivery'
  AND EXISTS (SELECT 1 FROM core.units u
               WHERE u.id = o.unit_id AND u.environment = o.environment AND u.slug = 'main')`;
export interface MatrizDeliveryRow {
  order_id: string; order_number: string | null;
  customer_name: string | null; customer_phone: string | null;
  delivery_address: string | null; total_amount: string;
  payment_method: string | null;
  status: string;
  delivery_status: 'pending' | 'dispatched' | 'delivered' | 'failed';
  delivery_courier: string | null;
  /** 0125: motivo do não-entregue REPORTADO pelo portal (failed sem cancelar =
   *  aguardando o dono confirmar ou recolocar). NULL fora desse limbo. */
  delivery_failure_reason: string | null;
  trip_id: string | null;
  created_at: string; dispatched_at: string | null; delivered_at: string | null;
  /** Data EFETIVA de entrega prevista (YYYY-MM-DD): a remarcada, ou o padrão D+1
   *  (created_at+1, fuso SP) quando nunca foi remarcada. */
  scheduled_date: string;
  /** A data remarcada crua (NULL = usando o padrão D+1). Só pra UI saber se o dono
   *  já mexeu na data. */
  scheduled_raw: string | null;
  items: Array<{ quantity: number; label: string }>;
}
export interface MatrizTripRow {
  id: string; trip_number: string; courier_name: string;
  /** Número amigável (0129): ROTA-0001, ... — o que o dono fala/audita. */
  status: 'open' | 'closed';
  km_start: string | null; km_end: string | null; fuel_spent: string | null;
  fuel_expense_id: string | null; fuel_spent_without_approved_expense: boolean;
  financial_status: 'pending' | 'divergent' | 'reconciled';
  approved_fuel_amount: string; notes: string | null;
  started_at: string; ended_at: string | null;
  deliveries_count: number; orders_total: string; remaining_count: number;
  /** "A rota se pagou?" — SÓ das entregas DELIVERED da rota (failed/cancelada fora).
   *  Régua do lucro = a MESMA do varejo 0117 (custo congelado; item sem custo fica
   *  fora do lucro e é CONTADO pra UI avisar — nunca chuta). Frete = total_amount −
   *  itens (o bot embute o frete no total; walk-in sem frete → 0, nunca negativo). */
  resumo: {
    entregues: number; nao_entregues: number;
    faturamento_total: number; frete_total: number; faturamento_pneus: number;
    custo_pneus: number; lucro_pneus: number; itens_sem_custo: number;
  };
  /** Σ despesas vivas amarradas à rota (fechamento ∪ comprovantes lidos — o IN
   *  dedup cobre o linked_existing; deleted_at IS NULL = dono apagou, rota reflete). */
  despesas_total: string;
  /** Pedidos entregues que formam o resultado. Valores de custo continuam
   *  parciais quando algum item não tinha snapshot — a UI sinaliza, nunca estima. */
  pedidos_resultado: Array<{
    order_id: string; order_number: string | null; customer_name: string | null;
    total: number; faturamento_pneus: number; custo_pneus: number;
    frete: number; margem_antes_rota: number; itens_sem_custo: number;
  }>;
  /** Despesas únicas realmente vinculadas à rota. O mesmo expense pode ser
   *  lastreado por mais de um comprovante; DISTINCT evita dupla contagem. */
  despesas: Array<{
    id: string; category: string; description: string | null;
    amount: number; occurred_at: string;
    source: 'comprovante' | 'fechamento';
    receipt_id: string | null; receipt_summary: string | null;
  }>;
  receipts: Array<{
    id: string; ai_summary: string | null; ai_expense_id: string | null;
    ai_status: 'pending' | 'parsed' | 'unreadable' | 'skipped';
    workflow_status: 'uploaded' | 'processing' | 'review_required' | 'linked' | 'rejected' | 'legacy_linked';
    expense_category: string | null; expense_amount: number | null; expense_removed: boolean;
    latest_attempt: Record<string, unknown> | null; decision: Record<string, unknown> | null;
    created_at: string;
  }>;
  detached_reports: Array<{
    order_id: string; delivery_failure_reason: string | null; detached_at: string;
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
           commerce.matriz_trip_financial_status(t.id,t.environment) AS financial_status,
           (SELECT COALESCE(sum(x.amount),0)::text FROM (
             SELECT DISTINCT ef2.id,ef2.amount
               FROM commerce.matriz_trip_receipts rf2
               JOIN commerce.matriz_expenses ef2
                 ON ef2.id=rf2.ai_expense_id AND ef2.environment=rf2.environment
                AND ef2.deleted_at IS NULL AND ef2.category='combustivel'
              WHERE rf2.environment=t.environment AND rf2.trip_id=t.id
                AND rf2.workflow_status IN ('linked','legacy_linked')) x) AS approved_fuel_amount,
           (COALESCE(t.fuel_spent,0)>0 AND NOT EXISTS (
             SELECT 1 FROM commerce.matriz_expenses ef
              WHERE ef.environment=t.environment AND ef.deleted_at IS NULL
                AND ef.category='combustivel'
                AND (ef.id=t.fuel_expense_id OR ef.id IN (
                  SELECT rf.ai_expense_id FROM commerce.matriz_trip_receipts rf
                   WHERE rf.environment=t.environment AND rf.trip_id=t.id
                     AND rf.workflow_status IN ('linked','legacy_linked')
                     AND rf.ai_expense_id IS NOT NULL)))) AS fuel_spent_without_approved_expense,
           ((SELECT COUNT(*)::int FROM commerce.orders o
               WHERE o.trip_id = t.id AND o.environment = t.environment)
             + (SELECT COUNT(*)::int FROM audit.events ae
                 WHERE ae.environment=t.environment::text
                   AND ae.domain='matriz_logistics'
                   AND ae.event_type='delivery_report_detached_on_trip_close'
                   AND ae.payload_before->>'trip_id'=t.id::text)) AS deliveries_count,
           (SELECT COALESCE(SUM(o.total_amount),0)::text FROM commerce.orders o
             WHERE o.trip_id=t.id AND o.environment=t.environment AND o.status<>'cancelled') AS orders_total,
           (SELECT COUNT(*)::int FROM commerce.orders o
             WHERE o.trip_id=t.id AND o.environment=t.environment AND o.status<>'cancelled'
               AND o.delivery_status IN ('pending','dispatched')) AS remaining_count,
           (SELECT jsonb_build_object(
                     'entregues', COUNT(*),
                     'nao_entregues', ((SELECT COUNT(*)::int FROM commerce.orders o3
                                        WHERE o3.trip_id = t.id AND o3.environment = t.environment
                                          AND (o3.delivery_status = 'failed' OR o3.status = 'cancelled'))
                       + (SELECT COUNT(*)::int FROM audit.events ae2
                           WHERE ae2.environment=t.environment::text
                             AND ae2.domain='matriz_logistics'
                             AND ae2.event_type='delivery_report_detached_on_trip_close'
                             AND ae2.payload_before->>'trip_id'=t.id::text)),
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
                                 WHERE r2.environment=t.environment AND r2.trip_id=t.id
                                   AND r2.workflow_status IN ('linked','legacy_linked')
                                   AND r2.ai_expense_id IS NOT NULL))) AS despesas_total,
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
                        ON r3.environment=t.environment AND r3.trip_id=t.id
                       AND r3.workflow_status IN ('linked','legacy_linked')
                       AND r3.ai_expense_id = e2.id
                     WHERE e2.environment = t.environment AND e2.deleted_at IS NULL
                       AND (e2.id = t.fuel_expense_id
                            OR e2.id IN (SELECT r4.ai_expense_id FROM commerce.matriz_trip_receipts r4
                                         WHERE r4.environment=t.environment AND r4.trip_id=t.id
                                           AND r4.workflow_status IN ('linked','legacy_linked')
                                           AND r4.ai_expense_id IS NOT NULL))
                     ORDER BY e2.id, r3.created_at DESC) x), '[]'::jsonb) AS despesas,
           COALESCE((SELECT jsonb_agg(jsonb_build_object(
                       'id', r.id, 'ai_status', r.ai_status,
                       'workflow_status', r.workflow_status, 'ai_summary', r.ai_summary,
                       'ai_expense_id', r.ai_expense_id,
                       'expense_category', e3.category, 'expense_amount', e3.amount,
                       'expense_removed', (r.ai_expense_id IS NOT NULL AND e3.id IS NULL),
                       'latest_attempt', (SELECT jsonb_build_object(
                         'id',a.id,'attempt_no',a.attempt_no,'status',a.status,
                         'amount',a.suggested_amount,'category',a.suggested_category,
                         'merchant',a.suggested_merchant,'document_date',a.suggested_document_date,
                         'confidence',a.confidence,'summary',a.summary,'error_code',a.error_code,
                         'model',a.model,'extractor_version',a.extractor_version,
                         'prompt_version',a.prompt_version,'started_at',a.started_at,
                         'finished_at',a.finished_at)
                           FROM commerce.matriz_trip_receipt_ai_attempts a
                          WHERE a.environment=r.environment AND a.receipt_id=r.id
                          ORDER BY a.attempt_no DESC LIMIT 1),
                       'decision', (SELECT jsonb_build_object(
                         'id',d.id,'action',d.action,'actor_label',d.actor_label,
                         'approved_amount',d.approved_amount,'approved_category',d.approved_category,
                         'approved_merchant',d.approved_merchant,'document_date',d.document_date,
                         'competence_month',d.competence_month,'payment_status',d.payment_status,
                         'payment_date',d.payment_date,'due_date',d.due_date,'reason',d.reason,
                         'differences',d.differences,'expense_id',d.expense_id,'created_at',d.created_at)
                           FROM commerce.matriz_trip_receipt_decisions d
                          WHERE d.environment=r.environment AND d.receipt_id=r.id),
                       'created_at', r.created_at)
                       ORDER BY r.created_at DESC)
                       FROM commerce.matriz_trip_receipts r
                       LEFT JOIN commerce.matriz_expenses e3
                         ON e3.environment=r.environment AND e3.id=r.ai_expense_id
                        AND e3.deleted_at IS NULL
                      WHERE r.environment=t.environment AND r.trip_id=t.id), '[]'::jsonb) AS receipts,
           COALESCE((SELECT jsonb_agg(jsonb_build_object(
                       'order_id',ae3.entity_id,
                       'delivery_failure_reason',ae3.payload_before->>'delivery_failure_reason',
                       'detached_at',ae3.created_at)
                       ORDER BY ae3.created_at)
                       FROM audit.events ae3
                      WHERE ae3.environment=t.environment::text
                        AND ae3.domain='matriz_logistics'
                        AND ae3.event_type='delivery_report_detached_on_trip_close'
                        AND ae3.payload_before->>'trip_id'=t.id::text), '[]'::jsonb) AS detached_reports
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
