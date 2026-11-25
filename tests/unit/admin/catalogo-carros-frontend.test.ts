import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const car = { vehicle_type: 'car', vehicle_model_id: 'veiculo', make: 'Toyota', model: 'Hilux',
  variant: 'SRX', year_start: 2021, year_end: 2025 };
const reference = { tire_size: '265/60 R18', source_url: 'https://manual.example/pneus',
  position: 'rear', year_start: '2022', year_end: '2023', index_spec: '110H' };

function panel(type: string | null = 'car') {
  const sandbox = { window: {}, URL };
  for (const module of ['compatibilidade', 'carros', 'descobertas']) {
    vm.runInNewContext(readFileSync('painel/public/app.catalogo.' + module + '.js', 'utf8'), sandbox);
  }
  const methods = vm.runInNewContext('Object.assign({}, ...Object.values(window.PAINEL_MODULES).map(fn => fn()))', sandbox);
  return { ...methods, catalogoCompatibilidade: methods.catalogoCompatibilityState({
    vehicle_type: type, product_id: 'pneu', tire_size: '265/60-18',
  }), $nextTick: vi.fn(), adminUser: { role: 'owner' }, apiGet: vi.fn(), apiPost: vi.fn(),
    catalogoCompatibilityLoad: vi.fn(methods.catalogoCompatibilityLoad), loadCatalogo: vi.fn() };
}

