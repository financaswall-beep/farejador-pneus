import { beforeEach, describe, expect, it, vi } from 'vitest';

const { management, payPayroll } = vi.hoisted(() => ({
  management: vi.fn(),
  payPayroll: vi.fn(),
}));

vi.mock('../../../src/admin/painel/queries.js', () => ({
  getMatrizCollaboratorManagement: management,
  payMatrizPayrollItem: payPayroll,
}));
vi.mock('../../../src/persistence/db.js', () => ({ pool: { query: vi.fn() } }));
vi.mock('../../../src/shared/config/env.js', () => ({ env: { FAREJADOR_ENV: 'test' } }));

import { getMatrizOperationCommissions } from '../../../src/admin/caixa/operation-commissions.js';

describe('comissoes da Matriz na Operacao da Loja', () => {
  beforeEach(() => {
    management.mockReset();
    payPayroll.mockReset();
  });

  it('mostra a comissao, mas liquida o total real da folha da Matriz', async () => {
    management.mockResolvedValue({
      collaborators: [{
        id: 'person-1', display_name: 'Wallace', username: 'wallace',
        job_title: 'Vendedor', job: 'vendedor', active: true,
        commission_active: true, commission_kind: 'percent', commission_basis: 'revenue',
        commission_value: 5, payroll_item_id: 'payroll-1', payroll_status: 'pending',
        total_due: 2519.99,
      }],
    });
    const db = { query: vi.fn(async () => ({ rows: [{
      collaborator_id: 'person-1', sales_count: 1, gross_sales: '399.80',
      commission_amount: '19.99',
    }] })) };

    const payload = await getMatrizOperationCommissions('30d', db as never);

    expect(payload.collaborators[0]).toMatchObject({
      status: 'payable', commission_amount: 19.99,
      payment_target_id: 'payroll-1', payment_total: 2519.99,
    });
  });
});
