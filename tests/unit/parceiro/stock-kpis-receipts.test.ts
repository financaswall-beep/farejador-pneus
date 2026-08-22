import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

function kpis(): any {
  const sandbox: any = { window: { PARCEIRO_MODULES: {} }, console, Date, Intl };
  vm.runInNewContext(
    readFileSync('parceiro/public/app.business-time.js', 'utf8'),
    sandbox,
  );
  vm.runInNewContext(
    readFileSync('parceiro/public/app.estoque.kpis.js', 'utf8'),
    sandbox,
  );
  return sandbox.window.PARCEIRO_MODULES.estoqueKpis();
}

describe('indicadores de estoque após o fluxo de recebimento', () => {
  it('conta somente quantidade realmente recebida e na data do recebimento', () => {
    const state = kpis();
    const receivedAt = new Date().toISOString();
    Object.assign(state, {
      compras: [
        {
          status: 'active', receipt_status: 'pending',
          purchased_at: receivedAt, items: [{ quantity: 20, received_quantity: null }],
        },
        {
          status: 'active', receipt_status: 'received',
          purchased_at: '2025-01-01T00:00:00Z', received_at: receivedAt,
          items: [{ quantity: 8, received_quantity: 3 }],
        },
      ],
      estoque: [], activeSales: [], completedSales: [],
      num: (value: unknown) => Number(value || 0),
      isCurrentMonth: (value: string) => value === receivedAt,
      isPhysicalExitSale: () => false,
      saleRealizedAt: () => null,
      salesUnitsFor: () => 0,
    });
    expect(state.purchasedUnitsMonth).toBe(3);
    expect(state.stockMovementSeries.reduce(
      (sum: number, week: { entradas: number }) => sum + week.entradas, 0,
    )).toBe(3);
  });

  it('trata item totalmente reservado como alerta de reposição', () => {
    const state = kpis();
    Object.assign(state, {
      estoque: [
        { stock_status: 'reserved' },
        { stock_status: 'in_stock' },
      ],
    });
    expect(state.stockLowItems).toHaveLength(1);
    expect(state.stockLowItems[0].stock_status).toBe('reserved');
  });
});
