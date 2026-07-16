// SINO da matriz (2026-07-06): agregador das notificações REAIS do painel.
// O sino do topo existia desde o desenho e nunca tocou (notificacoes: [] morto).
// Aqui ele ganha as fontes que JÁ EXISTEM no banco — nenhuma tabela nova:
//   • entrega FALHADA aguardando o dono (portal 0125 reporta failed SEM cancelar);
//   • fiado do atacado VENCIDO (a receber — régua da getWholesaleFinance);
//   • contas VENCIDAS a pagar (fiado de compra 0114 + despesas 0120);
//   • galpão pra REPOR (0126: min_quantity definido e qty <= min).
// A notificação de comissão >= alarme NÃO mora aqui: o alarme do dono vive no
// localStorage do front (app.comissoes.js) — o front soma essa sozinho.
// SÓ LEITURA. Réguas espelham as telas (logística/financeiro/estoque) — o sino
// nunca diverge do que a aba mostra.
import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { MAIN_DELIVERY_GUARD } from './queries-logistica.js';

export interface MatrizNotificacoesPayload {
  /** Entregas da MAIN com delivery_status='failed' e pedido NÃO cancelado —
   *  o limbo "o entregador reportou, o dono decide" (recolocar ou cancelar). */
  entregas_falhadas: Array<{ order_id: string; customer_name: string | null; reason: string | null }>;
  fiado_vencido: { count: number; total: string };
  a_pagar_vencido: { count: number; total: string };
  galpao_repor: Array<{ measure: string; quantity_on_hand: number; min_quantity: number }>;
}

/** Uma viagem só ao banco (4 subqueries baratas) — roda no load e no refresh de 15s. */
export async function getMatrizNotificacoes(
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<MatrizNotificacoesPayload> {
  const r = await dbPool.query<{
    entregas_falhadas: MatrizNotificacoesPayload['entregas_falhadas'] | null;
    fiado_count: number; fiado_total: string;
    pagar_count: number; pagar_total: string;
    galpao_repor: MatrizNotificacoesPayload['galpao_repor'] | null;
  }>(
    `SELECT
       (SELECT json_agg(json_build_object(
                 'order_id', o.id, 'customer_name', c.name,
                 'reason', o.delivery_failure_reason)
               ORDER BY o.updated_at DESC)
          FROM commerce.orders o
          LEFT JOIN core.contacts c ON c.id = o.contact_id
         WHERE o.environment = $1 AND o.delivery_status = 'failed'
           AND o.status <> 'cancelled' AND ${MAIN_DELIVERY_GUARD}) AS entregas_falhadas,

       (SELECT count(*)::int FROM commerce.wholesale_orders w
         WHERE w.environment = $1 AND w.status = 'confirmed' AND w.payment_status = 'pending'
           AND w.due_date IS NOT NULL AND w.due_date < current_date) AS fiado_count,
       (SELECT COALESCE(sum(w.total_amount), 0)::text FROM commerce.wholesale_orders w
         WHERE w.environment = $1 AND w.status = 'confirmed' AND w.payment_status = 'pending'
           AND w.due_date IS NOT NULL AND w.due_date < current_date) AS fiado_total,

       (SELECT count(*)::int + (SELECT count(*)::int FROM commerce.matriz_expenses e
                                 WHERE e.environment = $1 AND e.deleted_at IS NULL
                                   AND e.payment_status = 'pending'
                                   AND e.due_date IS NOT NULL AND e.due_date < current_date)
          FROM commerce.wholesale_purchases p
         WHERE p.environment = $1 AND p.status <> 'cancelled' AND p.payment_status = 'pending'
           AND p.due_date IS NOT NULL AND p.due_date < current_date) AS pagar_count,
       (SELECT (COALESCE(sum(p.total_amount), 0)
                + (SELECT COALESCE(sum(e.amount), 0) FROM commerce.matriz_expenses e
                    WHERE e.environment = $1 AND e.deleted_at IS NULL
                      AND e.payment_status = 'pending'
                      AND e.due_date IS NOT NULL AND e.due_date < current_date))::text
          FROM commerce.wholesale_purchases p
         WHERE p.environment = $1 AND p.status <> 'cancelled' AND p.payment_status = 'pending'
           AND p.due_date IS NOT NULL AND p.due_date < current_date) AS pagar_total,

       (SELECT json_agg(json_build_object(
                 'measure', s.measure, 'quantity_on_hand', s.quantity_on_hand,
                 'min_quantity', s.min_quantity)
               ORDER BY s.quantity_on_hand::numeric / NULLIF(s.min_quantity, 0))
          FROM commerce.wholesale_stock s
         WHERE s.environment = $1 AND s.min_quantity IS NOT NULL
           AND s.quantity_on_hand <= s.min_quantity) AS galpao_repor`,
    [environment],
  );
  const row = r.rows[0]!;
  return {
    entregas_falhadas: row.entregas_falhadas ?? [],
    fiado_vencido: { count: row.fiado_count, total: row.fiado_total },
    a_pagar_vencido: { count: row.pagar_count, total: row.pagar_total },
    galpao_repor: row.galpao_repor ?? [],
  };
}
