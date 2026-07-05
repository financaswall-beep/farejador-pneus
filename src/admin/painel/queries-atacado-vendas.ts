// Obra 300 (2026-07-05): fatia do banco da MATRIZ — venda de atacado: compradores, ranking, registerWholesaleSale.
// VERBATIM das linhas 983-1224 do queries.ts pré-obra (commit 2628748).
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

export interface WholesaleBuyerRow {
  customer_id: string | null; // ficha já existente (null = parceiro ainda sem ficha)
  partner_id: string | null;  // se é parceiro da rede
  name: string;
  phone: string | null;
  is_partner: boolean;
}

/** Compradores selecionáveis no formulário "Nova venda de atacado": fichas já
 *  criadas + parceiros ativos que ainda não têm ficha (aparecem automático — sacada
 *  do dono: cadastrou parceiro → já dá pra vender pra ele no atacado). */
export async function listWholesaleBuyers(
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<WholesaleBuyerRow[]> {
  const r = await dbPool.query<WholesaleBuyerRow>(
    `SELECT id AS customer_id, partner_id, name, phone, (partner_id IS NOT NULL) AS is_partner
       FROM commerce.wholesale_customers
      WHERE environment = $1 AND deleted_at IS NULL
     UNION ALL
     SELECT NULL::uuid AS customer_id, p.id AS partner_id, p.trade_name AS name,
            p.whatsapp_phone AS phone, true AS is_partner
       FROM network.partners p
      WHERE p.environment = $1 AND p.deleted_at IS NULL AND p.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM commerce.wholesale_customers wc
           WHERE wc.environment = p.environment AND wc.partner_id = p.id AND wc.deleted_at IS NULL)
     ORDER BY name`,
    [environment],
  );
  return r.rows;
}

/** Ranking de recompra: quem compra mais, quanto, última compra, dias parado.
 *  Inclui parceiros que NUNCA compraram (zerados) pra o dono ver quem está na rede
 *  mas não recompra. O alerta "sumiu"/"nunca comprou" é renderizado no app. */
export async function getWholesaleRanking(
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<unknown[]> {
  const r = await dbPool.query(
    `SELECT buyer_id, partner_id, name, phone, is_partner,
            orders_count, total_bought, last_purchase_at, days_since_last
       FROM commerce.wholesale_buyer_summary
      WHERE environment = $1
     UNION ALL
     SELECT NULL::uuid, p.id, p.trade_name, p.whatsapp_phone, true,
            0, 0::numeric, NULL::timestamptz, NULL::int
       FROM network.partners p
      WHERE p.environment = $1 AND p.deleted_at IS NULL AND p.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM commerce.wholesale_customers wc
           WHERE wc.environment = p.environment AND wc.partner_id = p.id AND wc.deleted_at IS NULL)
     ORDER BY total_bought DESC, last_purchase_at DESC NULLS LAST, name`,
    [environment],
  );
  return r.rows;
}

export interface RegisterWholesaleSaleInput {
  environment?: 'prod' | 'test';
  customer_id?: string | null;     // ficha existente
  partner_id?: string | null;      // parceiro da rede (acha/cria a ficha)
  new_customer?: { name: string; phone?: string | null } | null; // só-atacado novo
  items: Array<{ measure: string; brand?: string | null; quantity: number; unit_price: number }>;
  sold_at?: string | null;
  notes?: string | null;
  created_by: string;
  allow_oversell?: boolean; // caixa confirmou vender acima do estoque (avisar+confirmar)
  // FINANCEIRO (0115, flag WHOLESALE_FINANCE): 'pending' = fiado (A RECEBER do
  // borracheiro), com vencimento opcional. Ignorado com a flag off (nasce 'paid').
  payment_status?: 'paid' | 'pending';
  due_date?: string | null;
}

export interface RegisterWholesaleSaleResult {
  order_id: string;
  buyer_id: string;
  buyer_name: string;
  total_amount: string;
  items_count: number;
}

/** Registra uma venda de atacado (comprador + pneus + preço digitado). Transacional:
 *  resolve/cria a ficha do comprador → cria a venda → itens → grava o total (passo
 *  SEPARADO, não CTE — pra o UPDATE enxergar os itens recém-inseridos). */
export async function registerWholesaleSale(
  input: RegisterWholesaleSaleInput,
  dbPool: Pool = defaultPool,
): Promise<RegisterWholesaleSaleResult> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  if (!input.items || input.items.length === 0) throw new Error('items_required');

  const client: PoolClient = await dbPool.connect();
  try {
    await client.query('BEGIN');

    // 1. Resolve o comprador (buyer_id) + nome pra devolver.
    let buyerId: string;
    let buyerName: string;
    if (input.customer_id) {
      const r = await client.query<{ id: string; name: string }>(
        `SELECT id, name FROM commerce.wholesale_customers
          WHERE id = $1 AND environment = $2 AND deleted_at IS NULL`,
        [input.customer_id, environment],
      );
      if (!r.rows[0]) throw new Error('buyer_not_found');
      buyerId = r.rows[0].id;
      buyerName = r.rows[0].name;
    } else if (input.partner_id) {
      // Parceiro: acha a ficha; se não tem, cria (espelha trade_name/whatsapp).
      const found = await client.query<{ id: string; name: string }>(
        `SELECT id, name FROM commerce.wholesale_customers
          WHERE environment = $1 AND partner_id = $2 AND deleted_at IS NULL`,
        [environment, input.partner_id],
      );
      if (found.rows[0]) {
        buyerId = found.rows[0].id;
        buyerName = found.rows[0].name;
      } else {
        const p = await client.query<{ trade_name: string; whatsapp_phone: string | null }>(
          `SELECT trade_name, whatsapp_phone FROM network.partners
            WHERE id = $1 AND environment = $2 AND deleted_at IS NULL`,
          [input.partner_id, environment],
        );
        if (!p.rows[0]) throw new Error('partner_not_found');
        const ins = await client.query<{ id: string; name: string }>(
          `INSERT INTO commerce.wholesale_customers (environment, partner_id, name, phone)
           VALUES ($1, $2, $3, $4) RETURNING id, name`,
          [environment, input.partner_id, p.rows[0].trade_name, p.rows[0].whatsapp_phone],
        );
        buyerId = ins.rows[0]!.id;
        buyerName = ins.rows[0]!.name;
      }
    } else if (input.new_customer && input.new_customer.name.trim()) {
      const ins = await client.query<{ id: string; name: string }>(
        `INSERT INTO commerce.wholesale_customers (environment, name, phone)
         VALUES ($1, $2, $3) RETURNING id, name`,
        [
          environment,
          input.new_customer.name.trim(),
          input.new_customer.phone ? normalizeBrazilianPhone(input.new_customer.phone) : null,
        ],
      );
      buyerId = ins.rows[0]!.id;
      buyerName = ins.rows[0]!.name;
    } else {
      throw new Error('buyer_required');
    }

    // 2. Cabeçalho da venda. FINANCEIRO (0115): com a flag on, a venda pode nascer
    //    'pending' (fiado → A RECEBER); flag off = 'paid' sem paid_at, byte a byte
    //    o de antes (mesmo resultado do default da coluna).
    const fiado = env.WHOLESALE_FINANCE && input.payment_status === 'pending';
    const paymentStatus = fiado ? 'pending' : 'paid';
    const paidAt = env.WHOLESALE_FINANCE && !fiado ? new Date().toISOString() : null;
    const dueDate = fiado ? (input.due_date ?? null) : null;
    const ord = await client.query<{ id: string }>(
      `INSERT INTO commerce.wholesale_orders (environment, buyer_id, sold_at, total_amount, created_by, notes, payment_status, due_date, paid_at)
       VALUES ($1, $2, COALESCE($3::timestamptz, now()), 0, $4, $5, $6, $7::date, $8::timestamptz) RETURNING id`,
      [environment, buyerId, input.sold_at ?? null, input.created_by, input.notes ?? null, paymentStatus, dueDate, paidAt],
    );
    const orderId = ord.rows[0]!.id;

    // 3. Disponibilidade + custo (com LOCK). Agrega a qtd pedida por medida, lê o estoque
    //    com FOR UPDATE (trava a linha durante a venda — sem corrida de duas vendas no mesmo
    //    pneu) e congela o custo (snapshot Fase 3, buscado à parte pra não dar 42P08 no INSERT).
    const reqByMeasure = new Map<string, number>();
    for (const it of input.items) {
      const m = it.measure.trim();
      if (m) reqByMeasure.set(m, (reqByMeasure.get(m) ?? 0) + it.quantity);
    }
    const stockByMeasure = new Map<string, { onHand: number; cost: number }>();
    for (const m of reqByMeasure.keys()) {
      const s = await client.query<{ quantity_on_hand: string; unit_cost: string | null }>(
        `SELECT quantity_on_hand, unit_cost FROM commerce.wholesale_stock
          WHERE environment = $1 AND measure = $2 LIMIT 1 FOR UPDATE`,
        [environment, m],
      );
      stockByMeasure.set(m, {
        onHand: s.rows[0] ? Number(s.rows[0].quantity_on_hand) : 0,
        cost: s.rows[0]?.unit_cost != null ? Number(s.rows[0].unit_cost) : 0,
      });
    }

    // 3a. TRAVA DE OVERSELL: só quando a baixa está ligada (o estoque é fonte de verdade) e
    //     o caixa NÃO confirmou vender assim mesmo. Aborta com a lista de medidas que estouraram
    //     (a rota devolve 409 pro front avisar). Agregado por medida (2×30 fura um estoque de 40).
    if (env.WHOLESALE_STOCK_DECREMENT && !input.allow_oversell) {
      const short: Array<{ measure: string; available: number; requested: number }> = [];
      for (const [m, req] of reqByMeasure) {
        const onHand = stockByMeasure.get(m)?.onHand ?? 0;
        if (req > onHand) short.push({ measure: m, available: onHand, requested: req });
      }
      if (short.length > 0) throw new Error('oversell:' + JSON.stringify(short));
    }

    // 3b. Itens (preço digitado; line_total/line_profit gerados pelo banco; custo congelado).
    for (const it of input.items) {
      const m = it.measure.trim();
      const unitCost = stockByMeasure.get(m)?.cost ?? 0;
      await client.query(
        `INSERT INTO commerce.wholesale_order_items (environment, order_id, measure, brand, quantity, unit_price, unit_cost)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [environment, orderId, m, it.brand ?? null, it.quantity, it.unit_price, unitCost],
      );
    }

    // 3b. BAIXA no estoque do galpão por medida (Fase 2b) — atrás de flag, mesma transação.
    await applyWholesaleStockDecrement(client, environment, input.items, env.WHOLESALE_STOCK_DECREMENT);

    // 4. Grava o total (passo SEPARADO — enxerga os itens recém-inseridos).
    const tot = await client.query<{ total_amount: string }>(
      `UPDATE commerce.wholesale_orders
          SET total_amount = COALESCE(
            (SELECT sum(line_total) FROM commerce.wholesale_order_items WHERE order_id = $1), 0)
        WHERE id = $1 RETURNING total_amount`,
      [orderId],
    );

    await client.query('COMMIT');
    return {
      order_id: orderId,
      buyer_id: buyerId,
      buyer_name: buyerName,
      total_amount: tot.rows[0]!.total_amount,
      items_count: input.items.length,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─── ATACADO (Fase 2): estoque do galpão por MEDIDA (pneu usado) ──────────────
// O dono controla o galpão por medida simples (ex.: '90/90-18' = 15 un.), SEPARADO
// do estoque do varejo (commerce.stock_levels). Tabela commerce.wholesale_stock (0111),
// dado SÓ da matriz (sem grant pro parceiro). Leitura/escrita aqui; a BAIXA na venda
// é plugada em registerWholesaleSale atrás de flag (Fase 2b).

