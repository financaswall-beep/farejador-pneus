import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/shared/config/env.js', () => ({ env: { FAREJADOR_ENV: 'test' } }));
vi.mock('../../../src/persistence/db.js', () => ({ pool: {} }));
const { ensureReady } = vi.hoisted(() => ({ ensureReady: vi.fn(async () => undefined) }));
vi.mock('../../../src/admin/caixa/simple-finance.js', () => ({
  ensureMatrizFinanceAvailable: ensureReady,
}));

import { getMatrizFinanceOutputs } from '../../../src/admin/caixa/finance-outputs.js';
import { EFFECTIVE_CASH_TRANSACTION_SQL } from '../../../src/admin/painel/matriz-effective-cash.js';

describe('Saídas do Financeiro operacional da Matriz', () => {
  it('preserva a despesa cancelada no histórico de saídas e identifica seu valor fora do total', async () => {
    const query = vi.fn(async () => ({ rows: [{
      id: 'ledger-2', source_type: 'commerce.matriz_expense.payment',
      description: 'Conta de energia', payment_method: 'pix', amount: '540.00',
      entry_date: '2026-08-14', occurred_at: '2026-08-14T15:00:00.000Z',
      cash_entry_error: false, total_amount: '540.00', total_count: 2,
    }, {
      id: 'wrong-expense', source_type: 'commerce.matriz_expense.accrual', description: 'Despesa duplicada',
      payment_method: null, amount: '3900.00', entry_date: '2026-08-13',
      occurred_at: '2026-08-13T11:00:00.000Z', cash_entry_error: true, total_amount: '540.00', total_count: 2,
    }] }));

    const payload = await getMatrizFinanceOutputs('7d', { query } as unknown as Pool);

    expect(ensureReady).toHaveBeenCalledOnce();
    expect(payload).toMatchObject({ range: '7d', total: 540, count: 2, visible_count: 2 });
    expect(payload.rows[0]).toMatchObject({ kind: 'expense', origin: 'Despesa da Matriz' });
    expect(payload.rows[1]).toMatchObject({ kind: 'expense', amount: 3900, cash_entry_error: true });
    expect(query.mock.calls[0]?.[1]).toEqual(['test', 7, null]);
    expect(query.mock.calls[0]?.[0]).toContain("e.account_code='cash' AND e.side='credit'");
    expect(query.mock.calls[0]?.[0]).toContain(EFFECTIVE_CASH_TRANSACTION_SQL);
    expect(query.mock.calls[0]?.[0]).toContain('sum(amount) FILTER (WHERE NOT cash_entry_error)');
  });
});
