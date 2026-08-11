import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { getPartnerMySaleDetail, getPartnerMySales } from '../../../src/parceiro/my-sales.js';
import type { PartnerContext } from '../../../src/parceiro/auth.js';

vi.mock('../../../src/persistence/db.js', () => ({ pool: {} }));

const ctx: PartnerContext = {
  environment: 'prod', partnerId: 'partner-rio', partnerUnitId: 'partner-unit-rio',
  unitId: 'unit-rio', slug: 'borracharia-rio-do-ouro', partnerName: 'Rio do Ouro',
  unitName: 'Borracharia Rio do Ouro', role: 'funcionario', tokenId: 'token-wallace',
};

describe('Minhas vendas do parceiro', () => {
  it('usa unidade e token da sessão em todas as consultas', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{
        date: '2026-08-10', sales_count: 1, revenue: '259.90',
        items_quantity: 1, commission_amount: '12.99',
      }] })
      .mockResolvedValueOnce({ rows: [{
        order_id: '33333333-3333-4333-8333-333333333333', payment_method: 'pix',
        total_amount: '259.90', status: 'confirmed', created_at: '2026-08-10T13:42:00Z',
        items_quantity: 1, item_kind: 'pneu', first_name: 'MAGGION 100/80-18', item_lines: 1,
        commission_kind: 'percent', commission_value: '5', commission_amount: '12.99',
        commission_entry_status: 'earned', payable_status: 'open',
      }] });
    const db = { query } as unknown as Pool;

    const result = await getPartnerMySales(ctx, -1, db);

    expect(result.sales[0]).toMatchObject({ commission_amount: 12.99, commission_status: 'receivable' });
    expect(query.mock.calls[0]?.[1]).toEqual(['prod', 'unit-rio', 'token-wallace', -1]);
    expect(query.mock.calls[1]?.[1]).toEqual(['prod', 'unit-rio', 'token-wallace', -1]);
    const sql = query.mock.calls.map((call) => String(call[0])).join('\n');
    expect(sql).toContain('po.operator_token_id=$3');
    expect(sql).toContain('ce.token_id=$3');
    expect(sql).not.toContain('customer_name');
  });

  it('não abre pedido pertencente a outro token', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [] });
    const db = { query } as unknown as Pool;
    const orderId = '44444444-4444-4444-8444-444444444444';

    expect(await getPartnerMySaleDetail(ctx, orderId, db)).toBeNull();
    expect(query.mock.calls[0]?.[1]).toEqual(['prod', 'unit-rio', 'token-wallace', orderId]);
    expect(String(query.mock.calls[0]?.[0])).toContain('po.operator_token_id=$3');
  });
});
