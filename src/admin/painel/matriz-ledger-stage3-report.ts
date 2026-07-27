import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';

type Environment = 'prod' | 'test';

export interface MatrizStage3Reconciliation {
  enabled: boolean;
  status: 'green' | 'red';
  missing: Record<string, number>;
  amount_mismatches: number;
  orphan_ledger: number;
  duplicate_sources: number;
  total_problems: number;
}

export async function getMatrizStage3LedgerReconciliation(
  environment: Environment = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<MatrizStage3Reconciliation> {
  const result = await dbPool.query<{
    missing: Record<string, number>; amount_mismatches: number;
    orphan_ledger: number; duplicate_sources: number;
  }>(
    `SELECT finance.matriz_stage3_ledger_reconciliation($1::env_t) AS missing,
            finance.matriz_stage3_ledger_amount_mismatches($1::env_t)::int amount_mismatches,
            finance.matriz_stage3_ledger_orphans($1::env_t)::int orphan_ledger,
            finance.matriz_stage3_ledger_duplicates($1::env_t)::int duplicate_sources`,
    [environment],
  );
  const row = result.rows[0]!;
  const missing = row.missing ?? {};
  const total = Object.values(missing).reduce((sum, value) => sum + Number(value), 0)
    + row.amount_mismatches + row.orphan_ledger + row.duplicate_sources;
  return {
    enabled: env.MATRIZ_CENTRAL_LEDGER, status: total === 0 ? 'green' : 'red',
    missing, amount_mismatches: row.amount_mismatches,
    orphan_ledger: row.orphan_ledger, duplicate_sources: row.duplicate_sources,
    total_problems: total,
  };
}
