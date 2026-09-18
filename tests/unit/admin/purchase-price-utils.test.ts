import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
function modules() {
  const context: any = { window: { PAINEL_MODULES: {} } };
  for (const file of ['purchase-price-utils.js', 'app.compras.relatorios.js', 'app.compras.precos.js']) {
    vm.runInNewContext(fs.readFileSync('painel/public/' + file, 'utf8'), context);
  }
  return { U: context.window.PurchasePriceUtils, web: context.window.PAINEL_MODULES.comprasRelatorios() };
}
const row = { measure: '90/90-18', brand: 'Technic', tire_condition: 'novo', vehicle_type: 'motorcycle',
  supplier_id: 'a', supplier_name: 'Distribuidora', avg_cost: '80.00', qty_total: 24, history: [] };
describe('comparação compartilhada pelo web e pelo app', () => {
  it('separa medida, marca, condição e veículo, inclusive tipo desconhecido', () => {
    const { U, web } = modules(); const rows = [row, { ...row, brand: 'Michelin' },
      { ...row, tire_condition: 'meia_vida' }, { ...row, vehicle_type: 'car' }, { ...row, vehicle_type: null },
      { ...row, measure: '100/80-16' }];
    const groups = U.groups(rows); expect(groups).toHaveLength(6);
    expect(web.comprasPriceGroups.call({ comprasPriceRows: rows })).toEqual(groups);
    expect(U.filter(groups, { query: '909018', brand: 'Technic', condition: 'novo' })).toHaveLength(3);
    expect(U.filter(groups, { query: 'meia vida' })).toHaveLength(1);
  });
  it('preserva médias recebidas do servidor e simula em centavos sem preço de venda', () => {
    const { U, web } = modules(); const rows = [row, { ...row, supplier_id: 'b', supplier_name: 'Pneus Rio', avg_cost: '85.00' }];
    const groups = U.groups(rows); const key = groups[0].variant_key;
    const cards = U.cards(groups, key, 10);
    expect(cards).toMatchObject({ total: 800, savings: 50, difference: 5, suppliers: 2 });
    expect(groups[0].suppliers[1].diff_pct).toBe(6.25);
    expect(web.comprasPriceCards.call({ comprasPriceGroups: () => groups, comprasPriceSelectedMeasure: key, comprasPriceQuantity: 10 })).toEqual(cards);
    expect(U.cards(groups, key, 10, 'b')).toMatchObject({ total: 850, savings: -50 });
    const cents = U.groups([{ ...row, avg_cost: '0.10' }, { ...row, supplier_id: 'b', avg_cost: '0.20' }]);
    expect(U.cards(cents, cents[0].variant_key, 3)).toMatchObject({ total: .3, savings: .3 });
  });
  it('não cria concorrência nem transforma ausência de custo em pneu grátis', () => {
    const { U } = modules();
    const groups = U.groups([row, { ...row, supplier_id: 'b', qty_total: 0, avg_cost: null }, { ...row, supplier_id: 'c', avg_cost: null }]);
    expect(groups[0].suppliers).toHaveLength(1);
    expect(U.cards(groups, groups[0].variant_key, 10)).toMatchObject({ alternative: null, suppliers: 1, savings: 0 });
    const zero = U.groups([{ ...row, avg_cost: '0.00' }, { ...row, supplier_id: 'b', avg_cost: '10.00' }]);
    expect(zero[0].suppliers[0].avg_cost).toBe('0.00'); expect(zero[0].suppliers[1].diff_pct).toBeNull();
  });
  it('marca empates e conserva fornecedor arquivado como referência identificada', () => {
    const { U } = modules(); const groups = U.groups([row, { ...row, supplier_id: 'b', supplier_archived: true }]);
    expect(groups[0].suppliers.every((r: any) => r.cheapest)).toBe(true);
    expect(groups[0].suppliers.find((r: any) => r.supplier_id === 'b').supplier_archived).toBe(true);
    expect(U.cards(groups, groups[0].variant_key, 10).savings).toBe(0);
  });
  it('gráfico mantém os pontos reais, descarta ausentes e permite período de um único dia', () => {
    const { U } = modules(); const source = { suppliers: [{ ...row, history: [
      { purchased_at: '2026-01-02', quantity: 2, unit_cost: 80, purchase_id: 'new' },
      { purchased_at: '2026-01-01', quantity: 1, unit_cost: 100, purchase_id: 'old' },
      { purchased_at: null, quantity: 1, unit_cost: 20 },
      { purchased_at: '2026-01-01', quantity: 0, unit_cost: null },
    ] }] };
    const chart = U.chart(source, (d: Date) => d.toISOString().slice(0, 10), 420, 220);
    expect(chart.series[0].points.map((p: any) => p.purchase_id)).toEqual(['old', 'new']);
    expect(chart.series[0].points[0].cost).toBe(100); expect(chart.labels).toHaveLength(2);
    const one = U.chart({ suppliers: [{ ...row, history: [source.suppliers[0].history[0]] }] }, String);
    expect(one.labels).toHaveLength(1); expect(one.series[0].points[0].x).toBe((54 + 680) / 2);
  });
});
