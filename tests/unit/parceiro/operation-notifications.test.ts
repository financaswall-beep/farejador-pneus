import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PartnerContext, PartnerPermissions } from '../../../src/parceiro/auth.js';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock('../../../src/parceiro/db.js', () => ({
  withPartnerContext: async (_partnerUnitId: string, callback: (client: { query: typeof mocks.query }) => Promise<unknown>) => (
    callback({ query: mocks.query })
  ),
}));

import { getPartnerOperationNotifications } from '../../../src/parceiro/operation-notifications.js';

const owner: PartnerContext = {
  environment: 'test', partnerId: 'partner-a', partnerUnitId: 'partner-unit-a',
  unitId: 'unit-a', slug: 'loja-a', partnerName: 'Parceiro A', unitName: 'Loja A',
  role: 'owner', tokenId: 'token-a',
};

const allPermissions: PartnerPermissions = {
  vendas: true, estoque: true, pedidos: true, clientes: true, entregas: true,
  retiradas: true, batepapo: false, resumo: true, financeiro: true,
};

beforeEach(() => mocks.query.mockReset());

describe('avisos internos da Operação do parceiro', () => {
  it('agrega somente dados reais da própria unidade', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ low_stock: 2, pending_registrations: 1, pending_counts: 1 }] })
      .mockResolvedValueOnce({ rows: [{ failed: 1, delayed: 2 }] })
      .mockResolvedValueOnce({ rows: [{ due_today: 1, overdue: 1 }] });

    const result = await getPartnerOperationNotifications(owner, allPermissions);

    expect(result.notifications.map((notice) => notice.id)).toEqual([
      'partner-stock-approvals', 'partner-stock-low', 'partner-deliveries-failed',
      'partner-deliveries-delayed', 'partner-payables-overdue',
    ]);
    expect(mocks.query).toHaveBeenCalledTimes(3);
    for (const call of mocks.query.mock.calls) {
      expect(call[1]).toEqual(['test', 'unit-a']);
    }
  });

  it('não consulta nem revela módulos negados ao funcionário', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ failed: 0, delayed: 1 }] });
    const employee = { ...owner, role: 'funcionario' as const };
    const permissions = {
      ...allPermissions, estoque: false, financeiro: false,
    };

    const result = await getPartnerOperationNotifications(employee, permissions);

    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(String(mocks.query.mock.calls[0]?.[0])).toContain('partner_orders_full');
    expect(result.notifications).toHaveLength(1);
    expect(result.notifications[0]?.target).toBe('deliveries');
  });
});
