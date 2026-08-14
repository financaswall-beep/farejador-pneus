import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { simpleFinanceRangeDays, type SimpleFinanceRange } from '../../shared/simple-finance.js';
import type {
  OperationFinanceEntriesPayload,
  OperationFinanceEntry,
  OperationFinanceEntryKind,
} from '../../shared/finance-entries.js';
import { ensureMatrizFinanceAvailable } from './simple-finance.js';

interface MatrizFinanceOutputRow {
  id: string;
  source_type: string;
  description: string;
  payment_method: string | null;
  amount: string;
  entry_date: string;
  occurred_at: string;
  total_amount: string;
  total_count: number;
}

function describe(sourceType: string): { kind: OperationFinanceEntryKind; origin: string } {
  if (sourceType.startsWith('commerce.wholesale_purchase')) {
    return { kind: 'purchase', origin: 'Compra de estoque' };
  }
  if (sourceType.startsWith('commerce.matriz_expense')) {
    return { kind: 'expense', origin: 'Despesa da Matriz' };
  }
  if (sourceType.startsWith('network.commission')) {
    return { kind: 'payable', origin: 'Comissão da rede' };
  }
  if (sourceType.startsWith('marketing.')) return { kind: 'expense', origin: 'Marketing' };
  return { kind: 'other', origin: 'Saída financeira' };
}

export async function getMatrizFinanceOutputs(
  range: SimpleFinanceRange,
  dbPool: Pool = defaultPool,
): Promise<OperationFinanceEntriesPayload> {
  await ensureMatrizFinanceAvailable(dbPool);
  const days = simpleFinanceRangeDays(range);
  const result = await dbPool.query<MatrizFinanceOutputRow>(
    `WITH bounds AS (
       SELECT ((now() AT TIME ZONE 'America/Sao_Paulo')::date-($2::int-1)) start_date,
              ((now() AT TIME ZONE 'America/Sao_Paulo')::date+1) end_date
     ), outputs AS (
       SELECT t.id::text,t.source_type,t.description,
              COALESCE(t.metadata->>'payment_method',t.metadata->>'paymentMethod') payment_method,
              e.amount,to_char(t.cash_on,'YYYY-MM-DD') entry_date,t.created_at occurred_at
         FROM finance.matriz_ledger_transactions t
         JOIN finance.matriz_ledger_entries e
           ON e.environment=t.environment AND e.transaction_id=t.id
         CROSS JOIN bounds b
        WHERE t.environment=$1 AND t.cash_on>=b.start_date AND t.cash_on<b.end_date
          AND e.account_code='cash' AND e.side='credit'
          AND NOT EXISTS (SELECT 1 FROM finance.matriz_ledger_transactions reversal
            WHERE reversal.environment=t.environment
              AND reversal.reversal_of_transaction_id=t.id)
     ), counted AS (
       SELECT *,sum(amount) OVER()::text total_amount,count(*) OVER()::int total_count
         FROM outputs
     )
     SELECT * FROM counted ORDER BY entry_date DESC,occurred_at DESC,id DESC LIMIT 200`,
    [env.FAREJADOR_ENV, days],
  );
  const rows: OperationFinanceEntry[] = result.rows.map((row) => {
    const details = describe(row.source_type);
    return {
      id: row.id,
      kind: details.kind,
      title: row.description || details.origin,
      subtitle: details.origin,
      origin: details.origin,
      payment_method: row.payment_method,
      amount: Number(row.amount),
      entry_date: row.entry_date,
      occurred_at: row.occurred_at,
    };
  });
  return {
    range,
    total: Number(result.rows[0]?.total_amount ?? 0),
    count: Number(result.rows[0]?.total_count ?? 0),
    visible_count: rows.length,
    rows,
  };
}
