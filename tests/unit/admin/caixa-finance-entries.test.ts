import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/shared/config/env.js', () => ({ env: { FAREJADOR_ENV: 'test' } }));
vi.mock('../../../src/persistence/db.js', () => ({ pool: {} }));
const { ensureReady } = vi.hoisted(() => ({ ensureReady: vi.fn(async () => undefined) }));
vi.mock('../../../src/admin/caixa/simple-finance.js', () => ({
  ensureMatrizFinanceAvailable: ensureReady,
}));

import { getMatrizFinanceEntries } from '../../../src/admin/caixa/finance-entries.js';

describe('Entradas do Financeiro operacional da Matriz', () => {
  it('le todos os debitos de caixa, inclusive devolucoes que estornam uma saida', async () => {
    const query = vi.fn(async () => ({ rows: [{
      id: 'ledger-1', source_type: 'commerce.order.payment', description: 'Venda PED-1048',
      payment_method: 'pix', amount: '399.80', entry_date: '2026-08-14',
      occurred_at: '2026-08-14T14:00:00.000Z', total_amount: '399.80', total_count: 1,
    }] }));

    const payload = await getMatrizFinanceEntries('15d', { query } as unknown as Pool);

    expect(ensureReady).toHaveBeenCalledOnce();
    expect(payload).toMatchObject({ range: '15d', total: 399.8, count: 1, visible_count: 1 });
    expect(payload.rows[0]).toMatchObject({ kind: 'sale', origin: 'Venda na Matriz' });
    expect(query.mock.calls[0]?.[1]).toEqual(['test', 15]);
    expect(query.mock.calls[0]?.[0]).toContain("e.account_code='cash' AND e.side='debit'");
    expect(query.mock.calls[0]?.[0]).not.toContain('reversal_of_transaction_id=t.id');
  });
});
