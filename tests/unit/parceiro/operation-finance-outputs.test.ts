import { describe, expect, it, vi } from 'vitest';
import type { PartnerContext } from '../../../src/parceiro/auth.js';

const { partnerQuery } = vi.hoisted(() => ({ partnerQuery: vi.fn() }));
vi.mock('../../../src/parceiro/db.js', () => ({
  withPartnerContext: vi.fn(async (_id: string, callback: (client: { query: typeof partnerQuery }) => unknown) => callback({ query: partnerQuery })),
}));

import { getPartnerFinanceOutputs } from '../../../src/parceiro/finance-outputs.js';

const context: PartnerContext = {
  environment: 'test', partnerId: 'partner-1', partnerUnitId: 'partner-unit-1',
  unitId: 'unit-1', slug: 'rio-do-ouro', partnerName: 'Rio',
  unitName: 'Borracharia Rio do Ouro', role: 'owner', tokenId: 'owner-token',
};

describe('Saídas do Financeiro operacional do parceiro', () => {
  it('combina compras pagas, despesas diretas e contas pagas sem duplicar', async () => {
    partnerQuery.mockResolvedValueOnce({ rows: [{
      id: 'output-1', kind: 'expense', title: 'Energia', subtitle: 'utilities',
      origin: 'Despesa', payment_method: 'Pix', amount: '380.00',
      entry_date: '2026-08-14', occurred_at: null, total_amount: '680.00', total_count: 2,
    }] });

    const payload = await getPartnerFinanceOutputs(context, '15d');

    expect(payload).toMatchObject({ range: '15d', total: 680, count: 2, visible_count: 1 });
    expect(payload.rows[0]).toMatchObject({ kind: 'expense', amount: 380 });
    expect(partnerQuery.mock.calls[0]?.[1]).toEqual(['test', 'unit-1', 15]);
    expect(partnerQuery.mock.calls[0]?.[0]).toContain("pp.payment_status='paid_now'");
    expect(partnerQuery.mock.calls[0]?.[0]).toContain('pe.source_payable_id IS NULL');
    expect(partnerQuery.mock.calls[0]?.[0]).toContain("p.status='paid'");
    expect(partnerQuery.mock.calls[0]?.[0]).toContain('sum(amount) OVER()');
  });
});
