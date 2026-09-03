// Obra 300 (2026-07-05): fatia do banco da MATRIZ — estoque do galpão por medida + resumos do atacado e do varejo.
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
import { canonicalCatalogBrand } from './catalog-brand.js';
import { requireTireCondition, type TireCondition } from '../../shared/tire-condition.js';
import { setWholesaleReplenishmentPolicy } from './queries-replenishment-policy.js';
import type { WholesaleStockRow } from './queries-galpao-list.js';
export { listWholesaleStock } from './queries-galpao-list.js';
export type { WholesaleStockRow } from './queries-galpao-list.js';

/** Define saldo, custo e mínimo da variante; null limpa o mínimo. */
export async function setWholesaleStock(
  input: { measure: string; brand?: string | null; tire_condition: TireCondition | string;
    quantity_on_hand: number; unit_cost: number; min_quantity?: number | null;
    notes?: string | null; actor_label?: string | null; environment?: 'prod' | 'test' },
  dbPool: Pool | PoolClient = defaultPool,
): Promise<WholesaleStockRow> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const raw = input.measure.trim();
  if (!raw) throw new Error('measure_required');
  if (!Number.isInteger(input.quantity_on_hand) || input.quantity_on_hand < 0) {
    throw new Error('quantity_invalid');
  }
  const unitCost = input.unit_cost;
  if (!(unitCost >= 0)) throw new Error('cost_invalid');
  const minQuantity = input.min_quantity ?? null;
  if (minQuantity !== null && (!Number.isInteger(minQuantity) || minQuantity < 0)) {
    throw new Error('min_invalid');
  }
  const cat = await resolveMeasureInCatalog(dbPool, environment, raw);
  if (!cat) throw new Error('measure_not_in_catalog');
  const brand = canonicalCatalogBrand(input.brand) ?? 'Sem marca';
  const tireCondition = requireTireCondition(input.tire_condition ?? 'meia_vida');
  const r = await dbPool.query<WholesaleStockRow>(
    `INSERT INTO commerce.wholesale_stock
            (environment, measure, brand, tire_condition, quantity_on_hand,
             unit_cost, min_quantity, notes,
             tire_width_mm, tire_aspect_ratio, tire_rim_diameter)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (environment, measure, brand, tire_condition)
     DO UPDATE SET quantity_on_hand  = EXCLUDED.quantity_on_hand,
                   unit_cost         = EXCLUDED.unit_cost,
                   min_quantity      = EXCLUDED.min_quantity,
                   notes             = EXCLUDED.notes,
                   tire_width_mm     = EXCLUDED.tire_width_mm,
                   tire_aspect_ratio = EXCLUDED.tire_aspect_ratio,
                   tire_rim_diameter = EXCLUDED.tire_rim_diameter
       RETURNING measure, brand, tire_condition, quantity_on_hand, quantity_reserved,
                 (quantity_on_hand-quantity_reserved)::int AS quantity_available, unit_cost,
                 min_quantity, notes, updated_at,
                 tire_width_mm, tire_aspect_ratio, tire_rim_diameter`,
    [environment, cat.measure, brand, tireCondition, input.quantity_on_hand,
     unitCost, minQuantity,
     input.notes?.trim() || null, cat.width, cat.aspect, cat.rim],
  );
  await setWholesaleReplenishmentPolicy(dbPool, {
    environment, measure: cat.measure, tireCondition, minQuantity,
    actorLabel: input.actor_label,
  });
  return r.rows[0]!;
}

