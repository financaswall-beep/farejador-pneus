// Obra 300 (2026-07-05): fatia do banco da MATRIZ — fornecedores + compras do galpão (registerWholesalePurchase).
// VERBATIM das linhas 1448-1682 do queries.ts pré-obra (commit 2628748).
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
import { addWholesaleStockEntry } from './queries-galpao.js';

export interface WholesaleSupplierRow {
  id: string;
  name: string;
  phone: string | null;
  notes: string | null;
}

/** Lista fornecedores ativos (formulário de compra + gestão), por nome. */
export async function listWholesaleSuppliers(
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<WholesaleSupplierRow[]> {
  const r = await dbPool.query<WholesaleSupplierRow>(
    `SELECT id, name, phone, notes
       FROM commerce.wholesale_suppliers
      WHERE environment = $1 AND deleted_at IS NULL
      ORDER BY name`,
    [environment],
  );
  return r.rows;
}

/** Cria a ficha de um fornecedor (nome obrigatório; telefone normalizado se vier). */
export async function registerWholesaleSupplier(
  input: { name: string; phone?: string | null; notes?: string | null; environment?: 'prod' | 'test' },
  dbPool: Pool = defaultPool,
): Promise<WholesaleSupplierRow> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const name = input.name.trim();
  if (!name) throw new Error('name_required');
  const r = await dbPool.query<WholesaleSupplierRow>(
    `INSERT INTO commerce.wholesale_suppliers (environment, name, phone, notes)
     VALUES ($1, $2, $3, $4) RETURNING id, name, phone, notes`,
    [environment, name, input.phone ? normalizeBrazilianPhone(input.phone) : null, input.notes?.trim() || null],
  );
  return r.rows[0]!;
}

/** Ranking de fornecedor (quanto comprei de cada, última compra, dias parado).
 *  Inclui quem está cadastrado mas nunca comprou (days_since_last NULL). */
