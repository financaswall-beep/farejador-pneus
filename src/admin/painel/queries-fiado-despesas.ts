// Obra 300 (2026-07-05): fatia do banco da MATRIZ — fiado do atacado (0115) + despesas da matriz (0120).
// VERBATIM das linhas 1683-1906 do queries.ts pré-obra (commit 2628748).
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
import { hasMatrizPayrollSchema } from './payroll-schema.js';

export interface WholesaleFinanceOpenRow {
  id: string;
  counterparty: string;      // borracheiro (a receber) ou fornecedor (a pagar)
  phone: string | null;      // deep-link "Cobrar no WhatsApp" da tela Financeiro
  total_amount: string;
  registered_at: string;     // sold_at / purchased_at
  due_date: string | null;
  overdue: boolean;
}

export interface WholesaleFinanceResumo {
  a_receber_total: string;
  a_receber_count: number;
  a_receber_vencidos: number;
  a_pagar_total: string;
  a_pagar_count: number;
  a_pagar_vencidos: number;
  receivables: WholesaleFinanceOpenRow[];
  payables: WholesaleFinanceOpenRow[];
}

/** Resumo do fiado do galpão: totais + as listas em aberto (vencidos primeiro). */
export async function getWholesaleFinance(
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<WholesaleFinanceResumo> {
  const rec = await dbPool.query<WholesaleFinanceOpenRow>(
    `SELECT o.id, c.name AS counterparty, c.phone, o.total_amount, o.sold_at AS registered_at,
            o.due_date, (o.due_date IS NOT NULL AND o.due_date < current_date) AS overdue
       FROM commerce.wholesale_orders o
       JOIN commerce.wholesale_customers c ON c.id = o.buyer_id AND c.environment = o.environment
      WHERE o.environment = $1 AND o.status = 'confirmed' AND o.payment_status = 'pending'
      ORDER BY (o.due_date IS NULL), o.due_date, o.sold_at`,
    [environment],
  );
  const pay = await dbPool.query<WholesaleFinanceOpenRow>(
    `SELECT p.id, s.name AS counterparty, s.phone, p.total_amount, p.purchased_at AS registered_at,
            p.due_date, (p.due_date IS NOT NULL AND p.due_date < current_date) AS overdue
       FROM commerce.wholesale_purchases p
       JOIN commerce.wholesale_suppliers s ON s.id = p.supplier_id AND s.environment = p.environment
      WHERE p.environment = $1 AND p.status = 'confirmed' AND p.payment_status = 'pending'
      ORDER BY (p.due_date IS NULL), p.due_date, p.purchased_at`,
    [environment],
  );
  const sum = (rows: WholesaleFinanceOpenRow[]) =>
    rows.reduce((acc, r) => acc + Number(r.total_amount), 0).toFixed(2);
  return {
    a_receber_total: sum(rec.rows),
    a_receber_count: rec.rows.length,
    a_receber_vencidos: rec.rows.filter((r) => r.overdue).length,
    a_pagar_total: sum(pay.rows),
    a_pagar_count: pay.rows.length,
    a_pagar_vencidos: pay.rows.filter((r) => r.overdue).length,
    receivables: rec.rows,
    payables: pay.rows,
  };
}

/** QUITA um fiado de venda (A RECEBER): pending → paid + paid_at. Idempotente-avesso:
 *  só quita quem está pending (quitar 2x → receivable_not_found, sem sobrescrever). */
export async function settleWholesaleOrderPayment(
  orderId: string,
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<{ id: string; paid_at: string }> {
  const r = await dbPool.query<{ id: string; paid_at: string }>(
    `UPDATE commerce.wholesale_orders
        SET payment_status = 'paid', paid_at = now()
      WHERE id = $1 AND environment = $2 AND status = 'confirmed' AND payment_status = 'pending'
      RETURNING id, paid_at`,
    [orderId, environment],
  );
  if (!r.rows[0]) throw new Error('receivable_not_found');
  return r.rows[0];
}

/** QUITA um fiado de compra (A PAGAR ao fornecedor): pending → paid + paid_at. */
export async function settleWholesalePurchasePayment(
  purchaseId: string,
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<{ id: string; paid_at: string }> {
  const r = await dbPool.query<{ id: string; paid_at: string }>(
    `UPDATE commerce.wholesale_purchases
        SET payment_status = 'paid', paid_at = now()
      WHERE id = $1 AND environment = $2 AND status = 'confirmed' AND payment_status = 'pending'
      RETURNING id, paid_at`,
    [purchaseId, environment],
  );
  if (!r.rows[0]) throw new Error('payable_not_found');
  return r.rows[0];
}

// ─── MATRIZ — DESPESAS GERAIS (0120, flag MATRIZ_EXPENSES): Fase A do livro-caixa ─────
// A única SAÍDA modelada da matriz era a compra de fornecedor (0114/0115); aluguel,
// funcionário, combustível e frete pago não existiam → o "saldo" mentia por omissão.
// Mesmo vocabulário do fiado 0115 (pending = a pagar; paid+paid_at = saiu do caixa) DE
// PROPÓSITO: o sweep do livro-razão (Fase B, 0121) lê despesa/venda/compra com a MESMA
// régua. Dado SÓ da matriz (zero grant — provado na 0120). Soft delete = trilha.

// As 6 de FÁBRICA (0120). Desde a 0130 a lista viva mora em
// commerce.matriz_expense_categories (o dono cadastra "Pedágio", "Alimentação"…);
// estas ficam como fallback fail-open da IA de comprovante e seed de referência.
export const MATRIZ_EXPENSE_CATEGORIES = [
  'aluguel', 'funcionario', 'combustivel', 'frete', 'manutencao', 'outros',
] as const;
export type MatrizExpenseCategory = string; // 0130: categoria é slug validado por FK + guard de ativa

export interface MatrizExpenseRow {
  id: string;
  category: string;
  description: string | null;
  amount: string;
  occurred_at: string;
  payment_status: 'paid' | 'pending';
  due_date: string | null;
  paid_at: string | null;
  overdue: boolean;
  payroll_item_id: string | null;
}

export interface MatrizExpensesFiltro {
  month?: string;    // 'YYYY-MM' — competência por occurred_at no fuso SP: a MESMA régua
                     // da perna "Despesas" do consolidado (as duas telas nunca discordam)
  category?: string; // slug da modalidade (0130)
  limit?: number;
}

export interface MatrizExpensesResumo {
  a_pagar_total: string;
  a_pagar_count: number;
  a_pagar_vencidos: number;
  pago_mes_total: string; // pagas no mês corrente (fuso São Paulo, mesmo recorte do varejo 0117)
  entries: MatrizExpenseRow[];
  // Soma/contagem do recorte pedido (mês × modalidade). null = chamada sem filtro (visão).
  periodo: { total: string; count: number; truncado: boolean } | null;
}

/** Resumo das despesas da matriz: a pagar (vencidos primeiro) + pago no mês + a lista.
 *  Com filtro (mês/modalidade) a lista vira EXTRATO DO PERÍODO (cronológico, novas
 *  primeiro) com soma própria — é o que mata a "lista infinita" da tela. */
export async function getMatrizExpenses(
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
  filtro?: MatrizExpensesFiltro,
): Promise<MatrizExpensesResumo> {
  const payrollReady = await hasMatrizPayrollSchema(dbPool);
  const where: string[] = ['environment = $1', 'deleted_at IS NULL'];
  const params: unknown[] = [environment];
  if (filtro?.month) {
    params.push(filtro.month);
    where.push(`date_trunc('month', occurred_at AT TIME ZONE 'America/Sao_Paulo') = to_date($${params.length}, 'YYYY-MM')`);
  }
  if (filtro?.category) {
    params.push(filtro.category);
    where.push(`category = $${params.length}`);
  }
  const temFiltro = Boolean(filtro?.month || filtro?.category);
  const limit = filtro?.limit ?? (temFiltro ? 200 : 50);
  // Extrato do período lê cronológico; sem filtro mantém a agenda (pendente primeiro).
  const orderBy = temFiltro
    ? `occurred_at DESC`
    : `(payment_status = 'pending') DESC, (due_date IS NULL), due_date, occurred_at DESC`;
  const payrollItemProjection = payrollReady
    ? `(SELECT i.id FROM finance.matriz_payroll_items i WHERE i.source_expense_id=matriz_expenses.id)`
    : `NULL::uuid`;
  const rows = await dbPool.query<MatrizExpenseRow>(
    `SELECT id, category, description, amount, occurred_at, payment_status, due_date, paid_at,
            ${payrollItemProjection} AS payroll_item_id,
            (payment_status = 'pending' AND due_date IS NOT NULL AND due_date < current_date) AS overdue
       FROM commerce.matriz_expenses
      WHERE ${where.join(' AND ')}
      ORDER BY ${orderBy}
      LIMIT $${params.length + 1}`,
    [...params, limit],
  );
  let periodo: MatrizExpensesResumo['periodo'] = null;
  if (temFiltro) {
    const p = await dbPool.query<{ total: string; count: number }>(
      `SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*)::int AS count
         FROM commerce.matriz_expenses
        WHERE ${where.join(' AND ')}`,
      params,
    );
    periodo = { total: p.rows[0]!.total, count: p.rows[0]!.count, truncado: p.rows[0]!.count > rows.rows.length };
  }
  const tot = await dbPool.query<{ a_pagar_total: string; a_pagar_count: number; a_pagar_vencidos: number; pago_mes_total: string }>(
    `SELECT COALESCE(SUM(amount) FILTER (WHERE payment_status = 'pending'), 0) AS a_pagar_total,
            COUNT(*) FILTER (WHERE payment_status = 'pending')::int AS a_pagar_count,
            COUNT(*) FILTER (WHERE payment_status = 'pending' AND due_date IS NOT NULL AND due_date < current_date)::int AS a_pagar_vencidos,
            COALESCE(SUM(amount) FILTER (WHERE payment_status = 'paid'
              AND (COALESCE(paid_at, occurred_at) AT TIME ZONE 'America/Sao_Paulo')
                    >= date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo')), 0) AS pago_mes_total
       FROM commerce.matriz_expenses
      WHERE environment = $1 AND deleted_at IS NULL`,
    [environment],
  );
  return { ...tot.rows[0]!, entries: rows.rows, periodo };
}

export interface CreateMatrizExpenseInput {
  category: string; // slug de modalidade ATIVA (0130) — inexistente/arquivada → 'category_invalid'
  description?: string | null;
  amount: number;
  payment_status?: 'paid' | 'pending'; // omitido = 'paid' (pago na hora)
  due_date?: string | null;            // só faz sentido no pending
  created_by?: string | null;
  environment?: 'prod' | 'test';
}

/** Lança uma despesa da matriz. À vista nasce paid+paid_at; a pagar nasce pending.
 *  0130: só entra em modalidade ATIVA — arquivada/inexistente → 'category_invalid'
 *  (o EXISTS barra arquivada; a FK barra corrida). Casts ::env_t explícitos porque
 *  $1 aparece 2x contra env_t (lição 42P08 da casa). */
export async function createMatrizExpense(
  input: CreateMatrizExpenseInput,
  dbPool: Pool = defaultPool,
): Promise<MatrizExpenseRow> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const paymentStatus = input.payment_status ?? 'paid';
  const r = await dbPool.query<MatrizExpenseRow>(
    `INSERT INTO commerce.matriz_expenses
       (environment, category, description, amount, payment_status, due_date, paid_at, created_by)
     SELECT $1::env_t, $2, $3, $4, $5, $6::date, CASE WHEN $5 = 'paid' THEN now() ELSE NULL END, $7
      WHERE EXISTS (SELECT 1 FROM commerce.matriz_expense_categories c
                     WHERE c.environment = $1::env_t AND c.slug = $2 AND c.archived_at IS NULL)
     RETURNING id, category, description, amount, occurred_at, payment_status, due_date, paid_at,
               NULL::uuid AS payroll_item_id,
               (payment_status = 'pending' AND due_date IS NOT NULL AND due_date < current_date) AS overdue`,
    [environment, input.category, input.description ?? null, input.amount,
     paymentStatus, paymentStatus === 'pending' ? (input.due_date ?? null) : null,
     input.created_by ?? null],
  );
  if (!r.rows[0]) throw new Error('category_invalid');
  return r.rows[0];
}

/** QUITA uma despesa a pagar: pending → paid + paid_at (espelho do settle 0115).
 *  Quitar 2x → expense_not_found (não sobrescreve o paid_at original). */
export async function settleMatrizExpense(
  expenseId: string,
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<{ id: string; paid_at: string }> {
  const r = await dbPool.query<{ id: string; paid_at: string }>(
    `UPDATE commerce.matriz_expenses
        SET payment_status = 'paid', paid_at = now()
      WHERE id = $1 AND environment = $2 AND payment_status = 'pending' AND deleted_at IS NULL
      RETURNING id, paid_at`,
    [expenseId, environment],
  );
  if (!r.rows[0]) throw new Error('expense_not_found');
  return r.rows[0];
}

/** REMOVE uma despesa lançada errada (soft delete — trilha preservada, nunca DELETE). */
export async function removeMatrizExpense(
  expenseId: string,
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<{ id: string }> {
  const r = await dbPool.query<{ id: string }>(
    `UPDATE commerce.matriz_expenses
        SET deleted_at = now()
      WHERE id = $1 AND environment = $2 AND deleted_at IS NULL
      RETURNING id`,
    [expenseId, environment],
  );
  if (!r.rows[0]) throw new Error('expense_not_found');
  return r.rows[0];
}

// ─── ATACADO — CANCELAR VENDA (0116) + listagem das últimas vendas ────────────
// O balcão não tinha como desfazer registro errado (o varejo tem; o atacado não).
// Cancelar corrige SOZINHO ranking/resumo/fiado (tudo filtra status='confirmed');
// o estoque é DEVOLVIDO por código (espelho da baixa, flag WHOLESALE_STOCK_DECREMENT).
