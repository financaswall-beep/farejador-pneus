import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';

type Environment = 'prod' | 'test';
export type MatrizLedgerStatementBasis = 'competencia' | 'caixa';

export interface MatrizLedgerStatementRow {
  id: string;
  source_type: string;
  source_id: string;
  transaction_kind: string;
  amount: string;
  competence_on: string;
  due_on: string | null;
  cash_on: string | null;
  description: string;
  created_by: string;
  created_at: string;
  metadata: Record<string, unknown>;
  reversal_of_transaction_id: string | null;
  reversed: boolean;
  paid_amount: string;
  open_amount: string | null;
  status: 'aberto' | 'parcial' | 'liquidado' | 'estornado' | 'estorno' | 'registrado';
  direction: 'entrada' | 'saida' | 'receita' | 'despesa' | 'estoque' | 'ajuste';
  origin: string;
  entries: Array<{
    account_code: string;
    account_class: string;
    side: 'debit' | 'credit';
    amount: string;
  }>;
}

export interface MatrizLedgerStatement {
  period: string;
  basis: MatrizLedgerStatementBasis;
  total: number;
  limit: number;
  offset: number;
  summary: {
    entradas: string;
    saidas: string;
    receitas: string;
    despesas: string;
  };
  rows: MatrizLedgerStatementRow[];
}

interface StatementDbRow extends Omit<MatrizLedgerStatementRow, 'status' | 'direction' | 'origin'> {
  total_count: number;
  has_cash_debit: boolean;
  has_cash_credit: boolean;
  has_revenue_credit: boolean;
  has_expense_debit: boolean;
  has_inventory: boolean;
}

const OBLIGATION_ACCOUNTS = [
  'accounts_receivable',
  'network_commission_receivable',
  'network_monthly_fee_receivable',
  'supplier_refund_receivable',
  'expense_refund_receivable',
  'accounts_payable',
  'commission_refund_payable',
  'customer_refund_payable',
  'marketing_payable',
];

function originOf(sourceType: string): string {
  if (sourceType.startsWith('commerce.wholesale_purchase')) return 'Compras';
  if (sourceType.startsWith('commerce.wholesale_order')) return 'Atacado';
  if (sourceType.startsWith('commerce.order')) return 'Varejo';
  if (sourceType.startsWith('commerce.matriz_expense')) return 'Despesas';
  if (sourceType.startsWith('network.commission')) return 'Rede · comissões';
  if (sourceType.startsWith('network.monthly_fee')) return 'Rede · mensalidades';
  if (sourceType.startsWith('marketing.')) return 'Marketing';
  if (sourceType.includes('inventory')) return 'Estoque';
  if (sourceType.startsWith('finance.')) return 'Financeiro';
  return sourceType.split('.').slice(0, 2).join(' · ');
}

function directionOf(row: StatementDbRow): MatrizLedgerStatementRow['direction'] {
  if (row.has_cash_debit) return 'entrada';
  if (row.has_cash_credit) return 'saida';
  if (row.has_revenue_credit) return 'receita';
  if (row.has_expense_debit) return 'despesa';
  if (row.has_inventory) return 'estoque';
  return 'ajuste';
}

function statusOf(row: StatementDbRow): MatrizLedgerStatementRow['status'] {
  if (row.reversal_of_transaction_id) return 'estorno';
  if (row.reversed) return 'estornado';
  if (row.open_amount !== null) {
    if (Number(row.open_amount) <= 0) return 'liquidado';
    if (Number(row.paid_amount) > 0) return 'parcial';
    return 'aberto';
  }
  return 'registrado';
}

