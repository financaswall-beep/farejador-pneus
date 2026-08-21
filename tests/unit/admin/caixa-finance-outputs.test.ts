import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/shared/config/env.js', () => ({ env: { FAREJADOR_ENV: 'test' } }));
vi.mock('../../../src/persistence/db.js', () => ({ pool: {} }));
const { ensureReady } = vi.hoisted(() => ({ ensureReady: vi.fn(async () => undefined) }));
vi.mock('../../../src/admin/caixa/simple-finance.js', () => ({
  ensureMatrizFinanceAvailable: ensureReady,
}));

import { getMatrizFinanceOutputs } from '../../../src/admin/caixa/finance-outputs.js';

describe('Saídas do Financeiro operacional da Matriz', () => {
  it('lê todos os créditos de caixa, inclusive devoluções que estornam uma entrada', async () => {
    const query = vi.fn(async () => ({ rows: [{
      id: 'ledger-2', source_type: 'commerce.matriz_expense.payment',
      description: 'Conta de energia', payment_method: 'pix', amount: '540.00',
      entry_date: '2026-08-14', occurred_at: '2026-08-14T15:00:00.000Z',
      total_amount: '540.00', total_count: 1,
    }] }));

    const payload = await getMatrizFinanceOutputs('7d', { query } as unknown as Pool);

    expect(ensureReady).toHaveBeenCalledOnce();
    expect(payload).toMatchObject({ range: '7d', total: 540, count: 1, visible_count: 1 });
    expect(payload.rows[0]).toMatchObject({ kind: 'expense', origin: 'Despesa da Matriz' });
    expect(query.mock.calls[0]?.[1]).toEqual(['test', 7]);
    expect(query.mock.calls[0]?.[0]).toContain("e.account_code='cash' AND e.side='credit'");
    expect(query.mock.calls[0]?.[0]).not.toContain('reversal_of_transaction_id=t.id');
  });
});
