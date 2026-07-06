// Obra 300 (2026-07-05): fatia do banco da MATRIZ — últimas vendas do atacado + cancelar venda (0116).
// VERBATIM das linhas 1907-2005 do queries.ts pré-obra (commit 2628748).
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

export interface WholesaleSaleRow {
  id: string;
  buyer_name: string;
  /** Telefone do borracheiro (2026-07-06): alimenta o RECIBO via wa.me. NULL = sem botão. */
  buyer_phone: string | null;
  sold_at: string;
  total_amount: string;
  payment_status: string;
  due_date: string | null;
  status: string;
  items_count: number;
  /** Itens da venda (2026-07-06): o corpo do recibo — medida × qtd × preço. */
  items: Array<{ measure: string; quantity: number; unit_price: string }>;
}

/** Últimas vendas de atacado (vivas E canceladas — a trilha fica visível), mais
 *  recente primeiro. É a lista de onde o dono cancela um registro errado e tira
 *  o RECIBO pro WhatsApp do borracheiro (por isso telefone + itens). */
export async function listWholesaleSales(
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
  limit = 15,
): Promise<WholesaleSaleRow[]> {
  const r = await dbPool.query<WholesaleSaleRow>(
    `SELECT o.id, c.name AS buyer_name, c.phone AS buyer_phone, o.sold_at, o.total_amount,
            o.payment_status, o.due_date, o.status,
            (SELECT count(*) FROM commerce.wholesale_order_items i WHERE i.order_id = o.id)::int AS items_count,
            COALESCE((SELECT json_agg(json_build_object(
                        'measure', i.measure, 'quantity', i.quantity, 'unit_price', i.unit_price)
                      ORDER BY i.measure)
                        FROM commerce.wholesale_order_items i WHERE i.order_id = o.id), '[]'::json) AS items
       FROM commerce.wholesale_orders o
       JOIN commerce.wholesale_customers c ON c.id = o.buyer_id AND c.environment = o.environment
      WHERE o.environment = $1
      ORDER BY o.sold_at DESC
      LIMIT $2`,
    [environment, limit],
  );
  return r.rows;
}

export interface CancelWholesaleSaleInput {
  order_id: string;
  cancelled_by: string;
  reason?: string | null;
  environment?: 'prod' | 'test';
}

/** CANCELA uma venda de atacado (confirmed → cancelled, sem apagar). Transacional:
 *  trava a venda (FOR UPDATE), grava a trilha (0116) e DEVOLVE o estoque ao galpão
 *  (espelho da baixa; só com WHOLESALE_STOCK_DECREMENT on — o mesmo interruptor que
 *  baixou). Cancelar 2x → sale_already_cancelled (a trilha original não é sobrescrita). */
export async function cancelWholesaleSale(
  input: CancelWholesaleSaleInput,
  dbPool: Pool = defaultPool,
): Promise<{ order_id: string; cancelled_at: string; payment_status: string }> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const client: PoolClient = await dbPool.connect();
  try {
    await client.query('BEGIN');

    const cur = await client.query<{ status: string; payment_status: string }>(
      `SELECT status, payment_status FROM commerce.wholesale_orders
        WHERE id = $1 AND environment = $2 LIMIT 1 FOR UPDATE`,
      [input.order_id, environment],
    );
    if (!cur.rows[0]) throw new Error('sale_not_found');
    if (cur.rows[0].status !== 'confirmed') throw new Error('sale_already_cancelled');

    const upd = await client.query<{ cancelled_at: string }>(
      `UPDATE commerce.wholesale_orders
          SET status = 'cancelled', cancelled_at = now(), cancelled_by = $3, cancel_reason = $4
        WHERE id = $1 AND environment = $2
        RETURNING cancelled_at`,
      [input.order_id, environment, input.cancelled_by, input.reason?.slice(0, 300) ?? null],
    );

    // Devolve os pneus ao galpão (espelho da baixa; mesma transação = atômico).
    const items = await client.query<{ measure: string; quantity: number }>(
      `SELECT measure, quantity FROM commerce.wholesale_order_items
        WHERE environment = $1 AND order_id = $2`,
      [environment, input.order_id],
    );
    await applyWholesaleStockReturn(client, environment, items.rows, env.WHOLESALE_STOCK_DECREMENT);

    await client.query('COMMIT');
    return {
      order_id: input.order_id,
      cancelled_at: upd.rows[0]!.cancelled_at,
      payment_status: cur.rows[0].payment_status,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─── REDE — COMISSÃO COMO LANÇAMENTO (0118, flag NETWORK_COMMISSION_LEDGER) ──────────
// Regras do dono (2026-07-02): nasce quando a venda REALIZA (MESMA régua 0077/0090 do
// getPainelRede — mudou lá, mude aqui); venda cancelada → estorna sozinho; % da FICHA
// congelado no lançamento; base = SÓ venda 2W (source_tag='2w') e SÓ os PNEUS — o FRETE
// fica FORA da base (decisão do dono 07-02: frete é serviço de entrega do parceiro;
// order_total no lançamento = a BASE, já sem frete). Preenchido por VARREDURA idempotente
// (sweep no GET da tela — sem gancho no fluxo do parceiro/bot; auto-corrige o que ficou
// pra trás). Dado SÓ da matriz: zero grant pro parceiro (0118).

