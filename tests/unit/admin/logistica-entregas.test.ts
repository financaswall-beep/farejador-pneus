import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
function app() {
  const ctx = vm.createContext({ window: {}, Date, Intl, URLSearchParams, console });
  for (const name of ['logistica', 'logistica.resultado', 'logistica.operacao', 'logistica.entregas']) {
    vm.runInContext(readFileSync(`painel/public/app.${name}.js`, 'utf8'), ctx);
  }
  const s: any = { logistica: { abertas: [], rotas_abertas: [] }, logisticaPeriodo: 'hoje',
    logisticaTab: 'entregas', logisticaSaving: false, rotaForm: { selecionadas: {} },
    $nextTick: vi.fn(), remarcarEntrega: vi.fn() };
  for (const factory of Object.values(ctx.window.PAINEL_MODULES) as (() => object)[]) Object.assign(s, factory());
  s.logEntFiltros.from = '2026-09-01'; s.logEntFiltros.to = '2026-09-30';
  return s;
}
const row = { order_id: '1', order_number: '1084', delivery_status: 'pending', status: 'open', scheduled_date: '2026-09-17' };
const page = (rows = [row], n = 1) => ({ rows, page: n, total: rows.length, couriers: [], counts: { all: rows.length } });
describe('Entregas — consulta e ações', () => {
  it('envia filtros e paginação ao servidor, com busca codificada', async () => {
    const s = app(); s.logEntFiltros.q = 'José & #1084'; s.logEntPagina = 2;
    s.apiGet = vi.fn().mockResolvedValue(page([row], 2));
    await s.logEntCarregar();
    const url = new URL(s.apiGet.mock.calls[0][0], 'http://localhost');
    expect(url.searchParams.get('q')).toBe('José & #1084');
    expect(url.searchParams.get('page')).toBe('2'); expect(url.searchParams.get('page_size')).toBe('8');
    expect(s.logEntSelecionada()?.order_id).toBe('1');
  });
  it('ignora uma resposta lenta de filtros anteriores', async () => {
    const s = app(); let first: any;
    s.apiGet = vi.fn().mockImplementationOnce(() => new Promise(resolve => { first = resolve; })).mockResolvedValue(page([{ ...row, order_id: 'new' }]));
    const old = s.logEntCarregar(); await s.logEntFiltrar(); first(page()); await old;
    expect(s.logEntSelecionadaId).toBe('new'); expect(s.logEntCarregando).toBe(false);
  });
  it('valida o intervalo, reseta página e limpa seleção obsoleta', async () => {
    const s = app(); s.apiGet = vi.fn().mockResolvedValue(page([])); s.logEntPagina = 4; s.logEntSelecionadaId = 'old';
    await s.logEntFiltrar(); expect(s.logEntPagina).toBe(1); expect(s.logEntSelecionada()).toBeNull();
    s.logEntFiltros.to = '2025-01-01'; await s.logEntFiltrar(); expect(s.apiGet).toHaveBeenCalledTimes(1); expect(s.logEntErro).toContain('período válido');
  });
  it('preserva dados numa falha de atualização e bloqueia remarcação com dados desatualizados', async () => {
    const s = app(); s.logEntDados = page(); s.logEntSelecionadaId = '1'; s.logEntNovaData = '2026-09-19';
    s.apiGet = vi.fn().mockRejectedValue(new Error('offline')); await s.logEntCarregar(); await s.logEntRemarcar();
    expect(s.logEntDados.rows).toHaveLength(1); expect(s.logEntErro).toContain('anteriores'); expect(s.remarcarEntrega).not.toHaveBeenCalled();
  });
  it('remarca apenas entregas elegíveis e não duplica salvamento', async () => {
    const s = app(); s.logEntDados = page(); s.logEntSelecionadaId = '1'; s.logEntNovaData = '2026-09-19';
    await s.logEntRemarcar(); expect(s.remarcarEntrega).toHaveBeenCalledWith(row, '2026-09-19');
    s.remarcarEntrega.mockClear(); s.logisticaSaving = true; await s.logEntRemarcar();
    s.logisticaSaving = false; s.logEntDados.rows = [{ ...row, delivery_status: 'delivered' }]; await s.logEntRemarcar();
    expect(s.remarcarEntrega).not.toHaveBeenCalled();
    expect(s.logEntPodeRemarcar({ ...row, status: 'cancelled' })).toBe(false);
    expect(s.logEntStatus({ ...row, status: 'cancelled' })).toBe('failed');
  });
  it('leva uma entrega futura à fila correta e uma entrega em rota à rota selecionada', () => {
    const s = app(); s.logEntVerOperacao({ ...row, scheduled_date: '2030-02-01' });
    expect(s.logisticaTab).toBe('visao'); expect(s.logOpDiaFoco).toBe('2030-02-01'); expect(s.logisticaDentroPeriodo({ ...row, scheduled_date: '2030-02-01' })).toBe(true);
    s.logistica.rotas_abertas = [{ id: 'trip2' }]; s.logEntVerOperacao({ ...row, trip_id: 'trip2' });
    expect(s.logisticaRotaAbertaId).toBe('trip2'); expect(s.logOpDiaFoco).toBe('');
  });
  it('os indicadores abrem Entregas com situação e período correspondentes', () => {
    const s = app(); s.logEntFiltrar = vi.fn(); s.logisticaPeriodo = 'amanha';
    s.setLogisticaFiltro('entregues', true); expect(s.logEntFiltros).toMatchObject({ status: 'delivered', from: s.amanhaISO(), to: s.amanhaISO() });
    s.setLogisticaTab('rotas'); expect(s.logisticaTab).toBe('historico');
  });
});
