import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

function moduleFactory() {
  const source = readFileSync('painel/public/app.compras.precos.js', 'utf8');
  const context = { window: { PAINEL_MODULES: {}, FarejadorTime: {
    formatDate: (value: unknown) => new Date(value as string | Date).toISOString().slice(0, 10),
  } }, Date, Math, Number, String, Map };
  runInNewContext(source, context);
  return context.window.PAINEL_MODULES.comprasPrecos();
}

function state() {
  return {
    ...moduleFactory(),
    comprasPriceVariantSearch: '',
    comprasPriceSelectedMeasure: '90/90-18|pirelli|meia_vida',
    catalogoConditionLabel: () => 'Meia-vida',
    comprasPriceGroups: () => [{
      variant_key: '90/90-18|pirelli|meia_vida', measure: '90/90-18',
      brand: 'Pirelli', tire_condition: 'meia_vida', suppliers: [{
        supplier_id: 'a', supplier_name: 'Thiago', history: [
          { purchase_id: 'p2', purchased_at: '2026-08-20', unit_cost: '8', quantity: 2 },
          { purchase_id: 'p1', purchased_at: '2026-08-10', unit_cost: '5', quantity: 1 },
        ],
      }, {
        supplier_id: 'b', supplier_name: 'Cicero', history: [
          { purchase_id: 'p3', purchased_at: '2026-08-15', unit_cost: '10', quantity: 3 },
        ],
      }],
    }, {
      variant_key: '110/70-13|ira|meia_vida', measure: '110/70-13',
      brand: 'IRA', tire_condition: 'meia_vida', suppliers: [],
    }],
    comprasPriceSelected() {
      return this.comprasPriceGroups().find((row: { variant_key: string }) =>
        row.variant_key === this.comprasPriceSelectedMeasure);
    },
  };
}

describe('comparação visual de preços', () => {
  it('filtra variantes localmente sem refazer a consulta', () => {
    const vm = state();
    vm.comprasPriceVariantSearch = 'ira';
    expect(vm.comprasPriceVisibleGroups()).toHaveLength(1);
    expect(vm.comprasPriceVisibleGroups()[0].brand).toBe('IRA');
  });

  it('desenha séries independentes e ordenadas por fornecedor', () => {
    const chart = state().comprasPriceHistoryChart();
    expect(chart.empty).toBe(false);
    expect(chart.series).toHaveLength(2);
    expect(chart.series[0].supplier_name).toBe('Thiago');
    expect(chart.series[0].points.map((point: { purchase_id: string }) => point.purchase_id))
      .toEqual(['p1', 'p2']);
    expect(chart.series[0].path).toMatch(/^M /);
    expect(chart.series[0].color).not.toMatch(/#[0-9a-f]{0,4}ff/i);
  });
});
