import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { requiredMatrixModules } from '../../../src/admin/panel-modules.js';
function app() {
  const window: any = { PAINEL_MODULES: {} };
  vm.runInNewContext(fs.readFileSync('painel/public/app.estoque.custos.js', 'utf8'), { window, Intl, URLSearchParams });
  const state: any = { stockTab: 'custos', isMatrixPanel: () => true, $nextTick: vi.fn(), apiGet: vi.fn(), tireLotsOpen: vi.fn(),
    stockCosts: { data: null, request: 0, mode: 'catalog', condition: '', search: '', detail: null }, tireLots: {} };
  Object.defineProperties(state, Object.getOwnPropertyDescriptors(window.PAINEL_MODULES.estoqueCustos()));
  return state;
}
describe('custos do estoque', () => {
  it('exige permissão de estoque na rota de custos', () => {
    expect(requiredMatrixModules('/admin/api/wholesale/stock/costs')).toEqual(['estoque']);
  });
  it('descarta resposta antiga e remove valores anteriores quando a consulta falha', async () => {
    const state = app(); let finish: (data: any) => void = () => {};
    state.apiGet.mockReturnValueOnce(new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce({ catalog: ['new'] });
    const old = state.loadStockCostsPage(); await state.loadStockCostsPage(); finish({ catalog: ['old'] }); await old;
    expect(state.stockCosts.data.catalog).toEqual(['new']);
    state.apiGet.mockRejectedValueOnce(new Error('offline')); await state.loadStockCostsPage();
    expect(state.stockCosts.data).toBeNull(); expect(state.stockCosts.error).toContain('Não foi possível');
  });
  it('filtra condições só no catálogo, exporta o recorte e neutraliza fórmulas em descrições', () => {
    const state = app();
    state.stockCosts.data = { as_of: '2026-09-15T12:00:00Z', catalog: [
      { measure: '130/70-13', tire_condition: 'novo', capital: 10.1, quantity_on_hand: 2, quantity_reserved: 1, quantity_available: 1 },
      { measure: '90/90-12', tire_condition: 'meia_vida', capital: 20.2, quantity_on_hand: 3, quantity_reserved: 0, quantity_available: 3 }
    ], lots: [{ id: 'lot', lot_code: 'LT-900', description: '=HYPERLINK("malicious")', capital: 0.3, quantity_on_hand: 4, quantity_available: 4, quantity_reserved: 0 }] };
    expect(state.scTotals.cents).toBe(3030);
    state.stockCosts.condition = 'novo'; expect(state.scRows).toHaveLength(1);
    expect(state.scCsv()).toContain('130/70-13'); expect(state.scCsv()).not.toContain('90/90-12');
    state.scMode('lots'); expect(state.scRows).toHaveLength(1);
    expect(state.scCsv()).toContain("\"'=HYPERLINK"); expect(state.scCsv()).toContain('Não se aplica');
    state.stockCosts.search = 'lt-900'; expect(state.scRows).toHaveLength(1);
    state.stockCosts.search = 'nenhum'; expect(state.scRows).toHaveLength(0); expect(state.scTotals.cents).toBe(0);
  });
  it('abre o lote escolhido mesmo fora da primeira página atual de lotes', async () => {
    const state = app(); state.tireLots = { page: 4, search: 'antiga', status: 'closed', selectedId: 'old' };
    await state.scLot({ id: 'id-60', lot_code: 'LT-000060' });
    expect(state.tireLots).toEqual({ page: 1, search: 'LT-000060', status: 'open', selectedId: 'id-60' });
    expect(state.tireLotsOpen).toHaveBeenCalledOnce();
  });
});