describe('compatibilidade de veículos na ficha da Matriz', () => {
  it('cadastra o modelo e registra a referência em ações independentes, sem salvar vínculo', async () => {
    const view = panel();
    const state = view.catalogoCompatibilidade;
    state.loading = false;
    view.apiGet.mockResolvedValue({ applications: [] });
    view.catalogoCarStartModel();
    Object.assign(state.carModel, car);
    view.apiPost.mockResolvedValueOnce({ created: true, vehicle: car });
    await view.catalogoCarCreate();
    expect(view.apiPost).toHaveBeenCalledExactlyOnceWith('/admin/api/catalog/vehicle-models', {
      vehicle_type: 'car', make: 'Toyota', model: 'Hilux', variant: 'SRX', year_start: 2021, year_end: 2025,
    });
    expect(state.selectedVehicle).toEqual(car);
    expect(state.carReference).toMatchObject({ tire_size: '265/60-18', position: '', source_url: '', year_start: 2021, year_end: 2025 });
    state.form.reason = 'Manual';
    expect(view.catalogoCompatibilityCanSave()).toBe(false);
    Object.assign(state.carReference, reference);
    view.apiPost.mockResolvedValueOnce({ created: 1 });
    await view.catalogoCarSaveReference();
    expect(view.apiPost).toHaveBeenLastCalledWith('/admin/api/catalog/pneu/measure-applications', {
      ...reference, year_start: 2022, year_end: 2023, vehicle_model_id: car.vehicle_model_id,
    });
    expect(view.apiPost).toHaveBeenCalledTimes(2);
    expect(view.catalogoCompatibilityLoad).toHaveBeenCalledWith('pneu');
    expect(view.loadCatalogo).toHaveBeenCalledOnce();
    expect(state.selectedVehicle).toBeNull();
  });

  it('cadastra um único ano e salva a referência só escolhendo o eixo', async () => {
    const view = panel();
    const state = view.catalogoCompatibilidade;
    state.loading = false;
    state.row.tire_size = '265/60R18';
    view.catalogoCarStartModel();
    Object.assign(state.carModel, { make: car.make, model: car.model, year_start: '2024' });
    view.apiPost.mockResolvedValueOnce({ created: true, vehicle: { ...car, year_start: 2024, year_end: 2024 } });
    expect(view.catalogoCarCanCreate()).toBe(true);
    await view.catalogoCarCreate();
    expect(view.apiPost).toHaveBeenCalledWith('/admin/api/catalog/vehicle-models', expect.objectContaining({
      year_start: 2024, year_end: 2024,
    }));
    state.carReference.position = 'both';
    view.apiPost.mockResolvedValueOnce({ created: 2 });
    view.apiGet.mockResolvedValue({ applications: [] });
    await view.catalogoCarSaveReference();
    expect(view.apiPost).toHaveBeenLastCalledWith('/admin/api/catalog/pneu/measure-applications', {
      vehicle_model_id: car.vehicle_model_id, tire_size: '265/60R18', year_start: 2024, year_end: 2024,
      position: 'both', source_url: null, index_spec: null,
    });
  });

  it.each([
    { year_start: null, year_end: 2025, missing: 'year_start', known: 'year_end' },
    { year_start: 2021, year_end: null, missing: 'year_end', known: 'year_start' },
  ] as const)('pede só o limite ausente no cadastro antigo ($missing)', ({ year_start, year_end, missing, known }) => {
    const view = panel();
    view.catalogoCompatibilidade.loading = false;
    view.catalogoCompatibilitySelectVehicle({ ...car, year_start, year_end });
    const form = view.catalogoCompatibilidade.carReference;
    expect(form.tire_size).toBe('265/60-18');
    expect(form[known]).toBe(car[known]);
    expect(form[missing]).toBe('');
    form.position = 'front';
    expect(view.catalogoCarCanSaveReference()).toBe(false);
    form[missing] = 2024;
    expect(view.catalogoCarCanSaveReference()).toBe(true);
  });

  it.each(['', '   '])('registra a referência quando o campo de link está em branco (%j)', async sourceUrl => {
    const view = panel();
    view.catalogoCompatibilidade.loading = false;
    view.catalogoCompatibilitySelectVehicle(car);
    Object.assign(view.catalogoCompatibilidade.carReference, reference, { source_url: sourceUrl });
    view.apiPost.mockResolvedValue({ created: 1 });
    view.apiGet.mockResolvedValue({ applications: [] });
    expect(view.catalogoCarCanSaveReference()).toBe(true);
    await view.catalogoCarSaveReference();
    expect(view.apiPost).toHaveBeenCalledExactlyOnceWith('/admin/api/catalog/pneu/measure-applications', {
      ...reference, source_url: null, year_start: 2022, year_end: 2023, vehicle_model_id: car.vehicle_model_id,
    });
  });

  it('valida o link preenchido, a posição e o período coberto pelo modelo antes de enviar', async () => {
    const view = panel();
    const state = view.catalogoCompatibilidade;
    state.loading = false;
    view.catalogoCompatibilitySelectVehicle(car);
    for (const invalid of [{ year_end: 2020 }, { year_start: 2018 }, { year_end: 2027 },
      { year_start: '' }, { source_url: 'inválido' }, { source_url: 'http://manual.example' },
      { source_url: 'https://usuario:senha@manual.example' }, { position: '' }]) {
      Object.assign(state.carReference, reference, invalid);
      expect(view.catalogoCarCanSaveReference()).toBe(false);
      await view.catalogoCarSaveReference();
    }
    expect(view.apiPost).not.toHaveBeenCalled();
    Object.assign(state.carReference, reference);
    state.carAction = 'fitment';
    expect(view.catalogoCarCanSaveReference()).toBe(false);
    state.form.reason = 'Conferido no fabricante';
    expect(view.catalogoCompatibilityCanSave()).toBe(true);
  });

  it('pede apenas referências sem categoria ao abrir uma medida ainda sem classificação', async () => {
    const view = panel(null);
    view.catalogoCompatibilidade.row.product_id = null;
    view.apiGet.mockResolvedValue({ applications: [] });
    await view.catalogoCompatibilityLoad();
    expect(view.apiGet).toHaveBeenCalledWith('/admin/api/catalog/measure-applications?measure=265%2F60-18&vehicle_type=unknown');
  });

  it('reserva escrita automotiva para o dono, com SKU de carro, e mantém a busca de motos', async () => {
    for (const type of ['motorcycle', null, 'car']) {
      const view = panel(type);
      const state = view.catalogoCompatibilidade;
      state.loading = false;
      if (type === 'car') view.adminUser.role = 'employee';
      view.catalogoCarStartModel();
      await view.catalogoCarCreate();
      expect(state.carModel).toBeNull();
      expect(view.apiPost).not.toHaveBeenCalled();
      state.search = 'Honda';
      view.apiGet.mockResolvedValue({ rows: [] });
      await view.catalogoCompatibilitySearch();
      if (type) expect(view.apiGet).toHaveBeenCalledWith('/admin/api/catalog/vehicle-models?q=Honda&vehicle_type=' + type);
      else expect(view.apiGet).not.toHaveBeenCalled();
    }
    const view = panel();
    view.catalogoCompatibilidade.row.product_id = null;
    view.catalogoCompatibilidade.loading = false;
    view.catalogoCarStartModel();
    expect(view.catalogoCompatibilidade.carModel).toBeNull();
  });

  it('descarta resposta de busca atrasada e limpa a fonte ao mudar de modelo', async () => {
    const view = panel();
    const state = view.catalogoCompatibilidade;
    let finish!: (result: unknown) => void;
    state.loading = false;
    state.search = 'To';
    view.apiGet.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const pending = view.catalogoCompatibilitySearch();
    view.catalogoCompatibilityResetSearch();
    state.search = 'Hilux';
    view.apiGet.mockResolvedValueOnce({ rows: [car] });
    await view.catalogoCompatibilitySearch();
    finish({ rows: [{ model: 'Etios' }] });
    await pending;
    expect(state.searchRows).toEqual([car]);
    view.catalogoCompatibilitySelectVehicle(car);
    Object.assign(state.carReference, reference);
    view.catalogoCompatibilitySelectVehicle({ ...car, variant: 'SR', year_start: 2016, year_end: 2020 });
    expect(state.carReference.source_url).toBe('');
    expect(state.carReference).toMatchObject({ tire_size: '265/60-18', position: '', year_start: 2016, year_end: 2020 });
  });
});
