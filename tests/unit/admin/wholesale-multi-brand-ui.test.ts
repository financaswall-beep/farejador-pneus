import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function painelModule(file: string, name: string) {
  const sandbox: any = { window: { PAINEL_MODULES: {} }, console };
  vm.runInNewContext(readFileSync(resolve(`painel/public/${file}`), 'utf8'), sandbox);
  return sandbox.window.PAINEL_MODULES[name]();
}

function moduleState() {
  const methods = painelModule('app.galpao.multibrand.js', 'galpaoMultibrand');
  const stock = [
    {
      measure: '90/90-18', brand: 'Pirelli', tire_condition: 'meia_vida',
      quantity_on_hand: 50, quantity_reserved: 0, quantity_available: 50,
      unit_cost: 17, min_quantity: 60, sales_30d: 5,
    },
    {
      measure: '90/90-18', brand: 'Metzeler', tire_condition: 'meia_vida',
      quantity_on_hand: 15, quantity_reserved: 0, quantity_available: 15,
      unit_cost: 12, min_quantity: 20, sales_30d: 2,
    },
  ];
  return {
    ...methods,
    atacadoMeasures: stock,
    atacadoStock: stock,
    measureBox: { key: null, hits: [] },
    galpaoFilme: {
      measure: null,
      brand: null,
      tire_condition: null,
      rows: [
        { measure: '90/90-18', brand: 'Pirelli', tire_condition: 'meia_vida',
          source: 'venda_atacado', qty_delta: -5 },
        { measure: '90/90-18', brand: 'Metzeler', tire_condition: 'meia_vida',
          source: 'venda_atacado', qty_delta: -2 },
      ],
    },
    repoQuantidades: {},
    repoBusca: '',
    repoFiltro: 'todos',
    custoBusca: '',
    custoOrdem: 'capital',
    fornecedorBreakdown: [],
    adminUser: { role: 'owner' },
    stockPrecisaRepor: (row: { min_quantity: number; quantity_on_hand: number;
      quantity_available?: number }) =>
      Number(row.quantity_available ?? row.quantity_on_hand) <= row.min_quantity,
    comprasOpenTab: vi.fn(),
    $nextTick: (callback: () => void) => callback(),
  };
}

describe('Painel do galpão com duas marcas na mesma medida', () => {
  it('seleciona a variante clicada e calcula saldo, custo e lucro pela marca', () => {
    const state = moduleState();
    state.measureFind('', 'v0');
    expect(state.measureBox.hits).toHaveLength(2);
    expect(new Set(state.measureBox.hits.map((row: { variant_key: string }) =>
      row.variant_key)).size).toBe(2);

    const item = {
      measure: '', brand: '', tire_condition: '', quantity: 1, unit_price: 20,
    };
    const metzeler = state.measureBox.hits.find((row: { brand: string }) =>
      row.brand === 'Metzeler');
    state.measurePick(metzeler, item);

    expect(item).toMatchObject({
      measure: '90/90-18', brand: 'Metzeler', tire_condition: 'meia_vida',
    });
    expect(state.measureOnHand(item.measure, item.brand, item.tire_condition)).toBe(15);
    expect(state.measureCost(item.measure, item.brand, item.tire_condition)).toBe(12);
    expect(state.itemProfit(item)).toBe(8);
  });

  it('deduplica medidas em Compras sem escolher uma marca arbitrária', () => {
    const state = moduleState();
    state.measureFind('', 'compra0');
    expect(state.measureBox.hits).toHaveLength(1);
    const item = { measure: '', brand: '', quantity: 1, unit_cost: '' };
    state.measurePick(state.measureBox.hits[0], item);
    expect(item).toMatchObject({ measure: '90/90-18', brand: '' });
  });

  it('consolida o custo ponderado por medida somando todas as marcas', () => {
    const state = moduleState();
    const rows = state.custoRowsBase();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      measure: '90/90-18',
      tire_condition: 'meia_vida',
      brands: ['Metzeler', 'Pirelli'],
      quantity_on_hand: 65,
      capital: 1030,
      cost_complete: true,
    });
    expect(rows[0].unit_cost).toBeCloseTo(1030 / 65, 8);
    expect(state.custoPneusComCusto()).toBe(65);
  });

  it('separa giro e quantidades de reposição e preserva a marca na compra', () => {
    const state = moduleState();
    const pirelli = state.atacadoStock[0];
    const metzeler = state.atacadoStock[1];
    expect(state.repoGiro(pirelli)).toBe(5);
    expect(state.repoGiro(metzeler)).toBe(2);
    state.galpaoFilme.rows.push({ measure: '90/90-18', brand: 'Pirelli',
      tire_condition: 'meia_vida', source: 'venda_atacado', qty_delta: -999 });
    expect(state.repoGiro(pirelli)).toBe(5);

    state.repoDefinirQuantidade(pirelli, 11);
    state.repoDefinirQuantidade(metzeler, 7);
    expect(state.repoQuantidade(pirelli)).toBe(11);
    expect(state.repoQuantidade(metzeler)).toBe(7);

    state.repoAbrirCompra([
      { ...pirelli, suggested_quantity: 11 },
      { ...metzeler, suggested_quantity: 7 },
    ]);
    expect(state.compraForm.items).toEqual([
      { measure: '90/90-18', brand: 'Pirelli', tire_condition: 'meia_vida',
        quantity: 11, unit_cost: '' },
      { measure: '90/90-18', brand: 'Metzeler', tire_condition: 'meia_vida',
        quantity: 7, unit_cost: '' },
    ]);
  });

  it('usa o disponível nas vendas e na reposição quando há reserva', () => {
    const state = moduleState();
    const pirelli = state.atacadoStock[0];
    Object.assign(pirelli, {
      quantity_on_hand: 10, quantity_reserved: 8, quantity_available: 2,
      min_quantity: 5,
    });
    expect(state.repoSugestao(pirelli)).toBe(3);
    expect(state.repoCobertura(pirelli)).toBe(30);

    Object.assign(pirelli, { quantity_reserved: 10, quantity_available: 0 });
    state.measureFind('90/90', 'venda0');
    expect(state.measureBox.hits.map((row: { brand: string }) => row.brand))
      .toEqual(['Metzeler']);
  });

  it('considera medida e marca ao decidir qual histórico pertence à seleção', () => {
    const state = moduleState();
    state.galpaoFilme.measure = '90/90-18';
    state.galpaoFilme.brand = 'Metzeler';
    state.galpaoFilme.tire_condition = 'meia_vida';
    expect(state.filmeMatches(state.atacadoStock[1])).toBe(true);
    expect(state.filmeMatches(state.atacadoStock[0])).toBe(false);
  });
});

