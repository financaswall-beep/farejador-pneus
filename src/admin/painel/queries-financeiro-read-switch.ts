import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { getMatrizCentralLedgerFinancialTruth } from './matriz-ledger-financial-read.js';
import { getMatrizLedgerIntegrationHealth } from './matriz-ledger-integration-health.js';
import type { MatrizFinancialTruth } from './queries-financeiro-verdade.js';

export interface MatrizFinancialRead {
  source: 'central_ledger';
  integration_status: 'green' | 'yellow';
  truth: MatrizFinancialTruth;
}

export class MatrizCentralLedgerUnavailableError extends Error {
  constructor(
    public readonly reason: 'disabled' | 'integration_red' | 'integration_disabled',
  ) {
    super(`central_ledger_${reason}`);
    this.name = 'MatrizCentralLedgerUnavailableError';
  }
}

export async function getMatrizFinancialRead(
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
  selectedMonth?: string,
): Promise<MatrizFinancialRead> {
  if (!env.MATRIZ_CENTRAL_LEDGER || !env.MATRIZ_CENTRAL_LEDGER_READ) {
    throw new MatrizCentralLedgerUnavailableError('disabled');
  }
  const since = selectedMonth && /^\d{4}-(0[1-9]|1[0-2])$/.test(selectedMonth) ? `${selectedMonth}-01` : null;
  const [year, month] = selectedMonth?.split('-').map(Number) ?? [];
  const until = since ? new Date(Date.UTC(year!, month!, 0)) : null;
  const health = await getMatrizLedgerIntegrationHealth(environment, dbPool,
    since && until ? { since, until: until.toISOString().slice(0, 10) } : undefined);
  if (health.status === 'red' || health.status === 'disabled') {
    throw new MatrizCentralLedgerUnavailableError(`integration_${health.status}`);
  }
  return {
    source: 'central_ledger',
    integration_status: health.status,
    truth: await getMatrizCentralLedgerFinancialTruth(environment, dbPool, selectedMonth),
  };
}
