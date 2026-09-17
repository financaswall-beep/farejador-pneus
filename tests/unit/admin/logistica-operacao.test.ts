import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function app() {
  const ctx = vm.createContext({ window: {}, console, Date, Intl, location: { pathname: '/admin/painel' } });
  for (const name of ['logistica', 'logistica.resultado', 'logistica.acoes', 'logistica.comprovantes', 'logistica.operacao']) {
    vm.runInContext(readFileSync(`painel/public/app.${name}.js`, 'utf8'), ctx);
  }
  const s: any = {
    logistica: { abertas: [], reportadas: [], finalizadas: [], rotas_abertas: [], rotas_recentes: [], couriers: [] },
    logisticaPeriodo: 'hoje', logisticaTab: 'visao', logisticaBusca: '', logisticaSaving: false,
    rotaForm: { selecionadas: {}, km_start: '', courier_collaborator_id: '' },
    fecharForm: { km_end: '', notes: '' }, receiptUrls: {}, adminUser: { role: 'owner' },
    adminAuthenticated: true, ensureCredentials() {}, $nextTick(fn: () => void) { fn(); },
    $refs: { logOpDialogEl: { close: vi.fn(), showModal: vi.fn() }, logOpUpload: { click: vi.fn() } },
  };
  for (const factory of Object.values(ctx.window.PAINEL_MODULES) as (() => object)[]) {
    Object.defineProperties(s, Object.getOwnPropertyDescriptors(factory()));
  }
  s.loadReceiptThumbs = vi.fn();
  return s;
}
function order(s: any, id: string, override: object = {}) {
  return { order_id: id, order_number: id, delivery_status: 'pending', status: 'confirmed',
    trip_id: null, total_amount: 99, scheduled_date: s.hojeISO(), customer_name: 'Cliente de teste',
    items: [{ quantity: 1, label: '130/70-13' }], ...override };
}