export async function getMatrizLedgerStatement(
  input: {
    period: string;
    basis?: MatrizLedgerStatementBasis;
    limit?: number;
    offset?: number;
    environment?: Environment;
  },
  dbPool: Pool = defaultPool,
): Promise<MatrizLedgerStatement> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const basis = input.basis ?? 'competencia';
  const limit = input.limit ?? 100;
  const offset = input.offset ?? 0;
  const dateColumn = basis === 'caixa' ? 't.cash_on' : 't.competence_on';
  const params = [environment, input.period, OBLIGATION_ACCOUNTS, limit, offset];

  const [result, summary] = await Promise.all([
    dbPool.query<StatementDbRow>(
      `WITH bounds AS (
         SELECT to_date($2,'YYYY-MM') month_start,
                (to_date($2,'YYYY-MM')+interval '1 month')::date month_end
       ), selected AS (
         SELECT t.*,
                EXISTS (SELECT 1 FROM finance.matriz_ledger_transactions r
                  WHERE r.environment=t.environment
                    AND r.reversal_of_transaction_id=t.id) reversed,
                COALESCE((SELECT sum(CASE WHEN p.payment_kind='settlement'
                  THEN p.amount ELSE -p.amount END)
                  FROM finance.matriz_ledger_payments p
                 WHERE p.environment=t.environment
                   AND p.obligation_transaction_id=t.id),0)::numeric(14,2)::text paid_amount,
                (SELECT max(e.amount) FILTER (
                   WHERE e.account_code=ANY($3::text[])
                     AND ((e.account_class='asset' AND e.side='debit')
                       OR (e.account_class='liability' AND e.side='credit')))
                   FROM finance.matriz_ledger_entries e
                  WHERE e.environment=t.environment AND e.transaction_id=t.id)
                  ::numeric(14,2)::text obligation_amount
           FROM finance.matriz_ledger_transactions t,bounds b
          WHERE t.environment=$1
            AND ${dateColumn}>=b.month_start AND ${dateColumn}<b.month_end
       )
       SELECT s.id,s.source_type,s.source_id,s.transaction_kind,s.amount::text,
              s.competence_on::text,s.due_on::text,s.cash_on::text,s.description,
              s.created_by,s.created_at::text,s.metadata,s.reversal_of_transaction_id,
              s.reversed,s.paid_amount,
              CASE WHEN s.obligation_amount IS NULL THEN NULL
                ELSE GREATEST(s.obligation_amount::numeric-s.paid_amount::numeric,0)
                  ::numeric(14,2)::text END open_amount,
              bool_or(e.account_code='cash' AND e.side='debit') has_cash_debit,
              bool_or(e.account_code='cash' AND e.side='credit') has_cash_credit,
              bool_or(e.account_class='revenue' AND e.side='credit') has_revenue_credit,
              bool_or(e.account_class='expense' AND e.side='debit') has_expense_debit,
              bool_or(e.account_code IN ('inventory','inventory_in_transit',
                'inventory_gain','inventory_loss','inventory_internal_use')) has_inventory,
              jsonb_agg(jsonb_build_object(
                'account_code',e.account_code,'account_class',e.account_class,
                'side',e.side,'amount',e.amount::text
              ) ORDER BY e.line_no) entries,
              count(*) OVER()::int total_count
         FROM selected s
         JOIN finance.matriz_ledger_entries e
           ON e.environment=s.environment AND e.transaction_id=s.id
        GROUP BY s.id,s.source_type,s.source_id,s.transaction_kind,s.amount,
                 s.competence_on,s.due_on,s.cash_on,s.description,s.created_by,
                 s.created_at,s.metadata,s.reversal_of_transaction_id,s.reversed,
                 s.paid_amount,s.obligation_amount
        ORDER BY ${dateColumn.replace('t.', 's.')} DESC,s.created_at DESC,s.id DESC
        LIMIT $4 OFFSET $5`,
      params,
    ),
    dbPool.query<{
      entradas: string; saidas: string; receitas: string; despesas: string;
    }>(
      `WITH bounds AS (
         SELECT to_date($2,'YYYY-MM') month_start,
                (to_date($2,'YYYY-MM')+interval '1 month')::date month_end
       ), tx AS (
          SELECT t.id,t.reversal_of_transaction_id
            FROM finance.matriz_ledger_transactions t,bounds b
           WHERE t.environment=$1
             AND ${dateColumn}>=b.month_start AND ${dateColumn}<b.month_end
        )
       SELECT
         COALESCE(sum(e.amount) FILTER (WHERE e.account_code='cash'
           AND e.side='debit'),0)::numeric(14,2)::text entradas,
         COALESCE(sum(e.amount) FILTER (WHERE e.account_code='cash'
           AND e.side='credit'),0)::numeric(14,2)::text saidas,
         COALESCE(sum(CASE e.side WHEN 'credit' THEN e.amount ELSE -e.amount END)
           FILTER (WHERE e.account_class='revenue'),0)::numeric(14,2)::text receitas,
         COALESCE(sum(CASE e.side WHEN 'debit' THEN e.amount ELSE -e.amount END)
           FILTER (WHERE e.account_class='expense'),0)::numeric(14,2)::text despesas
         FROM tx
         JOIN finance.matriz_ledger_entries e ON e.environment=$1
          AND e.transaction_id=tx.id`,
      [environment, input.period],
    ),
  ]);

  const rows = result.rows.map((row) => {
    const { total_count: _totalCount, ...statementRow } = row;
    return {
      ...statementRow,
      status: statusOf(row),
      direction: directionOf(row),
      origin: originOf(row.source_type),
    };
  });
  return {
    period: input.period,
    basis,
    total: Number(result.rows[0]?.total_count ?? 0),
    limit,
    offset,
    summary: summary.rows[0]!,
    rows,
  };
}
