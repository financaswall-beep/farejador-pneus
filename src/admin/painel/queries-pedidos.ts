// Obra 300 (2026-07-05): fatia do banco da MATRIZ — tipos de pedido + getPainelPedidos/Produtos + período/fuso do painel.
// VERBATIM das linhas 11-129 do queries.ts pré-obra (commit 2628748).
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
import { buildMatrizStockIndex, matrizStockForMeasure } from '../../shared/matriz-stock-source.js';

export type SourceTagChatwoot = 'chatwoot_com_bot' | 'chatwoot_sem_bot';
export type SourceTagWalkin = 'walkin_balcao' | 'walkin_telefone' | 'walkin_outro';

export interface RegisterManualOrderInput {
  environment?: 'prod' | 'test';
  contact_id?: string;
  conversation_id: string;
  draft_id?: string | null;
  unit_id?: string | null;
  items: Array<{
    product_id: string;
    quantity: number;
    unit_price: number;
    discount_amount?: number;
  }>;
  payment_method: string | null;
  fulfillment_mode: 'delivery' | 'pickup';
  delivery_address?: string | null;
  actor_label: string;
  seller_collaborator_id?: string | null;
  idempotency_key: string;
  source_tag?: SourceTagChatwoot | null;
}

export interface RegisterWalkinOrderInput {
  environment?: 'prod' | 'test';
  customer_name?: string | null;
  customer_phone?: string | null;
  unit_id?: string | null;
  items: Array<{
    product_id: string;
    quantity: number;
    unit_price: number;
    discount_amount?: number;
  }>;
  payment_method: string | null;
  fulfillment_mode: 'delivery' | 'pickup';
  delivery_address?: string | null;
  actor_label: string;
  seller_collaborator_id?: string | null;
  idempotency_key: string;
  source_tag: SourceTagWalkin;
}

export interface CancelManualOrderInput {
  order_id: string;
  actor_label: string;
  reason: string;
  environment?: 'prod' | 'test';
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function clampLimit(limit?: number): number {
  if (!limit || Number.isNaN(limit)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)));
}

export async function getPainelPedidos(limit?: number, dbPool: Pool = defaultPool): Promise<unknown[]> {
  const result = await dbPool.query(
    `SELECT *
     FROM dashboard.pedidos_recentes
     WHERE environment = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [env.FAREJADOR_ENV, clampLimit(limit)],
  );
  return result.rows;
}

export async function getPainelProdutos(limit?: number, dbPool: Pool = defaultPool): Promise<unknown[]> {
  const catalog = await dbPool.query<{
    product_id: string; product_code: string; product_name: string; product_type: string;
    brand: string | null; tire_size: string | null; tire_position: string | null;
    price_amount: number | string | null; currency: string | null;
  }>(
    `SELECT p.id AS product_id, p.product_code, p.product_name, p.product_type, p.brand,
            ts.tire_size, ts.position AS tire_position, cp.price_amount, cp.currency
       FROM commerce.products p
       LEFT JOIN commerce.tire_specs ts
         ON ts.product_id = p.id AND ts.environment = p.environment
       LEFT JOIN commerce.current_prices cp
         ON cp.product_id = p.id AND cp.environment = p.environment
      WHERE p.environment = $1 AND p.deleted_at IS NULL`,
    [env.FAREJADOR_ENV],
  );
  const stock = await dbPool.query<{
    measure: string; quantity_on_hand: number | string; unit_cost: number | string | null;
  }>(
    `SELECT measure, quantity_on_hand, unit_cost
       FROM commerce.wholesale_stock
      WHERE environment = $1`,
    [env.FAREJADOR_ENV],
  );
  const stockIndex = buildMatrizStockIndex(stock.rows);
  return catalog.rows.map((product) => {
    const official = matrizStockForMeasure(stockIndex, product.tire_size);
    return {
      ...product,
      total_stock_available: official.sellable ? official.quantity_on_hand : 0,
      official_quantity_on_hand: official.quantity_on_hand,
      official_unit_cost: official.unit_cost,
      stock_source: 'commerce.wholesale_stock',
      walkin_sellable: official.sellable,
      walkin_block_reason: official.block_reason,
    };
  }).sort((a, b) => {
    if (a.walkin_sellable !== b.walkin_sellable) return a.walkin_sellable ? -1 : 1;
    if (a.total_stock_available !== b.total_stock_available) {
      return b.total_stock_available - a.total_stock_available;
    }
    const priceA = a.price_amount === null ? Number.POSITIVE_INFINITY : Number(a.price_amount);
    const priceB = b.price_amount === null ? Number.POSITIVE_INFINITY : Number(b.price_amount);
    return priceA - priceB || a.product_name.localeCompare(b.product_name, 'pt-BR');
  }).slice(0, clampLimit(limit));
}

export type PainelRedePeriod = 'today' | '7d' | '30d' | 'month';

/**
 * Timezone usado para janelas operacionais "Hoje/7d/30d/Mês" da matriz.
 * Hard-coded em America/Sao_Paulo porque a rede 2W opera no Brasil.
 * Quando precisar suportar parceiros em outros fusos, vira parametro por unidade.
 */
export const PAINEL_TZ = 'America/Sao_Paulo';

/**
 * Calcula o inicio da janela do periodo NO BANCO usando AT TIME ZONE.
 *
 * Bug pre-correcao (S1 da auditoria 2026-05-21):
 *   resolveRedePeriodStart usava `new Date(now.getFullYear()...)` que pega
 *   o local time do processo Node. Em servidor UTC (Coolify default),
 *   o "hoje" cortava 3h antes do "hoje" do Brasil (BRT/UTC-3): apos 21h
 *   em SP, o filtro `today` ja virava o dia seguinte e mostrava 0.
 *
 * Correcao: gera expressao SQL que computa o inicio no fuso do Brasil,
 * passada como parametro $2 (timestamptz). Postgres faz a aritmetica.
 */
export function resolveRedePeriodStartSql(period: PainelRedePeriod): string {
  // Expressao entre parenteses pra evitar conflito de precedencia com
  // casts (::date, ::timestamptz) na interpolacao downstream.
  if (period === 'today') {
    return `(date_trunc('day', now() AT TIME ZONE '${PAINEL_TZ}') AT TIME ZONE '${PAINEL_TZ}')`;
  }
  if (period === '7d') {
    return `((date_trunc('day', now() AT TIME ZONE '${PAINEL_TZ}') - INTERVAL '6 days') AT TIME ZONE '${PAINEL_TZ}')`;
  }
  if (period === '30d') {
    return `((date_trunc('day', now() AT TIME ZONE '${PAINEL_TZ}') - INTERVAL '29 days') AT TIME ZONE '${PAINEL_TZ}')`;
  }
  return `(date_trunc('month', now() AT TIME ZONE '${PAINEL_TZ}') AT TIME ZONE '${PAINEL_TZ}')`;
}
