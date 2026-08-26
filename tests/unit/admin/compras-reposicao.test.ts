import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function moduleState(open = vi.fn()) {
  const sandbox: any = { window: { PAINEL_MODULES: {}, open } };
  vm.runInNewContext(
    readFileSync(resolve('painel/public/app.compras.reposicao.js'), 'utf8'),
    sandbox,
  );
  const methods = sandbox.window.PAINEL_MODULES.comprasReposicao();
  return {
    ...methods,
    comprasReplenishment: {
      rows: [], generatedAt: null, loading: false, error: null, noMinimum: 0,
      search: '', condition: 'all', period: 'all', onlyCompetition: false,
    },
    atacadoStock: [],
    stockVariantKey: (row: any) => [row.measure, String(row.brand).toLowerCase(),
      row.tire_condition].join('\0'),
    measureAvailable: (row: any) => Number(row.quantity_available),
    formatCurrency: (value: number) => `R$ ${Number(value).toFixed(2).replace('.', ',')}`,
    formatDateTime: () => '25/08/2026 10:00',
    catalogoConditionLabel: (value: string) => value === 'meia_vida' ? 'Meia-vida' : value,
    $nextTick: (callback: () => void) => callback(),
  } as any;
}

describe('relatório sob demanda do plano de reposição', () => {
  const stock = [
    { measure: '110/70-13', brand: 'IRA', tire_condition: 'meia_vida',
      quantity_available: 2, min_quantity: 8, in_transit_quantity: 1, sales_30d: 4 },
    { measure: '110/70-13', brand: 'Pirelli', tire_condition: 'meia_vida',
      quantity_available: 3, min_quantity: 8, in_transit_quantity: 0, sales_30d: 2 },
    { measure: '90/90-18', brand: 'Pirelli', tire_condition: 'meia_vida',
      quantity_available: 0, min_quantity: 3, in_transit_quantity: 3, sales_30d: 2 },
    { measure: '100/90-18', brand: 'Maggion', tire_condition: 'meia_vida',
      quantity_available: 0, min_quantity: null, in_transit_quantity: 0, sales_30d: 1 },
  ];
  const prices = [
    { measure: '110/70-13', brand: 'IRA', tire_condition: 'meia_vida',
      supplier_id: 'a', supplier_name: 'Fornecedor A', avg_cost: 7,
      supplier_archived: false, last_purchased_at: '2026-08-20' },
    { measure: '110/70-13', brand: 'IRA', tire_condition: 'meia_vida',
      supplier_id: 'b', supplier_name: 'Fornecedor B', avg_cost: 5,
      supplier_archived: false, last_purchased_at: '2026-08-24' },
    { measure: '110/70-13', brand: 'IRA', tire_condition: 'meia_vida',
      supplier_id: 'c', supplier_name: 'Arquivado', avg_cost: 1,
      supplier_archived: true, last_purchased_at: '2026-08-25' },
    { measure: '110/70-13', brand: 'Pirelli', tire_condition: 'meia_vida',
      supplier_id: 'd', supplier_name: 'Fornecedor Pirelli', avg_cost: 4,
      supplier_archived: false, last_purchased_at: '2026-08-25' },
  ];

  it('soma marcas, desconta o trânsito e recomenda a compra exata mais barata', () => {
    const state = moduleState();
    const rows = state.comprasReplenishmentBuild(stock, prices);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      measure: '110/70-13', brand: 'Pirelli', recommended_brand: 'Pirelli',
      brand_summary: 'IRA, Pirelli', quantity_available: 5,
      min_quantity: 8, in_transit_quantity: 1, suggested_quantity: 2,
      supplier_id: 'd', supplier_name: 'Fornecedor Pirelli',
      historical_unit_cost: 4, estimated_amount: 8,
    });
  });

  it('não mistura novo, meia-vida e remold da mesma medida', () => {
    const state = moduleState();
    const rows = state.comprasReplenishmentBuild([
      ...stock,
      { measure: '110/70-13', brand: 'IRA', tire_condition: 'novo',
        quantity_available: 0, min_quantity: 3, in_transit_quantity: 0, sales_30d: 0 },
    ], prices);

    expect(rows).toHaveLength(2);
    expect(rows.find((row: any) => row.tire_condition === 'meia_vida')?.suggested_quantity).toBe(2);
    expect(rows.find((row: any) => row.tire_condition === 'novo')?.suggested_quantity).toBe(3);
  });

  it('busca uma fotografia nova e não altera compra, estoque ou financeiro', async () => {
    const state = moduleState();
    state.apiGet = vi.fn()
      .mockResolvedValueOnce({ rows: stock })
      .mockResolvedValueOnce({ rows: prices });

    await state.comprasGenerateReplenishment();

    expect(state.apiGet.mock.calls.map((call: string[]) => call[0])).toEqual([
      '/admin/api/wholesale/stock',
      '/admin/api/wholesale/suppliers/prices?period=all',
    ]);
    expect(state.comprasReplenishment.rows).toHaveLength(1);
    expect(state.comprasReplenishment.noMinimum).toBe(1);
    expect(state.comprasReplenishment.generatedAt).toBeTruthy();
  });

  it('abre o WhatsApp com a lista completa, mas não envia sozinho', () => {
    const open = vi.fn();
    const state = moduleState(open);
    state.comprasReplenishment = {
      rows: state.comprasReplenishmentBuild(stock, prices),
      generatedAt: '2026-08-25T13:00:00.000Z', loading: false, error: null,
      noMinimum: 1,
      search: '', condition: 'all', period: 'all', onlyCompetition: false,
    };

    const url = state.comprasShareReplenishment();
    const message = decodeURIComponent(url.split('?text=')[1]);

    expect(url).toMatch(/^https:\/\/wa\.me\/\?text=/);
    expect(message).toContain('2x 110/70-13');
    expect(message).toContain('Marca sugerida: Pirelli');
    expect(message).toContain('Fornecedor Pirelli');
    expect(message).toContain('Confirme preços, disponibilidade e frete');
    expect(open).toHaveBeenCalledWith(url, '_blank', 'noopener,noreferrer');
  });

  it('recalcula totais quando o comprador revisa quantidade e seleção', () => {
    const state = moduleState();
    state.comprasReplenishment.rows = state.comprasReplenishmentBuild(stock, prices);
    const row = state.comprasReplenishment.rows[0];

    state.comprasReplenishmentSetQuantity(row, 4);
    expect(state.comprasReplenishmentSummary()).toMatchObject({
      variants: 1, measures: 1, tires: 4, estimated: 16, savings: 4, suppliers: 1,
    });

    row.selected = false;
    expect(state.comprasReplenishmentSummary()).toMatchObject({
      variants: 0, tires: 0, estimated: 0, savings: 0,
    });
  });

  it('filtra sem modificar a fotografia original do estoque', () => {
    const state = moduleState();
    state.comprasReplenishment.rows = state.comprasReplenishmentBuild(stock, prices);
    state.comprasReplenishment.search = '110/70';
    state.comprasReplenishment.onlyCompetition = true;

    expect(state.comprasReplenishmentVisibleRows()).toHaveLength(1);
    state.comprasReplenishment.search = 'pirelli';
    expect(state.comprasReplenishmentVisibleRows()).toHaveLength(1);
  });
});