describe('Relatórios de compra com duas marcas na mesma medida', () => {
  it('separa as variantes também no resumo de melhores preços', () => {
    const state: any = {
      ...moduleState(),
      ...painelModule('app.compras.js', 'compras'),
      fornecedorBreakdown: [
        {
          measure: '90/90-18', brand: 'Pirelli', tire_condition: 'meia_vida',
          supplier_id: 'a',
          supplier_name: 'Fornecedor A', avg_cost: 100, qty_total: 2,
        },
        {
          measure: '90/90-18', brand: 'Metzeler', tire_condition: 'meia_vida',
          supplier_id: 'b',
          supplier_name: 'Fornecedor B', avg_cost: 130, qty_total: 3,
        },
      ],
    };

    const groups = state.breakdownByMeasure();
    expect(groups).toHaveLength(2);
    expect(groups.map((group: { brand: string }) => group.brand).sort()).toEqual([
      'Metzeler', 'Pirelli',
    ]);
  });

  it('não mistura custos de marcas diferentes na comparação por fornecedor', () => {
    const state: any = {
      ...moduleState(),
      ...painelModule('app.compras.relatorios.js', 'comprasRelatorios'),
      comprasPriceRows: [
        {
          measure: '90/90-18', brand: 'Pirelli', tire_condition: 'meia_vida',
          supplier_id: 'a',
          supplier_name: 'Fornecedor A', avg_cost: 100, qty_total: 2,
        },
        {
          measure: '90/90-18', brand: 'Metzeler', tire_condition: 'meia_vida',
          supplier_id: 'a',
          supplier_name: 'Fornecedor A', avg_cost: 130, qty_total: 3,
        },
      ],
      comprasPriceSelectedMeasure: null,
    };

    const groups = state.comprasPriceGroups();
    expect(groups).toHaveLength(2);
    expect(groups.map((group: { brand: string }) => group.brand).sort()).toEqual([
      'Metzeler', 'Pirelli',
    ]);
    expect(state.comprasPriceCards().variants).toBe(2);
  });

  it('leva a marca escolhida junto da medida para a nova compra', () => {
    const state: any = {
      ...moduleState(),
      ...painelModule('app.compras.relatorios.js', 'comprasRelatorios'),
      compraForm: {
        supplierKey: '',
        items: [{ measure: '', brand: '', quantity: 1, unit_cost: '' }],
      },
      compraMsg: null,
      comprasOpenTab: vi.fn(),
    };
    const row = {
      measure: '90/90-18', brand: 'Metzeler', tire_condition: 'meia_vida',
      supplier_id: 'supplier-1',
      supplier_name: 'Fornecedor A', supplier_archived: false,
    };

    state.comprasUsePrice(row);

    expect(state.compraForm.supplierKey).toBe('supplier-1');
    expect(state.compraForm.items[0]).toMatchObject({
      measure: '90/90-18', brand: 'Metzeler', tire_condition: 'meia_vida',
    });
    expect(state.comprasOpenTab).toHaveBeenCalledWith('nova');
  });
});
