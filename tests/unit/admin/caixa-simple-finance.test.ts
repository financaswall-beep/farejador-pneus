import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/shared/config/env.js', () => ({
  env: {
    FAREJADOR_ENV: 'test',
    MATRIZ_CENTRAL_LEDGER: true,
    MATRIZ_CENTRAL_LEDGER_READ: true,
  },
}));
vi.mock('../../../src/admin/painel/matriz-ledger-integration-health.js', () => ({
  getMatrizLedgerIntegrationHealth: vi.fn(async () => ({ status: 'green' })),
}));
vi.mock('../../../src/admin/painel/matriz-ledger-open-items.js', () => ({
  getMatrizLedgerOpenItems: vi.fn(async () => ({
    a_receber: { total: '2360.00', itens: [{ valor: '2360.00', due_date: null }] },
    a_pagar: { total: '400.00', itens: [] },
  })),
}));
vi.mock('../../../src/admin/painel/queries-colaboradores-gestao.js', () => ({
  getMatrizCollaboratorManagement: vi.fn(async () => ({
    summary: { commission_total: 1280 },
    collaborators: [
      { active: true, commission_active: true },
      { active: true, commission_active: true },
      { active: true, commission_active: false },
    ],
  })),
}));
vi.mock('../../../src/admin/painel/queries-financeiro-read-switch.js', () => ({
  MatrizCentralLedgerUnavailableError: class extends Error {
    constructor(reason: string) { super(`central_ledger_${reason}`); }
  },
}));
vi.mock('../../../src/persistence/db.js', () => ({ pool: {} }));

import { getMatrizSimpleFinance } from '../../../src/admin/caixa/simple-finance.js';

describe('Financeiro simples da Matriz', () => {
  it('le exclusivamente o livro central no intervalo e reaproveita a comissao da folha', async () => {
    const query = vi.fn(async () => ({
      rows: [{ entradas: '18450.00', saidas: '5670.00' }],
    }));
    const payload = await getMatrizSimpleFinance('15d', { query } as unknown as Pool);

    expect(payload).toMatchObject({
      unit_name: 'Matriz', cash_in: 18450, cash_out: 5670, cash_net: 12780,
      receivable_total: 2360, receivable_count: 1,
      commission_total: 1280, commission_collaborators: 2, range: '15d',
    });
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[1]?.[0]).toBe('test');
    expect(query.mock.calls[0]?.[0]).not.toContain('reversal_of_transaction_id=t.id');
  });
});
