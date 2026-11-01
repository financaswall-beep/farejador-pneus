import { describe, expect, it } from 'vitest';
import { purchaseGroupSummary } from '../../../src/admin/painel/purchase-group-summary.js';

describe('Viagem de compra: lente sobre os registros existentes', () => {
  const purchase = { status: 'confirmed', total_amount: '10800.00', freight_amount: '800.00',
    items_count: 100, stock_applied: true };
  it('soma o frete uma única vez e não depende de pagamento', () => {
    const s = purchaseGroupSummary([purchase], [
      { amount: '300.00', category: 'combustivel', deleted_at: null },
      { amount: '400.00', category: 'outros', deleted_at: null },
    ]);
    expect(s).toMatchObject({ purchases: '10800.00', freight_included: '800.00', expenses: '700.00',
      total: '11500.00', tires: 100, received: 100, transit: 0, cost_per_tire: '115.00', provisional: false });
    expect(s).not.toHaveProperty('paid');
    expect(s).not.toHaveProperty('pending');
  });
  it('exclui cancelados/removidos e sinaliza frete possivelmente duplicado', () => {
    const s = purchaseGroupSummary([purchase, { ...purchase, status: 'cancelled' }], [
      { amount: '10.01', category: 'frete', deleted_at: null },
      { amount: '999.00', category: 'outros', deleted_at: '2026-01-01' },
    ]);
    expect(s.total).toBe('10810.01');
    expect(s.freight_warning).toBe(true);
    expect(s.tires).toBe(100);
  });
  it('mostra provisório, arredonda centavos e não inventa divisão por zero', () => {
    expect(purchaseGroupSummary([{ ...purchase, total_amount: '10.00', items_count: 3,
      stock_applied: false }], []).cost_per_tire).toBe('3.33');
    expect(purchaseGroupSummary([{ ...purchase, stock_applied: false }], [])).toMatchObject({
      provisional: true, pending_purchases: 1, received: 0, transit: 100,
    });
    expect(purchaseGroupSummary([], []).cost_per_tire).toBeNull();
  });
});
