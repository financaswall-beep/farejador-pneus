import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function painelModule(file: string, name: string) {
  const sandbox: any = { window: { PAINEL_MODULES: {} }, console, URLSearchParams };
  vm.runInNewContext(readFileSync(resolve(`painel/public/${file}`), 'utf8'), sandbox);
  return sandbox.window.PAINEL_MODULES[name]();
}

function moduleState() {
  const methods = {
    ...painelModule('app.compras.reposicao.js', 'comprasReposicao'),
    ...painelModule('app.galpao.multibrand.js', 'galpaoMultibrand'),
  };
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

  it('conta a necessidade do estoque uma vez por medida e condição', () => {
    const state: any = {
      ...moduleState(),
      ...painelModule('app.galpao.js', 'galpao'),
    };
    state.atacadoStock.forEach((row: any) => { row.min_quantity = 80; });

    expect(state.stockResumo()).toMatchObject({
      pneus: 65, capital: 1030, repor: 1, zeradas: 0,
    });
    state.atacadoStock.forEach((row: any) => { row.min_quantity = 65; });
    expect(state.stockResumo().repor).toBe(0);
  });

  it('soma marcas na reposição e preserva a marca recomendada na compra', () => {
    const state = moduleState();
    const pirelli = state.atacadoStock[0];
    const metzeler = state.atacadoStock[1];
    expect(state.repoGiro(pirelli)).toBe(5);
    expect(state.repoGiro(metzeler)).toBe(2);
    state.galpaoFilme.rows.push({ measure: '90/90-18', brand: 'Pirelli',
      tire_condition: 'meia_vida', source: 'venda_atacado', qty_delta: -999 });
    expect(state.repoGiro(pirelli)).toBe(5);

    Object.assign(pirelli, { min_quantity: 80 });
    Object.assign(metzeler, { min_quantity: 80 });
    state.fornecedorBreakdown = [{
      measure: '90/90-18', brand: 'Metzeler', tire_condition: 'meia_vida',
      supplier_id: 's1', supplier_name: 'Fornecedor B', avg_cost: 12, qty_total: 3,
    }];
    const plan = state.repoRows();
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({
      measure: '90/90-18', brand: 'Metzeler', tire_condition: 'meia_vida',
      quantity_available: 65, suggested_quantity: 15,
    });
    state.repoDefinirQuantidade(plan[0], 11);
    expect(state.repoQuantidade(plan[0])).toBe(11);

    state.repoAbrirCompra([{ ...plan[0], suggested_quantity: 11 }]);
    expect(state.compraForm.items).toEqual([
      { measure: '90/90-18', brand: 'Metzeler', tire_condition: 'meia_vida',
        quantity: 11, unit_cost: '' },
    ]);
  });

  it('usa o disponível nas vendas e na reposição quando há reserva', () => {
    const state = moduleState();
    const pirelli = state.atacadoStock[0];
    Object.assign(pirelli, {
      quantity_on_hand: 10, quantity_reserved: 8, quantity_available: 2,
      min_quantity: 5,
    });
    Object.assign(pirelli, { replenishment_quantity_available: 2 });
    expect(state.repoSugestao({ ...pirelli, quantity_available: 2 })).toBe(3);
    expect(state.repoCobertura(pirelli)).toBe(30);

    Object.assign(pirelli, { quantity_reserved: 10, quantity_available: 0 });
    state.measureFind('90/90', 'venda0');
    expect(state.measureBox.hits.map((row: { brand: string }) => row.brand))
      .toEqual(['Metzeler']);
  });

  it('não recomenda comprar de novo o que já está em trânsito', () => {
    const state = moduleState();
    const pirelli = state.atacadoStock[0];
    Object.assign(pirelli, {
      quantity_on_hand: 10, quantity_reserved: 8, quantity_available: 2,
      min_quantity: 5, in_transit_quantity: 2,
    });
    expect(state.repoSugestao(pirelli)).toBe(1);
    Object.assign(pirelli, { in_transit_quantity: 3 });
    expect(state.repoSugestao(pirelli)).toBe(0);
    expect(state.repoRows()).not.toContain(pirelli);
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
  it('mantém custo médio geral ponderado e desenha a série dinâmica do histórico', () => {
    const state: any = {
      ...moduleState(),
      ...painelModule('app.compras.relatorios.js', 'comprasRelatorios'),
      ...painelModule('app.compras.historico.js', 'comprasHistorico'),
      comprasHistoryAnalytics: {
        summary: {
          total_committed: '22.00', paid_amount: '0.00', open_amount: '22.00',
          tires: 2, received_tires: 0, in_transit_tires: 2, active_suppliers: 1,
          average_cost: '11.00', previous_average_cost: '10.00',
          average_change_pct: '10.0', minimum_item_cost: '11.00',
          maximum_item_cost: '11.00', purchases_count: 1,
        },
        timeline: [
          { bucket: '2026-08-01', total_committed: '10.00', tires: 1,
            received_tires: 1, average_cost: '10.00' },
          { bucket: '2026-08-25', total_committed: '22.00', tires: 2,
            received_tires: 0, average_cost: '11.00' },
        ],
      },
      comprasHistoryFilters: { period: '30d', supplierId: '' },
    };

    expect(state.comprasHistorySummary()).toMatchObject({
      committed: 22, open: 22, tires: 2, average: 11, previousAverage: 10,
      averageChange: 10,
    });
    expect(state.comprasHistoryChartPoints('average_cost')).toMatch(/,/);
    expect(state.comprasHistoryAverageChangeLabel()).toContain('10,0%');
  });

  it('mantém a análise de custo isolada dos filtros e dados do gráfico principal', async () => {
    const methods = painelModule('app.compras.historico.js', 'comprasHistorico');
    const mainAnalytics = {
      summary: { total_committed: '80.00', average_cost: '20.00' },
      timeline: [{ bucket: '2026-08-01', total_committed: '80.00', tires: 4,
        received_tires: 4, average_cost: '20.00' }],
    };
    const costAnalytics = {
      summary: { total_committed: '30.00', average_cost: '10.00' },
      timeline: [{ bucket: '2026-06-01', total_committed: '30.00', tires: 3,
        received_tires: 2, average_cost: '10.00' }],
    };
    const apiGet = vi.fn().mockResolvedValue(costAnalytics);
    const state: any = {
      ...methods,
      comprasHistoryAnalytics: mainAnalytics,
      comprasHistoryFilters: { period: '30d', supplierId: 'fornecedor-principal' },
      comprasCost: {
        analytics: { summary: null, timeline: [] },
        filters: { period: '90d', supplierId: 'fornecedor-custo' },
        loading: false,
        error: null,
      },
      apiGet,
    };

    await state.loadComprasCostAnalysis();

    expect(apiGet).toHaveBeenCalledWith(expect.stringContaining('period=90d'));
    expect(apiGet).toHaveBeenCalledWith(expect.stringContaining(
      'supplier_id=fornecedor-custo',
    ));
    expect(state.comprasCost.analytics).toEqual(costAnalytics);
    expect(state.comprasHistoryAnalytics).toBe(mainAnalytics);
    expect(state.comprasHistoryFilters).toEqual({
      period: '30d', supplierId: 'fornecedor-principal',
    });
  });

  it('mostra no ponto do gráfico o valor e a situação do recebimento', () => {
    const methods = painelModule('app.compras.historico.js', 'comprasHistorico');
    const state: any = {
      ...methods,
      comprasHistoryHoverIndex: 1,
      comprasHistoryAnalytics: {
        timeline: [
          { bucket: '2026-08-01', total_committed: '10.00', tires: 1,
            received_tires: 1 },
          { bucket: '2026-08-25', total_committed: '44.00', tires: 4,
            received_tires: 2 },
        ],
      },
    };

    expect(state.comprasHistoryHoveredRow().bucket).toBe('2026-08-25');
    expect(state.comprasHistoryHoverDetail(state.comprasHistoryHoveredRow()))
      .toBe('2 recebidos · 2 em trânsito');
    expect(state.comprasHistoryHoverStyle()).toMatch(/^left:\d+(?:\.\d+)?%$/);
  });

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

  it('simula economia somente entre fornecedores da variante selecionada', () => {
    const state: any = {
      ...moduleState(),
      ...painelModule('app.compras.relatorios.js', 'comprasRelatorios'),
      comprasPriceRows: [
        { measure: '110/70-13', brand: 'IRA', tire_condition: 'meia_vida',
          supplier_id: 'a', supplier_name: 'Thiago', avg_cost: 5, qty_total: 5 },
        { measure: '110/70-13', brand: 'IRA', tire_condition: 'meia_vida',
          supplier_id: 'b', supplier_name: 'Cicero', avg_cost: 10, qty_total: 1 },
        { measure: '110/70-13', brand: 'Pirelli', tire_condition: 'meia_vida',
          supplier_id: 'c', supplier_name: 'Outro', avg_cost: 1, qty_total: 9 },
      ],
      comprasPriceSelectedMeasure: '110/70-13\u0000ira\u0000meia_vida',
      comprasPriceQuantity: 10,
    };

    const selected = state.comprasPriceGroups().find((row: { brand: string }) => row.brand === 'IRA');
    state.comprasPriceSelectedMeasure = selected.variant_key;
    const cards = state.comprasPriceCards();

    expect(cards.suppliers).toBe(2);
    expect(cards.best.supplier_name).toBe('Thiago');
    expect(cards.difference).toBe(5);
    expect(cards.total).toBe(50);
    expect(cards.savings).toBe(50);
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
