import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function locations() {
  const context = vm.createContext({ window: {} });
  vm.runInContext(readFileSync('painel/public/app.galpao.grupos.js', 'utf8'), context);
  const state = context.window.PAINEL_MODULES.galpaoGrupos();
  state.apiGet = vi.fn();
  return state;
}

const pair = { stock_id: 'a', group_id: 'par', matched_set: true, model: 'Primacy', quantity_on_hand: 2,
  positions: [{ location_code: 'B2', quantity_on_hand: 1, quantity_reserved: 1 },
    { location_code: 'C2', quantity_on_hand: 1, quantity_reserved: 0 }] };
const loose = { stock_id: 'a', group_id: 'avulso', quantity_on_hand: 1,
  positions: [{ location_code: 'B2', quantity_on_hand: 1, quantity_reserved: 0 }] };
const data = { groups: [pair, loose], stock: [{ stock_id: 'a', quantity_on_hand: 4 }] };

describe('localização no Painel da medida', () => {
  it('consulta a variante selecionada e preserva a identidade dos conjuntos, das pilhas e das reservas', async () => {
    const state = locations();
    const pending = { stock_id: 'a', group_id: 'pendente', origin_pending: true, quantity_on_hand: 0, positions: [] };
    state.apiGet.mockResolvedValue({ ...data, groups: [...data.groups, pending,
      { stock_id: 'a', group_id: 'esgotado', quantity_on_hand: 0, positions: [] }, { ...pair, stock_id: 'b' }] });
    await state.sgReadMeasureLocations('a');
    expect(state.apiGet.mock.calls).toEqual([['/admin/api/wholesale/stock/groups?stock_id=a']]);
    expect(state.stockGroups.overview).toEqual({ stockId: 'a', status: 'ready', groups: [pair, loose, pending], ungrouped: 1 });
  });

  it('ignora a resposta inicial após trocar de variante e voltar para o mesmo ID', async () => {
    const state = locations();
    const older = Promise.withResolvers<typeof data>();
    state.apiGet.mockReturnValueOnce(older.promise).mockResolvedValueOnce({ groups: [], stock: [] }).mockResolvedValueOnce(data);
    const first = state.sgReadMeasureLocations('a');
    expect(state.stockGroups.overview.status).toBe('loading');
    await state.sgReadMeasureLocations('b');
    await state.sgReadMeasureLocations('a');
    older.resolve({ stock: [], groups: [] });
    await first;
    expect(state.stockGroups.overview.groups).toEqual([pair, loose]);
  });

  it('ao sair descarta falhas tardias, permite nova tentativa e distingue erro de resultado vazio', async () => {
    const state = locations();
    const older = Promise.withResolvers<typeof data>();
    state.apiGet.mockReturnValueOnce(older.promise).mockResolvedValueOnce({}).mockResolvedValueOnce({ stock: [], groups: [] });
    const first = state.sgReadMeasureLocations('a');
    await state.sgReadMeasureLocations('');
    older.reject(new Error('consulta interrompida'));
    await first;
    expect(state.stockGroups.overview.status).toBe('idle');
    expect(state.apiGet).toHaveBeenCalledTimes(1);
    await state.sgReadMeasureLocations('a');
    expect(state.stockGroups.overview.status).toBe('error');
    await state.sgReadMeasureLocations('a');
    expect(state.stockGroups.overview).toEqual({ stockId: 'a', status: 'ready', groups: [], ungrouped: 0 });
  });
});

describe('atalho da ficha para a aba Pilhas e conjuntos', () => {
  const first = { stock_id: 'a', measure: '235/55 R18', brand: 'Michelin', tire_condition: 'meia_vida' };
  const second = { ...first, stock_id: 'b' };
  const list = { groups: [], stock: [first, second] };
  function page() {
    const state = locations();
    state.currentPage = 'estoque';
    state.stockTab = 'visao';
    state.sgOrigins = vi.fn();
    state.$nextTick = vi.fn();
    state.stockVariantKey = (r: typeof first) => [r.measure, r.brand, r.tire_condition].join('/');
    return state;
  }

  it('honra a última ficha pelo ID mesmo com chave igual e clique repetido na aba durante a carga', async () => {
    const state = page();
    const load = Promise.withResolvers<typeof list>();
    state.apiGet.mockReturnValue(load.promise);
    const a = state.sgOpen(first);
    state.stockTab = 'visao';
    const b = state.sgOpen(second);
    const tab = state.sgOpen();
    expect(state.stockGroups.stockId).toBe('');
    load.resolve(list);
    await Promise.all([a, b, tab]);
    expect(state.apiGet).toHaveBeenCalledTimes(1);
    expect(state.stockGroups.stockId).toBe('b');
    expect(state.$nextTick).toHaveBeenCalledTimes(1);
  });

  it('não associa ID desaparecido nem usa chave antiga ambígua; aceita produtos da mesma variante legada', async () => {
    const state = page();
    state.apiGet.mockResolvedValue(list);
    await state.sgOpen({ ...first, stock_id: 'desapareceu' });
    expect(state.stockGroups.stockId).toBe('');
    await state.sgOpen({ ...first, stock_id: undefined });
    expect(state.stockGroups.stockId).toBe('');
    state.apiGet.mockResolvedValue({ groups: [], stock: [{ ...first, product_id: '1' }, { ...first, product_id: '2' }] });
    await state.sgOpen({ ...first, stock_id: undefined });
    expect(state.stockGroups.stockId).toBe('a');
  });

  it('descarta a intenção de abrir uma ficha se a pessoa volta pela aba sem selecionar uma medida', async () => {
    const state = page();
    const load = Promise.withResolvers<typeof list>();
    state.apiGet.mockReturnValue(load.promise);
    const fromMeasure = state.sgOpen(second);
    state.stockTab = 'visao';
    const fromTab = state.sgOpen();
    load.resolve(list);
    await Promise.all([fromMeasure, fromTab]);
    expect(state.stockGroups.stockId).toBe('');
    expect(state.$nextTick).not.toHaveBeenCalled();
  });

  it('uma atualização pós-gravação aguarda a consulta anterior e busca o resultado atualizado', async () => {
    const state = page();
    const load = Promise.withResolvers<typeof list>();
    state.apiGet.mockReturnValueOnce(load.promise).mockResolvedValueOnce({ groups: [], stock: [second] });
    const firstRead = state.sgLoad();
    const afterWrite = state.sgLoad(true);
    load.resolve(list);
    await Promise.all([firstRead, afterWrite]);
    expect(state.apiGet).toHaveBeenCalledTimes(2);
    expect(state.stockGroups.stock).toEqual([second]);
  });
});
