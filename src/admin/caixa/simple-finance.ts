import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { getMatrizLedgerOpenItems } from '../painel/matriz-ledger-open-items.js';
import { getMatrizLedgerStatement } from '../painel/matriz-ledger-statement.js';
import { getMatrizLedgerIntegrationHealth } from '../painel/matriz-ledger-integration-health.js';
import { getMatrizCollaboratorManagement } from '../painel/queries-colaboradores-gestao.js';
import { MatrizCentralLedgerUnavailableError } from '../painel/queries-financeiro-read-switch.js';
import type { SimpleFinancePayload } from '../../shared/simple-finance.js';

function saoPauloToday(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

export async function getMatrizSimpleFinance(
  period: string,
  dbPool: Pool = defaultPool,
): Promise<SimpleFinancePayload> {
  if (!env.MATRIZ_CENTRAL_LEDGER || !env.MATRIZ_CENTRAL_LEDGER_READ) {
    throw new MatrizCentralLedgerUnavailableError('disabled');
  }
  const health = await getMatrizLedgerIntegrationHealth(env.FAREJADOR_ENV, dbPool);
  if (health.status === 'red' || health.status === 'disabled') {
    throw new MatrizCentralLedgerUnavailableError(`integration_${health.status}`);
  }

  const competence = `${period}-01`;
  const [statement, openItems, collaborators] = await Promise.all([
    getMatrizLedgerStatement({
      period, basis: 'caixa', limit: 1, offset: 0, environment: env.FAREJADOR_ENV,
    }, dbPool),
    getMatrizLedgerOpenItems(env.FAREJADOR_ENV, dbPool),
    getMatrizCollaboratorManagement(competence, env.FAREJADOR_ENV, dbPool),
  ]);
  const today = saoPauloToday();
  const dueToday = openItems.a_pagar.itens.filter((item) => item.due_date === today);
  const cashIn = Number(statement.summary.entradas ?? 0);
  const cashOut = Number(statement.summary.saidas ?? 0);
  return {
    period,
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