/** Entrada com custo médio ponderado, atômica no ON CONFLICT. */
export async function addWholesaleStockEntry(
  input: { measure: string; brand?: string | null; tire_condition: TireCondition | string;
    quantity_in: number; unit_cost: number; actor_label?: string | null;
    environment?: 'prod' | 'test' },
  dbPool: Pool | PoolClient = defaultPool,
): Promise<WholesaleStockRow> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const raw = input.measure.trim();
  if (!raw) throw new Error('measure_required');
  if (!Number.isInteger(input.quantity_in) || input.quantity_in <= 0) throw new Error('quantity_invalid');
  if (!(input.unit_cost >= 0)) throw new Error('cost_invalid');
  // Fase 4: casa com o catálogo → formato OFICIAL + números; recusa fantasma.
  const cat = await resolveMeasureInCatalog(dbPool, environment, raw);
  if (!cat) throw new Error('measure_not_in_catalog');
  const brand = canonicalCatalogBrand(input.brand) ?? 'Sem marca';
  const tireCondition = requireTireCondition(input.tire_condition ?? 'meia_vida');
  const r = await dbPool.query<WholesaleStockRow>(
    `INSERT INTO commerce.wholesale_stock
            (environment, measure, brand, tire_condition, quantity_on_hand, unit_cost,
             tire_width_mm, tire_aspect_ratio, tire_rim_diameter)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (environment, measure, brand, tire_condition) DO UPDATE SET
       unit_cost = round(
         (commerce.wholesale_stock.quantity_on_hand * commerce.wholesale_stock.unit_cost
            + EXCLUDED.quantity_on_hand * EXCLUDED.unit_cost)
         / NULLIF(commerce.wholesale_stock.quantity_on_hand + EXCLUDED.quantity_on_hand, 0), 6),
       quantity_on_hand  = commerce.wholesale_stock.quantity_on_hand + EXCLUDED.quantity_on_hand,
       tire_width_mm     = EXCLUDED.tire_width_mm,
       tire_aspect_ratio = EXCLUDED.tire_aspect_ratio,
       tire_rim_diameter = EXCLUDED.tire_rim_diameter
       RETURNING measure, brand, tire_condition, quantity_on_hand, quantity_reserved,
                 (quantity_on_hand-quantity_reserved)::int AS quantity_available, unit_cost,
                 0::int AS sales_30d,min_quantity, notes, updated_at,
                 tire_width_mm, tire_aspect_ratio, tire_rim_diameter`,
    [environment, cat.measure, brand, tireCondition, input.quantity_in, input.unit_cost,
     cat.width, cat.aspect, cat.rim],
  );
  return r.rows[0]!;
}

/** Remove uma variante do estoque do galpão (ex.: cadastrou errado). */
export async function deleteWholesaleStock(
  measure: string,
  brand: string,
  tireCondition: TireCondition | string,
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool | PoolClient = defaultPool,
): Promise<void> {
  await dbPool.query(
    `DELETE FROM commerce.wholesale_stock
      WHERE environment = $1 AND measure = $2 AND brand = $3
        AND tire_condition = $4`,
    [
      environment, measure.trim(), canonicalCatalogBrand(brand),
      requireTireCondition(tireCondition),
    ],
  );
}

// ─── ATACADO (Fase 3): resumo de custo + lucro ───────────────────────────────
export type SalesPeriod = 'today' | '7d' | '30d' | 'mes' | 'tudo';

export function salesPeriodWhere(
  period: SalesPeriod,
  column = 'o.created_at',
  selectedMonthParam?: number,
): string {
  if (period === 'tudo') return '';
  if (period === 'today') {
    return `AND ${column} >= (date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo')
            AND ${column} < ((date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') + INTERVAL '1 day') AT TIME ZONE 'America/Sao_Paulo')`;
  }
  if (period === '7d' || period === '30d') {
    const days = period === '7d' ? 6 : 29;
    return `AND ${column} >= ((date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') - INTERVAL '${days} days') AT TIME ZONE 'America/Sao_Paulo')
            AND ${column} < ((date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') + INTERVAL '1 day') AT TIME ZONE 'America/Sao_Paulo')`;
  }
  if (selectedMonthParam) {
    return `AND (${column} AT TIME ZONE 'America/Sao_Paulo') >= to_date($${selectedMonthParam},'YYYY-MM')
            AND (${column} AT TIME ZONE 'America/Sao_Paulo') < (to_date($${selectedMonthParam},'YYYY-MM') + INTERVAL '1 month')`;
  }
  return `AND ${column} >= (date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo')
          AND ${column} < ((date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo') + INTERVAL '1 month') AT TIME ZONE 'America/Sao_Paulo')`;
}

