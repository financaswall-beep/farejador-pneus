import { describe, expect, it, vi } from 'vitest';
import type { PartnerContext } from '../../../src/parceiro/auth.js';
vi.mock('../../../src/persistence/db.js', () => ({ pool: { query: vi.fn() } }));
vi.mock('../../../src/parceiro/queries.js', () => ({ settlePartnerPayable: vi.fn() }));
import { getPartnerOperationCommissionDetail } from '../../../src/parceiro/operation-commissions.js';

const ctx: PartnerContext = {
  environment: 'test', partnerId: 'partner-1', partnerUnitId: 'partner-unit-1',
  unitId: 'unit-1', slug: 'loja', partnerName: 'Loja', unitName: 'Loja',
  role: 'owner', tokenId: 'owner-1',
};

describe('detalhe da comissão parceira', () => {
  it('inclui ajustes do mesmo fechamento sem contá-los como venda', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('WITH facts AS')) return { rows: [{
        token_id: 'employee-1', label: 'João', username: 'joao', active: true,
        job_role: 'vendedor', commission_kind: 'percent', commission_value: '5.00',
        commission_itemized: false, commission_item_rules: {}, settlement_frequency: 'monthly',
        sales_count: 1, gross_sales: '100.00', commission_amount: '3.00', unsettled_count: 0,
      }] };
      if (sql.includes('FROM finance.partner_staff_commission_periods period')) return { rows: [{
        token_id: 'employee-1', payable_id: '00000000-0000-4000-8000-000000000001',
        payable_amount: '3.00', payable_status: 'open', settlement_frequency: 'monthly',
        period_start: '2026-07-01', period_end: '2026-07-31',
      }] };
      return { rows: [{
        entry_type: 'sale', id: 'sale-1', reference: 'Pedido #123456',
        occurred_at: '2026-07-10T12:00:00Z', payment_method: 'pix',
        gross_amount: '100.00', commission_amount: '5.00',
        commission_itemized: false, commission_rules: {},
      }, {
        entry_type: 'adjustment', id: 'adjustment-1', reference: 'Venda cancelada',
        occurred_at: '2026-07-20T12:00:00Z', payment_method: null,
        gross_amount: '0.00', commission_amount: '-2.00',
        commission_itemized: false, commission_rules: {},
      }] };
    });

    const result = await getPartnerOperationCommissionDetail(
      ctx, 'employee-1', '30d', { query } as never,
    );

    expect(result?.sales.map((row) => row.entry_type)).toEqual(['sale', 'adjustment']);
    expect(result?.collaborator).toMatchObject({
      role: 'Vendedor', sales_count: 1, gross_sales: 100, commission_amount: 3,
    });
    expect(String(query.mock.calls[2]?.[0])).toContain('partner_staff_commission_adjustments');
    expect(query.mock.calls[2]?.[1]?.[5]).toBe('00000000-0000-4000-8000-000000000001');
  });
});
