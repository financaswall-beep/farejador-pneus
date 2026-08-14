import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { getMatrizLedgerOpenItems } from '../painel/matriz-ledger-open-items.js';
import { getMatrizLedgerIntegrationHealth } from '../painel/matriz-ledger-integration-health.js';
import { getMatrizCollaboratorManagement } from '../painel/queries-colaboradores-gestao.js';
import { MatrizCentralLedgerUnavailableError } from '../painel/queries-financeiro-read-switch.js';
import {
  simpleFinanceRangeDays,
  type SimpleFinancePayload,
  type SimpleFinanceRange,
} from '../../shared/simple-finance.js';

function saoPauloToday(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function shiftIsoDate(value: string, days: number): string {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day! + days));
  return date.toISOString().slice(0, 10);
}

async function getCashSummary(
  range: SimpleFinanceRange,
  environment: 'prod' | 'test',
  dbPool: Pool,
): Promise<{ entradas: string; saidas: string }> {
  const today = saoPauloToday();
  const start = shiftIsoDate(today, -(simpleFinanceRangeDays(range) - 1));
  const end = shiftIsoDate(today, 1);
  const result = await dbPool.query<{ entradas: string; saidas: string }>(
    `WITH tx AS (
       SELECT t.id
         FROM finance.matriz_ledger_transactions t
        WHERE t.environment=$1 AND t.cash_on>=$2::date AND t.cash_on<$3::date
          AND NOT EXISTS (SELECT 1 FROM finance.matriz_ledger_transactions r
            WHERE r.environment=t.environment AND r.reversal_of_transaction_id=t.id)
     )
     SELECT COALESCE(sum(e.amount) FILTER (
              WHERE e.account_code='cash' AND e.side='debit'),0)::numeric(14,2)::text entradas,
            COALESCE(sum(e.amount) FILTER (
              WHERE e.account_code='cash' AND e.side='credit'),0)::numeric(14,2)::text saidas
       FROM tx
       JOIN finance.matriz_ledger_entries e
         ON e.environment=$1 AND e.transaction_id=tx.id`,
    [environment, start, end],
  );
  return result.rows[0] ?? { entradas: '0', saidas: '0' };
}

export async function getMatrizSimpleFinance(
  range: SimpleFinanceRange,
  dbPool: Pool = defaultPool,
): Promise<SimpleFinancePayload> {
  if (!env.MATRIZ_CENTRAL_LEDGER || !env.MATRIZ_CENTRAL_LEDGER_READ) {
    throw new MatrizCentralLedgerUnavailableError('disabled');
  }
  const health = await getMatrizLedgerIntegrationHealth(env.FAREJADOR_ENV, dbPool);
  if (health.status === 'red' || health.status === 'disabled') {
    throw new MatrizCentralLedgerUnavailableError(`integration_${health.status}`);
  }

  const today = saoPauloToday();
  const period = today.slice(0, 7);
  const competence = `${period}-01`;
  const [summary, openItems, collaborators] = await Promise.all([
    getCashSummary(range, env.FAREJADOR_ENV, dbPool),
    getMatrizLedgerOpenItems(env.FAREJADOR_ENV, dbPool),
    getMatrizCollaboratorManagement(competence, env.FAREJADOR_ENV, dbPool),
  ]);
  const dueToday = openItems.a_pagar.itens.filter((item) => item.due_date === today);
  const cashIn = Number(summary.entradas ?? 0);
  const cashOut = Number(summary.saidas ?? 0);
  return {
    period,
    range,
    unit_name: 'Matriz',
    cash_in: cashIn,
    cash_out: cashOut,
    cash_net: Math.round((cashIn - cashOut) * 100) / 100,
    receivable_total: Number(openItems.a_receber.total ?? 0),
    receivable_count: openItems.a_receber.itens.length,
    due_today_total: dueToday.reduce((sum, item) => sum + Number(item.valor), 0),
    due_today_count: dueToday.length,
    commission_total: Number(collaborators.summary.commission_total ?? 0),
    commission_collaborators: collaborators.collaborators.filter(
      (item) => item.active && item.commission_active,
    ).length,
  };
}
