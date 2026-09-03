import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/persistence/db.js', () => ({ pool: {} }));
vi.mock('../../../src/shared/config/env.js', () => ({
  env: { FAREJADOR_ENV: 'test', MARKETING_SCOPE_ENFORCEMENT_ENABLED: false },
}));

import { getMatrizCentralLedgerFinancialTruth } from
  '../../../src/admin/painel/matriz-ledger-financial-read.js';

function row(overrides: Record<string, string | number> = {}) {
  return {
    revenue: '0', known_cost: '0', operating_expenses: '0', inventory_gain: '0',
    inventory_loss: '0', cash_in: '0', cash_out: '0', cash_opening: '0',
    cash_retail: '0', cash_wholesale: '0', cash_network: '0', cash_monthly: '0',
    cash_purchases: '0', cash_expenses: '0', cash_commission_refund: '0',
    pending_revenue: '0', pending_items: 0, pending_orders: 0, receivables: '0',
    payables: '0', retail_receivable: '0', cancelled_retail: 0,
    cancelled_wholesale: 0, cancelled_purchases: 0, reversed_commissions: 0,
    deleted_expenses: 0, reversed_after_settlement: 0, suspected_test_rows: 0,
    source_wholesale: '0', ledger_wholesale: '0', source_retail: '0',
    ledger_retail: '0', source_freight: '0', source_commission: '0',
    ledger_commission: '0', source_monthly: '0', ledger_monthly: '0',
    source_expenses: '0', ledger_expenses: '0', source_marketing: '0',
    ledger_marketing: '0', source_purchases: '0', ledger_purchases: '0',
    source_inventory: '0', ledger_inventory: '0', ...overrides,
  };
}

describe('saldo contínuo do livro financeiro central', () => {
  it('transporta o saldo anterior e mantém a equação do caixa em centavos', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [row({ cash_in: '12450', cash_out: '11650' })] })
      .mockResolvedValueOnce({ rows: [row({ cash_opening: '800' })] });
    const pool = { query } as unknown as Pool;

    const august = await getMatrizCentralLedgerFinancialTruth('test', pool, '2026-08');
    const september = await getMatrizCentralLedgerFinancialTruth('test', pool, '2026-09');

    expect(august.caixa).toMatchObject({
      saldo_anterior: '0.00', entradas_registradas: '12450.00',
      saidas_registradas: '11650.00', movimento_liquido: '800.00',
      saldo_atual: '800.00',
    });
    expect(september.caixa).toMatchObject({
      saldo_anterior: '800.00', saldo_atual: '800.00',
    });
    expect(query.mock.calls[0]![1]).toEqual(['test', false, '2026-08']);
    expect(String(query.mock.calls[0]![0])).toContain('cash_on<b.month_start');
  });
});
