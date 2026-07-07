// Obra 300 (2026-07-05): fatia do banco da MATRIZ — estoque do galpão por medida + resumos do atacado e do varejo.
// VERBATIM das linhas 1225-1447 do queries.ts pré-obra (commit 2628748).
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

export interface WholesaleStockRow {
  measure: string;
  quantity_on_hand: number;
  unit_cost: number;
  /** 0126: estoque mínimo da medida. NULL = sem mínimo (não alerta). qty <= min => "repor". */
  min_quantity: number | null;
  notes: string | null;
  updated_at: string;
  tire_width_mm: number | null;
  tire_aspect_ratio: number | null;
  tire_rim_diameter: number | null;
}

/** Lista o estoque do galpão (uma linha por medida), ordenado pela medida. */
export async function listWholesaleStock(
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<WholesaleStockRow[]> {
  const r = await dbPool.query<WholesaleStockRow>(
    `SELECT measure, quantity_on_hand, unit_cost, min_quantity, notes, updated_at,
            tire_width_mm, tire_aspect_ratio, tire_rim_diameter
       FROM commerce.wholesale_stock
      WHERE environment = $1
      ORDER BY measure`,
    [environment],
  );
  return r.rows;
}

/** Define quantidade + custo unitário + mínimo de uma medida (upsert por medida).
 *  min_quantity: null LIMPA o mínimo (campo vazio no form = sem alerta); o form
 *  "Definir" sempre manda o valor completo — não há merge parcial. */
export async function setWholesaleStock(
  input: { measure: string; quantity_on_hand: number; unit_cost?: number; min_quantity?: number | null; notes?: string | null; environment?: 'prod' | 'test' },
  dbPool: Pool | PoolClient = defaultPool,
): Promise<WholesaleStockRow> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const raw = input.measure.trim();
  if (!raw) throw new Error('measure_required');
  if (!Number.isInteger(input.quantity_on_hand) || input.quantity_on_hand < 0) {
    throw new Error('quantity_invalid');
  }
  const unitCost = input.unit_cost ?? 0;
  if (!(unitCost >= 0)) throw new Error('cost_invalid');
  const minQuantity = input.min_quantity ?? null;
  if (minQuantity !== null && (!Number.isInteger(minQuantity) || minQuantity < 0)) {
    throw new Error('min_invalid');
  }
  // Fase 4: casa com o catálogo → grava o formato OFICIAL + os números; recusa fantasma.
  const cat = await resolveMeasureInCatalog(dbPool, environment, raw);
  if (!cat) throw new Error('measure_not_in_catalog');
  const r = await dbPool.query<WholesaleStockRow>(
    `INSERT INTO commerce.wholesale_stock
            (environment, measure, quantity_on_hand, unit_cost, min_quantity, notes,
             tire_width_mm, tire_aspect_ratio, tire_rim_diameter)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (environment, measure)
     DO UPDATE SET quantity_on_hand  = EXCLUDED.quantity_on_hand,
                   unit_cost         = EXCLUDED.unit_cost,
                   min_quantity      = EXCLUDED.min_quantity,
                   notes             = EXCLUDED.notes,
                   tire_width_mm     = EXCLUDED.tire_width_mm,
                   tire_aspect_ratio = EXCLUDED.tire_aspect_ratio,
                   tire_rim_diameter = EXCLUDED.tire_rim_diameter
       RETURNING measure, quantity_on_hand, unit_cost, min_quantity, notes, updated_at,
                 tire_width_mm, tire_aspect_ratio, tire_rim_diameter`,
    [environment, cat.measure, input.quantity_on_hand, unitCost, minQuantity, input.notes?.trim() || null,
     cat.width, cat.aspect, cat.rim],
  );
  return r.rows[0]!;
}

/** ENTRADA de compra (custo médio): soma quantity_in ao estoque da medida e recalcula o
 *  CUSTO MÉDIO PONDERADO — novo = (qty_atual*custo_atual + qty_in*custo_in)/(qty_atual+qty_in).
 *  É como "a contabilidade bate" comprando a precos diferentes. Atômico no ON CONFLICT
 *  (usa os valores ANTIGOS da linha no DO UPDATE). Primeira entrada = grava o custo direto. */
export async function addWholesaleStockEntry(
  input: { measure: string; quantity_in: number; unit_cost: number; environment?: 'prod' | 'test' },
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
  const r = await dbPool.query<WholesaleStockRow>(
    `INSERT INTO commerce.wholesale_stock
            (environment, measure, quantity_on_hand, unit_cost,
             tire_width_mm, tire_aspect_ratio, tire_rim_diameter)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (environment, measure) DO UPDATE SET
       unit_cost = round(
         (commerce.wholesale_stock.quantity_on_hand * commerce.wholesale_stock.unit_cost
            + EXCLUDED.quantity_on_hand * EXCLUDED.unit_cost)
         / NULLIF(commerce.wholesale_stock.quantity_on_hand + EXCLUDED.quantity_on_hand, 0), 2),
       quantity_on_hand  = commerce.wholesale_stock.quantity_on_hand + EXCLUDED.quantity_on_hand,
       tire_width_mm     = EXCLUDED.tire_width_mm,
       tire_aspect_ratio = EXCLUDED.tire_aspect_ratio,
       tire_rim_diameter = EXCLUDED.tire_rim_diameter
       RETURNING measure, quantity_on_hand, unit_cost, min_quantity, notes, updated_at,
                 tire_width_mm, tire_aspect_ratio, tire_rim_diameter`,
    [environment, cat.measure, input.quantity_in, input.unit_cost, cat.width, cat.aspect, cat.rim],
  );
  return r.rows[0]!;
}