export interface WholesaleResumoRow {
  faturamento: string;
  custo_total: string;
  lucro_total: string;
  vendas_count: number;
  cancelled_count: number;
}

/** Totais do atacado (vendas confirmadas): faturamento, custo e lucro.
 *  lucro = faturamento − custo (line_profit somado; pode ser negativo se vendeu abaixo).
 *  `period` 'mes' = só o mês corrente (fuso America/Sao_Paulo); 'tudo' = desde sempre. */
export async function getWholesaleResumo(
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
  period: SalesPeriod = 'tudo',
  selectedMonth?: string,
): Promise<WholesaleResumoRow> {
  // Carga para parceiro só vira venda quando a Matriz conclui o acerto da chegada.
  const recognizedAt = `(CASE WHEN o.partner_transfer_status IN ('settled','received') THEN
    COALESCE(o.partner_settled_at,o.sold_at) ELSE o.sold_at END)`;
  const periodWhere = salesPeriodWhere(period, recognizedAt, selectedMonth ? 2 : undefined);
  const r = await dbPool.query<WholesaleResumoRow>(
    `SELECT
       COALESCE(SUM(oi.unit_price * CASE WHEN o.partner_transfer_status IS NULL
           THEN oi.quantity ELSE oi.accepted_quantity END)
         FILTER (WHERE o.status='confirmed' AND (o.partner_transfer_status IS NULL
           OR o.partner_transfer_status IN ('settled','received'))),0) AS faturamento,
       COALESCE(SUM(oi.unit_cost * CASE WHEN o.partner_transfer_status IS NULL
           THEN oi.quantity ELSE oi.accepted_quantity END)
         FILTER (WHERE o.status='confirmed' AND (o.partner_transfer_status IS NULL
           OR o.partner_transfer_status IN ('settled','received'))),0) AS custo_total,
       COALESCE(SUM((oi.unit_price-oi.unit_cost) * CASE WHEN o.partner_transfer_status IS NULL
           THEN oi.quantity ELSE oi.accepted_quantity END)
         FILTER (WHERE o.status='confirmed' AND (o.partner_transfer_status IS NULL
           OR o.partner_transfer_status IN ('settled','received'))),0) AS lucro_total,
       COUNT(DISTINCT o.id) FILTER (WHERE o.status='confirmed'
         AND (o.partner_transfer_status IS NULL
           OR o.partner_transfer_status IN ('settled','received')))::int AS vendas_count,
       COUNT(DISTINCT o.id) FILTER (WHERE o.status = 'cancelled')::int                    AS cancelled_count
       FROM commerce.wholesale_orders o
       JOIN commerce.wholesale_order_items oi
         ON oi.order_id = o.id AND oi.environment = o.environment
      WHERE o.environment = $1 ${periodWhere}`,
    selectedMonth ? [environment, selectedMonth] : [environment],
  );
  return r.rows[0]!;
}

// ─── VAREJO DA MATRIZ (0117 — fatia 2): resumo com custo CONGELADO + recorte por mês ─
export interface VarejoResumoRow {
  faturamento: string;
  faturamento_total: string;
  frete_total: string;
  receita_custo_conhecido: string;
  receita_custo_pendente: string;
  custo_total: string;
  lucro_total: string;
  vendas_count: number;
  itens_sem_custo: number;
  pedidos_custo_pendente: number;
  cancelled_count: number;
  pending_count: number;
}

