import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/shared/config/env.js', () => ({ env: { FAREJADOR_ENV: 'test' } }));
vi.mock('../../../src/persistence/db.js', () => ({ pool: {} }));
const { ensureReady } = vi.hoisted(() => ({ ensureReady: vi.fn(async () => undefined) }));
vi.mock('../../../src/admin/caixa/simple-finance.js', () => ({
  ensureMatrizFinanceAvailable: ensureReady,
}));

import { getMatrizFinanceEntries } from '../../../src/admin/caixa/finance-entries.js';
import { EFFECTIVE_CASH_TRANSACTION_SQL } from '../../../src/admin/painel/matriz-effective-cash.js';

describe('Entradas do Financeiro operacional da Matriz', () => {
  it('preserva a correção no histórico de entradas e identifica seu valor fora do total', async () => {
    const query = vi.fn(async () => ({ rows: [{
      id: 'ledger-1', source_type: 'commerce.order.payment', description: 'Venda PED-1048',
      payment_method: 'pix', amount: '399.80', entry_date: '2026-08-14',
      occurred_at: '2026-08-14T14:00:00.000Z', cash_entry_error: false, total_amount: '399.80', total_count: 2,
    }, {
      id: 'expense-correction', source_type: 'commerce.matriz_expense.cancel', description: 'Correção da despesa',
      payment_method: null, amount: '3900.00', entry_date: '2026-08-14',
      occurred_at: '2026-08-14T11:00:00.000Z', cash_entry_error: true, total_amount: '399.80', total_count: 2,
    }] }));

    const payload = await getMatrizFinanceEntries('15d', { query } as unknown as Pool);

    expect(ensureReady).toHaveBeenCalledOnce();
    expect(payload).toMatchObject({ range: '15d', total: 399.8, count: 2, visible_count: 2 });
    expect(payload.rows[0]).toMatchObject({ kind: 'sale', origin: 'Venda na Matriz' });
    expect(payload.rows[1]).toMatchObject({ kind: 'other', amount: 3900, cash_entry_error: true });
    expect(query.mock.calls[0]?.[1]).toEqual(['test', 15, null]);
    expect(query.mock.calls[0]?.[0]).toContain("e.account_code='cash' AND e.side='debit'");
    expect(query.mock.calls[0]?.[0]).toContain(EFFECTIVE_CASH_TRANSACTION_SQL);
    expect(query.mock.calls[0]?.[0]).toContain('sum(amount) FILTER (WHERE NOT cash_entry_error)');
  });
});