describe('Operação de Logística — seleção e ações reais', () => {
  it('filtra a saída por período e busca sem incluir pedidos cancelados ou já roteados', () => {
    const s = app();
    s.logistica.abertas = [order(s, '1'), order(s, '2', { trip_id: 'r1' }),
      order(s, '3', { status: 'cancelled' }), order(s, '4', { scheduled_date: s.amanhaISO() })];
    expect(s.logOpFila().map((d: any) => d.order_id)).toEqual(['1']);
    s.logOpBusca = '130/70';
    expect(s.logOpFila()).toHaveLength(1);
    s.logOpBusca = 'inexistente';
    expect(s.logOpFila()).toHaveLength(0);
  });
  it('preserva seleção ao buscar, mas limpa ao trocar o período', () => {
    const s = app(); s.logistica.abertas = [order(s, '1')];
    s.rotaForm.selecionadas = { 1: true }; s.logOpBusca = 'outro';
    expect(s.logOpSelecionados()).toHaveLength(1);
    expect(s.logOpTotal()).toBe(99);
    s.logOpPeriodo('amanha');
    expect(s.rotaForm.selecionadas).toEqual({});
  });
  it('descarta pedidos que saíram da fila e entregadores ocupados após atualização', () => {
    const s = app(); s.logistica.abertas = [order(s, '1', { trip_id: 'r1' })];
    s.logistica.couriers = [{ id: 'c1' }]; s.logistica.rotas_abertas = [{ id: 'r1', courier_collaborator_id: 'c1' }];
    s.rotaForm.selecionadas = { 1: true, stale: true }; s.rotaForm.courier_collaborator_id = 'c1';
    s.logOpSincronizar();
    expect(s.rotaForm.selecionadas).toEqual({}); expect(s.rotaForm.courier_collaborator_id).toBe('');
  });
  it('envia somente pedidos elegíveis na abertura e seleciona a rota criada', async () => {
    const s = app(); s.logistica.abertas = [order(s, '1'), order(s, '2', { trip_id: 'old' })];
    s.logistica.couriers = [{ id: 'c1', display_name: 'Entregador' }];
    s.rotaForm = { selecionadas: { 1: true, 2: true, stale: true }, courier_collaborator_id: 'c1', km_start: '40' };
    s.apiPost = vi.fn().mockResolvedValue({ deliveries_count: 1 });
    s.loadLogistica = vi.fn(async () => { s.logistica.rotas_abertas = [{ id: 'new', courier_collaborator_id: 'c1' }]; });
    await s.logOpAbrirRota();
    expect(s.apiPost).toHaveBeenCalledWith('/admin/api/logistica/rotas', { courier_collaborator_id: 'c1', km_start: 40, order_ids: ['1'] });
    expect(s.logisticaRotaAbertaId).toBe('new');
  });
  it('não abre rota vazia, com entregador ocupado ou durante salvamento', async () => {
    const s = app(); s.abrirRota = vi.fn();
    await s.logOpAbrirRota();
    s.logistica.abertas = [order(s, '1')]; s.rotaForm.selecionadas = { 1: true };
    s.logistica.couriers = [{ id: 'c1' }]; s.rotaForm.courier_collaborator_id = 'c1';
    s.logistica.rotas_abertas = [{ id: 'r1', courier_collaborator_id: 'c1' }];
    await s.logOpAbrirRota(); s.logisticaSaving = true; await s.logOpAbrirRota();
    expect(s.abrirRota).not.toHaveBeenCalled();
  });
  it('mantém a rota escolhida no diálogo de inclusão mesmo se a seleção de fundo mudar', async () => {
    const s = app(); s.logistica.rotas_abertas = [{ id: 'r1' }, { id: 'r2' }];
    const d = order(s, '1'); s.logistica.abertas = [d];
    s.logOpDialog = { kind: 'adicionar', id: 'r1' }; s.logisticaRotaAbertaId = 'r2';
    s.apiPost = vi.fn().mockResolvedValue({}); s.loadLogistica = vi.fn();
    await s.logOpAdicionar(d);
    expect(s.apiPost).toHaveBeenCalledWith('/admin/api/logistica/rotas/pendurar', { order_id: '1', trip_id: 'r1' });
    expect(s.$refs.logOpDialogEl.close).toHaveBeenCalled();
  });
  it('barra fechamento com entregas em andamento ou KM inválido; permite ocorrências pendentes', async () => {
    const s = app(); const trip = { id: 'r1', km_start: 100, remaining_count: 1 };
    s.logistica.rotas_abertas = [trip]; s.logOpDialog = { kind: 'fechar', id: 'r1' };
    s.fecharRota = vi.fn(); await s.logOpFecharRota(); expect(s.fecharRota).not.toHaveBeenCalled();
    trip.remaining_count = 0; s.fecharForm.km_end = '99';
    await s.logOpFecharRota(); expect(s.fecharRota).not.toHaveBeenCalled();
    s.logistica.reportadas = [order(s, '1', { trip_id: 'r1', delivery_status: 'failed' })];
    s.fecharForm.km_end = '120'; await s.logOpFecharRota(); expect(s.fecharRota).toHaveBeenCalledWith(trip);
  });
  it('fecha o diálogo mesmo quando a atualização remove a linha que iniciou a ação', async () => {
    const s = app(); const dialog = s.$refs.logOpDialogEl;
    const d = order(s, '1'); s.logistica.abertas = [d]; s.logistica.rotas_abertas = [{ id: 'r1' }];
    s.logOpDialog = { kind: 'adicionar', id: 'r1' };
    s.pendurarNaRota = vi.fn(async () => { s.$refs = {}; s.logisticaMsg = { ok: true }; });
    await s.logOpAdicionar(d);
    expect(dialog.close).toHaveBeenCalled(); expect(s.logOpDialog.kind).toBe('');
  });
  it('revisão inclui ocorrências antigas e exclui canceladas, independente do período', () => {
    const s = app(); s.logistica.reportadas = [order(s, '1', { scheduled_date: '2020-01-01', delivery_status: 'failed' }), order(s, '2', { status: 'cancelled', delivery_status: 'failed' })];
    expect(s.logOpOcorrencias().map((d: any) => d.order_id)).toEqual(['1']);
  });
  it('expõe comprovantes somente ao owner com flag e revisão pendente', () => {
    const s = app(); s.logistica.receipt_approval = true;
    s.logistica.rotas_recentes = [{ id: 'r1', receipts: [{ id: 'a', workflow_status: 'review_required' }, { id: 'b', workflow_status: 'linked' }] }];
    expect(s.logOpComprovantes()).toHaveLength(1);
    s.adminUser.role = 'admin'; expect(s.logOpComprovantes()).toEqual([]);
    s.adminUser.role = 'owner'; s.logistica.receipt_approval = false; expect(s.logOpComprovantes()).toEqual([]);
  });
  it('o arquivo continua vinculado à rota escolhida antes de abrir o seletor', async () => {
    const s = app(); const trips = [{ id: 'r1' }, { id: 'r2' }]; s.logistica.rotas_abertas = trips;
    s.logisticaRotaAbertaId = 'r1'; s.logOpEscolherComprovante(); s.logisticaRotaAbertaId = 'r2';
    s.enviarComprovante = vi.fn(); const event = { target: { value: 'foto.png' } };
    await s.logOpEnviarComprovante(event); expect(s.enviarComprovante).toHaveBeenCalledWith(trips[0], event);
    s.logistica.rotas_abertas = [trips[1]]; s.enviarComprovante.mockClear();
    await s.logOpEnviarComprovante(event); expect(s.enviarComprovante).not.toHaveBeenCalled();
  });
  it('preserva dados e horário na falha de rede e recupera na próxima atualização', async () => {
    const s = app(); const previous = s.logistica; s.logOpAtualizado = '2026-09-16T14:00:00Z';
    s.apiGet = vi.fn().mockRejectedValue(new Error('offline'));
    await s.logOpAtualizar(); expect(s.logistica).toBe(previous); expect(s.logOpErro).toBe(true);
    expect(s.logOpAtualizado).toBe('2026-09-16T14:00:00Z'); expect(s.logOpAtualizando).toBe(false);
    s.apiGet.mockResolvedValue({ ...previous, enabled: true });
    await s.logOpAtualizar(); expect(s.logOpErro).toBe(false); expect(s.logOpAtualizado).not.toBe('2026-09-16T14:00:00Z');
  });
  it('seleciona a última rota por encerramento, sem inventar resultados', () => {
    const s = app(); expect(s.logOpUltimaRota()).toBeNull();
    s.logistica.rotas_recentes = [{ id: 'older', status: 'closed', ended_at: '2026-09-01' }, { id: 'newer', status: 'closed', ended_at: '2026-09-15' }];
    expect(s.logOpUltimaRota().id).toBe('newer'); expect(s.rotaResultado(s.logOpUltimaRota())).toBeNull();
  });
});
