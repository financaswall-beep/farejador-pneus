import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function app() {
  const node = () => ({ textContent: '', value: '', classList: { contains: () => true, add: vi.fn(), remove: vi.fn() }, addEventListener: vi.fn(), querySelector: () => node() });
  const elements = Object.fromEntries(['panel', 'list', 'search', 'refresh', 'retry', 'addService', 'stageAction', 'backStage', 'completeAction', 'cancelOpen', 'cancelBack', 'cancelForm', 'cancelReason', 'sheetError', 'sheet'].map(key => [key, node()]));
  const row = { order_id: '00000000-0000-4000-8000-000000000041', total_amount: 178 };
  const state = { rows: [row], serviceCatalog: [], selectedId: row.order_id, payments: { [row.order_id]: 'Pix' }, services: {}, request: null, saving: false };
  let session = 'session-one';
  const P: any = { elements, state, selected: () => state.rows.find(item => item.order_id === state.selectedId), draftServices: () => [],
    renderSheet: vi.fn(), renderList: vi.fn(), setStateView: vi.fn(), closeSheet: vi.fn(), openSelected: vi.fn(), normalizedPayment: (value: string) => value };
  const C: any = { Pickups: P, token: () => session, canModule: () => true, isPartner: () => false, sessionFingerprint: () => session,
    operationPath: (_: string, fallback: string) => fallback, authenticatedFetch: vi.fn(), json: (response: any) => response.payload, showToast: vi.fn() };
  runInNewContext(readFileSync('painel/public/caixa-pickups-actions.js', 'utf8'), {
    window: { Caixa: C }, document: { querySelectorAll: () => [], addEventListener: vi.fn() }, AbortController, DOMException, Error,
  });
  const response = (payload: unknown, ok = true) => ({ payload, ok, status: ok ? 200 : 503 });
  return { C, P, state, row, response, changeSession: () => { session = 'session-two'; } };
}

describe('ações de retirada usadas pelas telas da Matriz', () => {
  it('só conclui após o servidor confirmar e não duplica o pagamento com dois toques', async () => {
    const a = app(), payment = deferred<unknown>();
    const confirmation = { order_id: a.row.order_id, status: 'paid', retrieved_at: '2026-10-26T15:00:00Z' };
    a.C.authenticatedFetch.mockReturnValueOnce(payment.promise).mockResolvedValueOnce(a.response({ rows: [a.row], service_catalog: [] }));
    const first = a.P.actions.completePickup();
    await a.P.actions.completePickup();
    expect(a.C.authenticatedFetch).toHaveBeenCalledTimes(1);
    expect(a.P.closeSheet).not.toHaveBeenCalled();
    expect(a.C.showToast).not.toHaveBeenCalled();
    const [, request] = a.C.authenticatedFetch.mock.calls[0];
    expect(request.method).toBe('POST');
    expect(JSON.parse(request.body)).toEqual({ payment_method: 'Pix', services: [] });
    payment.resolve(a.response(confirmation));
    await expect(first).resolves.toEqual(confirmation);
    expect(a.P.closeSheet).toHaveBeenCalledOnce();
    expect(a.state.saving).toBe(false);
  });
  it('mantém a retirada aberta e mostra erro quando o pagamento é recusado', async () => {
    const a = app(); a.C.authenticatedFetch.mockResolvedValue(a.response({ error: 'fixture_error' }, false));
    await expect(a.P.actions.completePickup()).resolves.toBeUndefined();
    expect(a.P.closeSheet).not.toHaveBeenCalled();
    expect(a.C.showToast).not.toHaveBeenCalled();
    expect(a.P.elements.sheetError.textContent).toContain('Não foi possível');
    expect(a.state.saving).toBe(false);
  });
  it('não envia serviço cobrado sem valor', async () => {
    const a = app(); a.P.draftServices = () => [{ code: 'mounting', charge_mode: 'charged', amount_cents: 0 }];
    await a.P.actions.completePickup();
    expect(a.C.authenticatedFetch).not.toHaveBeenCalled();
    expect(a.P.elements.sheetError.textContent).toContain('Informe o valor');
  });
  it.each(['completePickup', 'cancelPickup', 'saveStage'])('exige confirmação da operação mesmo com HTTP 200 em %s', async action => {
    const a = app(); a.C.authenticatedFetch.mockResolvedValue(a.response({}));
    await a.P.actions[action](action === 'saveStage' ? 'arrived' : 'Cliente desistiu');
    expect(a.P.closeSheet).not.toHaveBeenCalled(); expect(a.C.showToast).not.toHaveBeenCalled();
    expect(a.C.authenticatedFetch).toHaveBeenCalledTimes(1);
    expect(a.P.elements.sheetError.textContent).toContain('Não foi possível confirmar');
  });
  it('descarta a lista recebida depois da troca de sessão', async () => {
    const a = app(), read = deferred<unknown>(); a.C.authenticatedFetch.mockReturnValueOnce(read.promise);
    const pending = a.C.loadPickups(); a.changeSession();
    read.resolve(a.response({ rows: [{ order_id: 'other-customer' }], service_catalog: [] })); await pending;
    expect(a.state.rows).toEqual([a.row]); expect(a.P.renderList).not.toHaveBeenCalled();
  });
  it.each(['completePickup', 'cancelPickup', 'saveStage'])('não repinta a sessão nova após a ação antiga %s', async action => {
    const a = app(), write = deferred<unknown>(); a.C.authenticatedFetch.mockReturnValueOnce(write.promise);
    const pending = a.P.actions[action](action === 'saveStage' ? 'arrived' : 'Cliente desistiu');
    a.changeSession(); a.P.renderSheet.mockClear();
    write.resolve(a.response({ order_id: a.row.order_id, status: 'paid' })); await pending;
    expect(a.C.authenticatedFetch).toHaveBeenCalledTimes(1);
    expect(a.C.showToast).not.toHaveBeenCalled(); expect(a.P.closeSheet).not.toHaveBeenCalled();
    expect(a.P.renderSheet).not.toHaveBeenCalled();
  });
  it('não fecha a tela da nova sessão se a troca ocorrer durante a releitura após o pagamento', async () => {
    const a = app(), read = deferred<unknown>();
    a.C.authenticatedFetch.mockResolvedValueOnce(a.response({ order_id: a.row.order_id, status: 'paid', retrieved_at: '2026-10-26T15:00:00Z' })).mockReturnValueOnce(read.promise);
    const pending = a.P.actions.completePickup();
    await vi.waitFor(() => expect(a.C.authenticatedFetch).toHaveBeenCalledTimes(2));
    a.changeSession(); read.resolve(a.response({ rows: [a.row] })); await pending;
    expect(a.P.closeSheet).not.toHaveBeenCalled();
  });
});
