import type { PoolClient } from 'pg';

type Environment = 'prod' | 'test';

/** Mesma ordem do cancelamento: documento operacional, depois obrigação.
 * A consulta do saldo deve ser OUTRA instrução, executada após esta trava. */
export async function lockMatrizObligation(
  client: PoolClient, environment: Environment, obligationId: string,
): Promise<void> {
  const source = await client.query<{ source_type: string; source_id: string }>(
    `SELECT source_type,source_id FROM finance.matriz_ledger_transactions
      WHERE environment=$1 AND id=$2`, [environment, obligationId],
  );
  const row = source.rows[0];
  const table = row?.source_type === 'commerce.order.revenue' ? 'commerce.orders'
    : ['commerce.wholesale_order.revenue', 'commerce.wholesale_order.arrival_revenue']
      .includes(row?.source_type ?? '') ? 'commerce.wholesale_orders'
    : row?.source_type === 'commerce.wholesale_purchase.accrual'
      ? 'commerce.wholesale_purchases' : null;
  if (table) {
    await client.query(`SELECT id FROM ${table}
      WHERE environment=$1 AND id=$2::uuid FOR UPDATE`, [environment, row!.source_id]);
  }
  await client.query(`SELECT id FROM finance.matriz_ledger_transactions
    WHERE environment=$1 AND id=$2 FOR UPDATE`, [environment, obligationId]);
}

export interface MatrizObligationBreakdown {
  amount: string;
  cash_paid: string;
  written_off: string;
  adjusted: string;
  open_amount: string;
  reversed: boolean;
}

export async function lockMatrizObligationBreakdown(
  client: PoolClient, environment: Environment, obligationId: string,
): Promise<MatrizObligationBreakdown> {
  await lockMatrizObligation(client, environment, obligationId);
  const result = await client.query<MatrizObligationBreakdown>(
    `SELECT * FROM finance.matriz_ledger_obligation_breakdown($1::env_t,$2)`,
    [environment, obligationId],
  );
  if (!result.rows[0]) throw new Error('matriz_ledger_obligation_not_found');
  return result.rows[0];
}
