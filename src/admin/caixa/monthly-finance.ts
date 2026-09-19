import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { getMatrizFinancialRead } from '../painel/queries-financeiro-read-switch.js';
import { getMatrizLedgerOpenItems } from '../painel/matriz-ledger-open-items.js';
import { getMatrizFinanceOverview } from '../painel/matriz-finance-overview.js';
import { getMatrizStockCapital } from '../painel/matriz-stock-capital.js';
import { logger } from '../../shared/logger.js';

/** Mesmo resultado, caixa, despesas e agenda usados pelo Financeiro web.
 * Não estima despesas ausentes nem transforma consumo do bot em lançamento. */
export async function getMatrizMonthlyFinance(period: string, dbPool: Pool = defaultPool) {
  const read = await getMatrizFinancialRead(env.FAREJADOR_ENV, dbPool, period);
  const [agenda, overview, inventory] = await Promise.all([
    getMatrizLedgerOpenItems(env.FAREJADOR_ENV, dbPool),
    getMatrizFinanceOverview(period, env.FAREJADOR_ENV, dbPool),
    getMatrizStockCapital(env.FAREJADOR_ENV, dbPool).catch(error => {
      logger.warn({ err: error }, 'finance inventory position unavailable');
      return null;
    }),
  ]);
  return { period, ...read, agenda, expenses: overview.expenses, inventory };
}