/** Totais do VAREJO da matriz (pedidos da unit 'main', cancelado fora) com o custo
 *  congelado na venda (order_items.matriz_unit_cost). Honestidade: custo e lucro só
 *  somam linhas COM custo congelado; `itens_sem_custo` conta as que ficaram de fora
 *  (venda antiga, flag off, medida sem custo no galpão) pra UI avisar em vez de chutar.
 *  A régua de "venda do varejo" é a MESMA do card/tabela da aba Vendas (unit slug='main'
 *  e não-cancelado) — o resumo nunca diverge da lista. */
export async function getVarejoResumo(
  period: SalesPeriod = 'tudo',
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
  selectedMonth?: string,
): Promise<VarejoResumoRow> {
  const recognizedAt = `(CASE WHEN o.fulfillment_mode='delivery'
    THEN o.delivered_at ELSE o.created_at END)`;
  const periodWhere = salesPeriodWhere(period, recognizedAt, selectedMonth ? 2 : undefined);
  const r = await dbPool.query<VarejoResumoRow>(
    `SELECT
       COALESCE(SUM(x.item_total) FILTER (WHERE x.status IN ('confirmed','paid','delivered')),0) AS faturamento,
       COALESCE(SUM(x.total_amount) FILTER (WHERE x.status IN ('confirmed','paid','delivered')),0) AS faturamento_total,
       COALESCE(SUM(GREATEST(x.total_amount-x.item_total,0))
         FILTER (WHERE x.status IN ('confirmed','paid','delivered') AND x.fulfillment_mode='delivery'),0) AS frete_total,
       COALESCE(SUM(x.known_revenue) FILTER (WHERE x.status IN ('confirmed','paid','delivered')),0) AS receita_custo_conhecido,
       COALESCE(SUM(x.pending_revenue) FILTER (WHERE x.status IN ('confirmed','paid','delivered')),0) AS receita_custo_pendente,
       COALESCE(SUM(x.known_cost) FILTER (WHERE x.status IN ('confirmed','paid','delivered')),0) AS custo_total,
       COALESCE(SUM(x.known_revenue-x.known_cost) FILTER (WHERE x.status IN ('confirmed','paid','delivered')),0) AS lucro_total,
       COUNT(*) FILTER (WHERE x.status IN ('confirmed','paid','delivered'))::int AS vendas_count,
       COALESCE(SUM(x.pending_items) FILTER (WHERE x.status IN ('confirmed','paid','delivered')),0)::int AS itens_sem_custo,
       COUNT(*) FILTER (WHERE x.status IN ('confirmed','paid','delivered') AND x.pending_items>0)::int AS pedidos_custo_pendente,
       COUNT(*) FILTER (WHERE x.status = 'cancelled')::int AS cancelled_count,
       COUNT(*) FILTER (WHERE x.status IN ('open','pending'))::int AS pending_count
      FROM (
        SELECT o.id,o.status,o.total_amount,o.fulfillment_mode,
               SUM(oi.quantity*oi.unit_price-oi.discount_amount) item_total,
               COALESCE(SUM(oi.quantity*oi.unit_price-oi.discount_amount)
                 FILTER (WHERE oi.matriz_unit_cost IS NOT NULL),0) known_revenue,
               COALESCE(SUM(oi.quantity*oi.unit_price-oi.discount_amount)
                 FILTER (WHERE oi.matriz_unit_cost IS NULL),0) pending_revenue,
               COALESCE(SUM(oi.matriz_unit_cost*oi.quantity)
                 FILTER (WHERE oi.matriz_unit_cost IS NOT NULL),0) known_cost,
               COUNT(*) FILTER (WHERE oi.matriz_unit_cost IS NULL)::int pending_items
          FROM commerce.orders o
          JOIN core.units u ON u.id=o.unit_id AND u.environment=o.environment AND u.slug='main'
          JOIN commerce.order_items oi ON oi.order_id=o.id AND oi.environment=o.environment
         WHERE o.environment=$1 ${periodWhere}
         GROUP BY o.id
      ) x`,
    selectedMonth ? [environment, selectedMonth] : [environment],
  );
  return r.rows[0]!;
}
