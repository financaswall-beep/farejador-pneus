import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/persistence/db.js', () => ({ pool: {} }));
vi.mock('../../../src/shared/config/env.js', () => ({ env: { FAREJADOR_ENV: 'test' } }));

import { getMatrizFinancialTruth } from '../../../src/admin/painel/queries-financeiro-verdade.js';

describe('régua financeira única da Matriz', () => {
  it('não fabrica lucro e fecha competência/caixa em centavos', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{
      retail_header: '253.64', retail_items: '233.54', retail_known: '133.43',
      retail_pending: '100.11', retail_cost: '70.05', retail_freight: '20.10',
      pending_all: '100.11', pending_items: 1, pending_orders: 1,
      wholesale_header: '250.70', wholesale_items: '250.70', wholesale_cost: '120.30',
      commission_revenue: '15.06', expenses_competence: '27.09',
      purchases_header: '110.11', purchases_items: '110.11',
      cash_retail: '220.31', cash_wholesale: '200.20', cash_commission: '10.01',
      cash_purchases: '80.08', cash_expenses: '20.02', retail_payment_pending: '33.33',
      receivable_retail: '0', receivable_wholesale: '50.50', receivable_commission: '5.05',
      payable_purchases: '30.03', payable_expenses: '7.07',
      cancelled_retail: 1, cancelled_wholesale: 0, cancelled_purchases: 0,
      reversed_commissions: 0, deleted_expenses: 0, inferred_cash_dates: 0,
      reversed_after_settlement: 0, suspected_test_rows: 0,
    }] });
    const pool = { query } as unknown as Pool;

    const truth = await getMatrizFinancialTruth('test', pool);

    expect(truth.competencia).toEqual({
      receita_total: '519.40', receita_custo_conhecido: '419.29',
      receita_custo_pendente: '100.11', custo_conhecido: '190.35',
      despesas: '27.09', lucro_confirmado: '201.85', status: 'custo_pendente',
    });
    expect(truth.caixa).toMatchObject({
      entradas_registradas: '430.52', saidas_registradas: '100.10',
      movimento_liquido: '330.42', recebimento_pendente: '33.33',
    });
    expect(truth.posicao).toEqual({
      a_receber: '55.55', a_pagar: '37.10', varejo_a_receber_sem_baixa: '0.00',
    });
    expect(truth.conciliacao.diferenca_total).toBe('0.00');
    expect(truth.conciliacao.origens.every((origin) => origin.diferenca === '0.00')).toBe(true);

    const sql = String(query.mock.calls[0]![0]);
    expect(sql).toContain("status<>'cancelled'");
    expect(sql).toContain('matriz_unit_cost IS NULL');
    expect(sql).toContain("status='settled'");
    expect(sql).toContain('deleted_at IS NULL');
  });

  it('faz divergência prevalecer sobre custo pendente', async () => {
    const base = {
      retail_header: '10.01', retail_items: '10.00', retail_known: '0', retail_pending: '10.00',
      retail_cost: '0', retail_freight: '0', pending_items: 1, pending_orders: 1,
      pending_all: '10.00',
      wholesale_header: '0', wholesale_items: '0', wholesale_cost: '0', commission_revenue: '0',
      expenses_competence: '0', purchases_header: '0', purchases_items: '0', cash_retail: '0',
      cash_wholesale: '0', cash_commission: '0', cash_purchases: '0', cash_expenses: '0',
      retail_payment_pending: '0', receivable_retail: '0', receivable_wholesale: '0',
      receivable_commission: '0', payable_purchases: '0', payable_expenses: '0',
      cancelled_retail: 0, cancelled_wholesale: 0, cancelled_purchases: 0,
      reversed_commissions: 0, deleted_expenses: 0, inferred_cash_dates: 0,
      reversed_after_settlement: 0, suspected_test_rows: 0,
    };
    const pool = { query: vi.fn().mockResolvedValue({ rows: [base] }) } as unknown as Pool;
    const truth = await getMatrizFinancialTruth('test', pool);
    expect(truth.competencia.status).toBe('divergente');
    expect(truth.conciliacao).toMatchObject({ status: 'divergente', diferenca_total: '0.01' });
  });
});
