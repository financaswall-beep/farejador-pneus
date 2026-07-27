import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { getMatrizCentralLedgerFinancialTruth } from './matriz-ledger-financial-read.js';
import { getMatrizLedgerIntegrationHealth } from './matriz-ledger-integration-health.js';
import {
  getLegacyMatrizFinancialTruth, type MatrizFinancialTruth,
} from './queries-financeiro-verdade.js';

export interface MatrizFinancialRead {
  source: 'legacy' | 'central_ledger';
  requested_source: 'legacy' | 'central_ledger';
  fallback_reason: string | null;
  integration_status: 'disabled' | 'green' | 'yellow' | 'red' | null;
  truth: MatrizFinancialTruth;
  comparison: null | {
    matched: boolean;
    total_abs_difference: string;
    fields: Record<string, { legacy: string; central: string; difference: string }>;
  };
}

const cents = (value: string): number => Math.round(Number(value || 0) * 100);
const money = (value: number): string => (value / 100).toFixed(2);

function compareTruth(
  legacy: MatrizFinancialTruth,
  central: MatrizFinancialTruth,
): NonNullable<MatrizFinancialRead['comparison']> {
  const pairs: Record<string, [string, string]> = {
    receita: [legacy.competencia.receita_total, central.competencia.receita_total],
    custo: [legacy.competencia.custo_conhecido, central.competencia.custo_conhecido],
    despesas: [legacy.competencia.despesas, central.competencia.despesas],
    lucro: [legacy.competencia.lucro_confirmado, central.competencia.lucro_confirmado],
    entradas_caixa: [legacy.caixa.entradas_registradas, central.caixa.entradas_registradas],
    saidas_caixa: [legacy.caixa.saidas_registradas, central.caixa.saidas_registradas],
    a_receber: [legacy.posicao.a_receber, central.posicao.a_receber],
    a_pagar: [legacy.posicao.a_pagar, central.posicao.a_pagar],
  };
  let total = 0;
  const fields = Object.fromEntries(Object.entries(pairs).map(([name, values]) => {
    const difference = cents(values[1]) - cents(values[0]);
    total += Math.abs(difference);
    return [name, {
      legacy: values[0], central: values[1], difference: money(difference),
    }];
  }));
  return { matched: total === 0, total_abs_difference: money(total), fields };
}

export async function getMatrizFinancialRead(
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<MatrizFinancialRead> {
  if (!env.MATRIZ_CENTRAL_LEDGER_READ) return {
    source: 'legacy', requested_source: 'legacy', fallback_reason: null,
    integration_status: null,
    truth: await getLegacyMatrizFinancialTruth(environment, dbPool),
    comparison: null,
  };
  if (!env.MATRIZ_CENTRAL_LEDGER) return {
    source: 'legacy', requested_source: 'central_ledger',
    fallback_reason: 'central_ledger_disabled', integration_status: 'disabled',
    truth: await getLegacyMatrizFinancialTruth(environment, dbPool),
    comparison: null,
  };
  const health = await getMatrizLedgerIntegrationHealth(environment, dbPool);
  if (health.status === 'red' || health.status === 'disabled') return {
    source: 'legacy', requested_source: 'central_ledger',
    fallback_reason: `integration_${health.status}`,
    integration_status: health.status,
    truth: await getLegacyMatrizFinancialTruth(environment, dbPool),
    comparison: null,
  };
  const [legacy, central] = await Promise.all([
    getLegacyMatrizFinancialTruth(environment, dbPool),
    getMatrizCentralLedgerFinancialTruth(environment, dbPool),
  ]);
  return {
    source: 'central_ledger', requested_source: 'central_ledger',
    fallback_reason: null, integration_status: health.status,
    truth: central, comparison: compareTruth(legacy, central),
  };
}
