import fs from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { requiredMatrixModules } from '../../../src/admin/panel-modules.js';

function app() {
  const storage = new Map<string, string>();
  const window: any = { PAINEL_MODULES: {} };
  const sessionStorage = { getItem: (key: string) => storage.get(key),
    setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) };
  vm.runInNewContext(fs.readFileSync('painel/public/app.estoque.lotes.js', 'utf8'),
    { window, sessionStorage, URLSearchParams, crypto: { randomUUID }, Intl });
  const state: any = { adminUser: { id: 'test', role: 'owner' }, serverEnvironment: 'test',
    $nextTick: vi.fn(), apiGet: vi.fn(), apiPost: vi.fn(), loadAtacado: vi.fn(),
    tireLots: { request: 0, rows: [], page: 1, status: 'open', search: '', selectedId: null,
      sources: [{ id: 'stock', available_quantity: 10, unit_cost: 5 }],
      form: { stock_id: 'stock', description: 'Triagem', quantity: 6, reason: 'Separação da triagem' } } };
  Object.defineProperties(state, Object.getOwnPropertyDescriptors(window.PAINEL_MODULES.estoqueLotes()));
  return state;
}

describe('estoque de lotes', () => {
  it('separa permissões de estoque e compra de origem', () => {
    for (const route of ['lots', 'lot-movements', 'lot-separation-sources', 'lot-separations']) {
      expect(requiredMatrixModules('/admin/api/wholesale/' + route)).toEqual(['estoque']);
    }
    expect(requiredMatrixModules('/admin/api/wholesale/lots/id/purchase')).toEqual(['compras']);
    expect(requiredMatrixModules('/admin/api/wholesale/lot-purchases')).toEqual(['compras']);
  });
  it('ignora a resposta antiga quando a busca mais recente já terminou', async () => {
    const state = app(); let finish: (data: any) => void = () => {};
    state.apiGet.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const old = state.tireLotsLoad();
    state.tireLots.search = 'LT-002';
    state.apiGet.mockResolvedValueOnce({ rows: [{ id: 'new' }], total: 1, summary: { open_lots: 2 } });
    await state.tireLotsLoad(); finish({ rows: [{ id: 'old' }], total: 1 }); await old;
    expect(state.tireLotSelected.id).toBe('new');
  });
  it('remove o detalhe e os indicadores quando a consulta falha', async () => {
    const state = app(); state.tireLots.rows = [{ id: 'a' }]; state.tireLots.selectedId = 'a';
    state.apiGet.mockRejectedValue(new Error('offline')); await state.tireLotsLoad();
    expect(state.tireLotSelected).toBeNull(); expect(state.tireLots.summary).toBeNull();
    expect(state.tireLots.error).toContain('Não foi possível');
  });
  it('repete a mesma separação após timeout e não anuncia falha por erro na atualização posterior', async () => {
    const state = app();
    state.apiPost.mockRejectedValueOnce(new Error('timeout')).mockResolvedValueOnce({ id: 'lot' });
    await state.tireLotSeparationSubmit();
    const original = { ...state.tireLots.pending };
    expect(original.quantity).toBe(6); expect(original.idempotency_key).toBeTruthy();
    state.tireLotsLoad = vi.fn(); state.tireLotsLoadMovements = vi.fn();
    state.loadAtacado.mockRejectedValue(new Error('refresh unavailable'));
    state.tireLots.form.quantity = 9;
    await state.tireLotSeparationSubmit();
    expect(state.apiPost.mock.calls[1][1]).toEqual(original);
    expect(state.tireLots.pending).toBeNull(); expect(state.tireLots.separationError).toBe('');
  });
  it('impede separação superior ao disponível antes de enviar', async () => {
    const state = app(); state.tireLots.form.quantity = 11;
    await state.tireLotSeparationSubmit(); expect(state.apiPost).not.toHaveBeenCalled();
  });
  it('apresenta o centavo residual na separação parcial, como o banco', () => {
    const state = app();
    state.tireLots.sources = [{ id: 'stock', quantity_on_hand: 2, available_quantity: 2, unit_cost: '33.333333' }];
    state.tireLots.form.quantity = 1;
    expect(state.tireLotSeparationCost).toBe(33.34);
  });
});