export async function getWholesaleSupplierRanking(
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<unknown[]> {
  const r = await dbPool.query(
    `SELECT supplier_id, name, phone, purchases_count, total_spent, last_purchase_at, days_since_last
       FROM commerce.wholesale_supplier_summary
      WHERE environment = $1
      ORDER BY total_spent DESC, last_purchase_at DESC NULLS LAST, name`,
    [environment],
  );
  return r.rows;
}

/** Quebra fornecedor × medida: quanto comprei de cada medida de cada fornecedor e o
 *  custo MÉDIO PONDERADO (sum(line_total)/sum(quantity)). Base dos insights "quem vende
 *  a medida X mais barato" (#1) e "especialidade do fornecedor" (#2). Read-only, lê só
 *  das compras confirmadas. Dado SÓ da matriz. Ordena por medida e, dentro dela, do
 *  mais barato pro mais caro (o front marca o 1º como "mais barato"). */
export async function getWholesaleSupplierMeasureBreakdown(
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<unknown[]> {
  const r = await dbPool.query(
    `SELECT
        s.id                                                       AS supplier_id,
        s.name                                                     AS supplier_name,
        pi.measure                                                 AS measure,
        SUM(pi.quantity)                                           AS qty_total,
        ROUND(SUM(pi.line_total) / NULLIF(SUM(pi.quantity), 0), 2) AS avg_cost,
        MAX(p.purchased_at)                                        AS last_purchased_at
       FROM commerce.wholesale_purchase_items pi
       JOIN commerce.wholesale_purchases p
         ON p.id = pi.purchase_id AND p.environment = pi.environment
       JOIN commerce.wholesale_suppliers s
         ON s.id = p.supplier_id AND s.environment = p.environment
      WHERE pi.environment = $1
        AND p.status = 'confirmed'
        AND s.deleted_at IS NULL
      GROUP BY s.id, s.name, pi.measure
      ORDER BY pi.measure ASC, avg_cost ASC, qty_total DESC`,
    [environment],
  );
  return r.rows;
}

export interface RegisterWholesalePurchaseInput {
  environment?: 'prod' | 'test';
  supplier_id?: string | null;                                  // ficha existente
  new_supplier?: { name: string; phone?: string | null } | null; // fornecedor novo
  items: Array<{ measure: string; brand?: string | null; quantity: number; unit_cost: number }>;
  purchased_at?: string | null;
  notes?: string | null;
  created_by: string;
  // FINANCEIRO (0115, flag WHOLESALE_FINANCE): 'pending' = compra fiada (A PAGAR ao
  // fornecedor — porta que a 0114 deixou aberta). Ignorado com a flag off (nasce 'paid').
  payment_status?: 'paid' | 'pending';
  due_date?: string | null;
}

export interface RegisterWholesalePurchaseResult {
  purchase_id: string;
  supplier_id: string;
  supplier_name: string;
  total_amount: string;
  items_count: number;
}

/** Registra uma COMPRA (entrada de pneu no galpão). Transacional: resolve/cria o
 *  fornecedor → cabeçalho → pra cada item ALIMENTA o custo médio do galpão
 *  (addWholesaleStockEntry, mesma transação — atômico) e grava o item com a medida
 *  CANÔNICA (a que o galpão guardou) → grava o total. Custo médio do galpão (0111/0112)
 *  fica intocado na lógica; só recebe a entrada. Medida fora do catálogo → rollback. */
export async function registerWholesalePurchase(
  input: RegisterWholesalePurchaseInput,
  dbPool: Pool = defaultPool,
): Promise<RegisterWholesalePurchaseResult> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  if (!input.items || input.items.length === 0) throw new Error('items_required');

  const client: PoolClient = await dbPool.connect();
  try {
    await client.query('BEGIN');

    // 1. Resolve o fornecedor (ficha existente OU cadastro novo).
    let supplierId: string;
    let supplierName: string;
    if (input.supplier_id) {
      const r = await client.query<{ id: string; name: string }>(
        `SELECT id, name FROM commerce.wholesale_suppliers
          WHERE id = $1 AND environment = $2 AND deleted_at IS NULL`,
        [input.supplier_id, environment],
      );
      if (!r.rows[0]) throw new Error('supplier_not_found');
      supplierId = r.rows[0].id;
      supplierName = r.rows[0].name;
    } else if (input.new_supplier && input.new_supplier.name.trim()) {
      const ins = await client.query<{ id: string; name: string }>(
        `INSERT INTO commerce.wholesale_suppliers (environment, name, phone)
         VALUES ($1, $2, $3) RETURNING id, name`,
        [environment, input.new_supplier.name.trim(),
         input.new_supplier.phone ? normalizeBrazilianPhone(input.new_supplier.phone) : null],
      );
      supplierId = ins.rows[0]!.id;
      supplierName = ins.rows[0]!.name;
    } else {
      throw new Error('supplier_required');
    }

    // 2. Cabeçalho da compra (total 0 — preenchido no passo 4). FINANCEIRO (0115):
    //    com a flag on, a compra pode nascer 'pending' (fiado → A PAGAR ao fornecedor);
    //    flag off = 'paid' sem paid_at, byte a byte o de antes (default da 0114).
    const fiado = env.WHOLESALE_FINANCE && input.payment_status === 'pending';
    const paymentStatus = fiado ? 'pending' : 'paid';
    const paidAt = env.WHOLESALE_FINANCE && !fiado ? new Date().toISOString() : null;
    const dueDate = fiado ? (input.due_date ?? null) : null;
    const pur = await client.query<{ id: string }>(
      `INSERT INTO commerce.wholesale_purchases (environment, supplier_id, purchased_at, total_amount, created_by, notes, payment_status, due_date, paid_at)
       VALUES ($1, $2, COALESCE($3::timestamptz, now()), 0, $4, $5, $6, $7::date, $8::timestamptz) RETURNING id`,
      [environment, supplierId, input.purchased_at ?? null, input.created_by, input.notes ?? null, paymentStatus, dueDate, paidAt],
    );
    const purchaseId = pur.rows[0]!.id;

    // 3. Itens: cada um ALIMENTA o custo médio do galpão (mesma transação) e é gravado
    //    com a medida CANÔNICA que o galpão guardou (item e estoque nunca divergem).
    for (const it of input.items) {
      const stockRow = await addWholesaleStockEntry(
        { measure: it.measure, quantity_in: it.quantity, unit_cost: it.unit_cost, environment },
        client,
      );
      await client.query(
        `INSERT INTO commerce.wholesale_purchase_items (environment, purchase_id, measure, brand, quantity, unit_cost)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [environment, purchaseId, stockRow.measure, it.brand ?? null, it.quantity, it.unit_cost],
      );
    }

    // 4. Grava o total (passo SEPARADO — enxerga os itens recém-inseridos).
    const tot = await client.query<{ total_amount: string }>(
      `UPDATE commerce.wholesale_purchases
          SET total_amount = COALESCE(
            (SELECT sum(line_total) FROM commerce.wholesale_purchase_items WHERE purchase_id = $1), 0)
        WHERE id = $1 RETURNING total_amount`,
      [purchaseId],
    );

    await client.query('COMMIT');
    return {
      purchase_id: purchaseId,
      supplier_id: supplierId,
      supplier_name: supplierName,
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

export interface WholesalePurchaseRow {
  id: string;
  supplier_name: string;
  purchased_at: string;
  total_amount: string;
  items_count: number;
  payment_status: string;
  due_date: string | null;
  status: string;
  cancelled_at: string | null;
}

/** Últimas compras (vivas E canceladas — a trilha fica visível, espelho da lista de
 *  vendas 0116), mais recente primeiro. É a lista de onde o dono confere o que
 *  registrou e cancela um registro errado (0127). */
export async function listWholesalePurchases(
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
  limit = 15,
): Promise<WholesalePurchaseRow[]> {
  const r = await dbPool.query<WholesalePurchaseRow>(
    `SELECT p.id, s.name AS supplier_name, p.purchased_at, p.total_amount,
            (SELECT COALESCE(sum(i.quantity), 0) FROM commerce.wholesale_purchase_items i WHERE i.purchase_id = p.id)::int AS items_count,
            p.payment_status, p.due_date, p.status, p.cancelled_at
       FROM commerce.wholesale_purchases p
       JOIN commerce.wholesale_suppliers s ON s.id = p.supplier_id AND s.environment = p.environment
      WHERE p.environment = $1
      ORDER BY p.purchased_at DESC
      LIMIT $2`,
    [environment, limit],
  );
  return r.rows;
}

// ─── ATACADO — FINANCEIRO (0115): o FIADO dos dois lados do galpão ────────────
// A RECEBER = venda de atacado 'pending' (borracheiro levou e acerta depois).
// A PAGAR = compra de fornecedor 'pending' (porta aberta na 0114). Vencido =
// pending com due_date < hoje. Dado SÓ da matriz (regra de ouro — zero grant
// pro parceiro); atrás da flag WHOLESALE_FINANCE (a rota devolve enabled:false).

