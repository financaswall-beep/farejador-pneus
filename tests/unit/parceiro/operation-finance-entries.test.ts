import { describe, expect, it, vi } from 'vitest';
import type { PartnerContext } from '../../../src/parceiro/auth.js';

const { partnerQuery } = vi.hoisted(() => ({ partnerQuery: vi.fn() }));
vi.mock('../../../src/parceiro/db.js', () => ({
  withPartnerContext: vi.fn(async (_id: string, callback: (client: { query: typeof partnerQuery }) => unknown) => callback({ query: partnerQuery })),
}));

import { getPartnerFinanceEntries } from '../../../src/parceiro/finance-entries.js';

const context: PartnerContext = {
  environment: 'test', partnerId: 'partner-1', partnerUnitId: 'partner-unit-1',
  unitId: 'unit-1', slug: 'rio-do-ouro', partnerName: 'Rio',
  unitName: 'Borracharia Rio do Ouro', role: 'owner', tokenId: 'owner-token',
};

describe('Entradas do Financeiro operacional do parceiro', () => {
  it('combina vendas imediatas e recebimentos no mesmo recorte do resumo', async () => {
    partnerQuery.mockResolvedValueOnce({ rows: [{
      id: 'entry-1', kind: 'sale', title: 'Cliente Balcao', subtitle: 'MAGGION 90/90-18',
      origin: 'Venda', payment_method: 'Pix', amount: '199.90', entry_date: '2026-08-14',
      occurred_at: '2026-08-14T13:00:00.000Z', total_amount: '459.80', total_count: 2,
    }] });

    const payload = await getPartnerFinanceEntries(context, '7d');

    expect(payload).toMatchObject({ range: '7d', total: 459.8, count: 2, visible_count: 1 });
    expect(payload.rows[0]).toMatchObject({ kind: 'sale', amount: 199.9, payment_method: 'Pix' });
    expect(partnerQuery.mock.calls[0]?.[1]).toEqual(['test', 'unit-1', 7]);
    expect(partnerQuery.mock.calls[0]?.[0]).toContain('linked.source_order_id=po.id');
    expect(partnerQuery.mock.calls[0]?.[0]).toContain("po.delivery_status<>'delivered'");
    expect(partnerQuery.mock.calls[0]?.[0]).toContain('NOT po.awaiting_pickup');
    expect(partnerQuery.mock.calls[0]?.[0]).toContain('realized.realized_at');
    expect(partnerQuery.mock.calls[0]?.[0]).toContain("event.event_kind IN ('receipt','recovery')");
    expect(partnerQuery.mock.calls[0]?.[0]).toContain('partner_receivable_events');
    expect(partnerQuery.mock.calls[0]?.[0]).toContain('sum(amount) OVER()');
  });
});