/** Remove uma medida do estoque do galpão (ex.: cadastrou errado). */
export async function deleteWholesaleStock(
  measure: string,
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool | PoolClient = defaultPool,
): Promise<void> {
  await dbPool.query(
    `DELETE FROM commerce.wholesale_stock WHERE environment = $1 AND measure = $2`,
    [environment, measure.trim()],
  );
}

export interface WholesaleMeasureRow {
  measure: string;
  quantity_on_hand: number | null; // null = conhecida no catálogo, sem estoque cadastrado
  unit_cost: number | null;        // custo unitário cadastrado (null = sem estoque)
}

/** Medidas pro autocomplete da venda: catálogo (tire_specs) ∪ estoque do galpão, com a
 *  quantidade em mãos e o custo (null quando a medida só existe no catálogo). */
export async function listWholesaleMeasures(
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<WholesaleMeasureRow[]> {
  const r = await dbPool.query<WholesaleMeasureRow>(
    `SELECT m.measure, ws.quantity_on_hand, ws.unit_cost
       FROM (
              SELECT DISTINCT tire_size AS measure
                FROM commerce.tire_specs
               WHERE environment = $1 AND tire_size IS NOT NULL
              UNION
              SELECT measure FROM commerce.wholesale_stock WHERE environment = $1
            ) m
       LEFT JOIN commerce.wholesale_stock ws
              ON ws.environment = $1 AND ws.measure = m.measure
      ORDER BY m.measure`,
    [environment],
  );
  return r.rows;
}

// ─── ATACADO (Fase 3): resumo de custo + lucro ───────────────────────────────
export interface WholesaleResumoRow {
  faturamento: string;
  custo_total: string;
  lucro_total: string;
  vendas_count: number;
}

/** Totais do atacado (vendas confirmadas): faturamento, custo e lucro.
 *  lucro = faturamento − custo (line_profit somado; pode ser negativo se vendeu abaixo).
 *  `period` 'mes' = só o mês corrente (fuso America/Sao_Paulo); 'tudo' = desde sempre. */
export async function getWholesaleResumo(
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
  period: 'mes' | 'tudo' = 'tudo',
): Promise<WholesaleResumoRow> {
  const periodWhere = period === 'mes'
    ? `AND (o.created_at AT TIME ZONE 'America/Sao_Paulo') >= date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo')`
    : '';
  const r = await dbPool.query<WholesaleResumoRow>(
    `SELECT
       COALESCE(SUM(oi.line_total), 0)              AS faturamento,
       COALESCE(SUM(oi.unit_cost * oi.quantity), 0) AS custo_total,
       COALESCE(SUM(oi.line_profit), 0)             AS lucro_total,
       COUNT(DISTINCT o.id)                         AS vendas_count
       FROM commerce.wholesale_orders o
       JOIN commerce.wholesale_order_items oi
         ON oi.order_id = o.id AND oi.environment = o.environment
      WHERE o.environment = $1 AND o.status = 'confirmed' ${periodWhere}`,
    [environment],
  );
  return r.rows[0]!;
}

// ─── VAREJO DA MATRIZ (0117 — fatia 2): resumo com custo CONGELADO + recorte por mês ─
export interface VarejoResumoRow {
  faturamento: string;
  custo_total: string;
  lucro_total: string;
  vendas_count: number;
  itens_sem_custo: number;
}

/** Totais do VAREJO da matriz (pedidos da unit 'main', cancelado fora) com o custo
 *  congelado na venda (order_items.matriz_unit_cost). Honestidade: custo e lucro só
 *  somam linhas COM custo congelado; `itens_sem_custo` conta as que ficaram de fora
 *  (venda antiga, flag off, medida sem custo no galpão) pra UI avisar em vez de chutar.
 *  A régua de "venda do varejo" é a MESMA do card/tabela da aba Vendas (unit slug='main'
 *  e não-cancelado) — o resumo nunca diverge da lista. */
export async function getVarejoResumo(
  period: 'mes' | 'tudo' = 'tudo',
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<VarejoResumoRow> {
  const periodWhere = period === 'mes'
    ? `AND (o.created_at AT TIME ZONE 'America/Sao_Paulo') >= date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo')`
    : '';
  const r = await dbPool.query<VarejoResumoRow>(
    `SELECT
       COALESCE(SUM(oi.quantity * oi.unit_price - oi.discount_amount), 0)  AS faturamento,
       COALESCE(SUM(oi.matriz_unit_cost * oi.quantity), 0)                 AS custo_total,
       COALESCE(SUM(CASE WHEN oi.matriz_unit_cost IS NOT NULL
                         THEN (oi.quantity * oi.unit_price - oi.discount_amount)
                              - oi.matriz_unit_cost * oi.quantity END), 0) AS lucro_total,
       COUNT(DISTINCT o.id)::int                                           AS vendas_count,
       COUNT(*) FILTER (WHERE oi.matriz_unit_cost IS NULL)::int            AS itens_sem_custo
       FROM commerce.orders o
       JOIN core.units u
         ON u.id = o.unit_id AND u.environment = o.environment AND u.slug = 'main'
       JOIN commerce.order_items oi
         ON oi.order_id = o.id AND oi.environment = o.environment
      WHERE o.environment = $1 AND o.status <> 'cancelled' ${periodWhere}`,
    [environment],
  );
  return r.rows[0]!;
}

// ─── ATACADO — FORNECEDORES (0114): o lado de ENTRADA do galpão ───────────────
// De quem o dono COMPRA o pneu usado. Cada COMPRA registra a origem E alimenta o
// custo médio do galpão (addWholesaleStockEntry, mesma transação). Dado SÓ da matriz
// (sem grant pro parceiro). Paga à vista hoje (payment_status default 'paid').

