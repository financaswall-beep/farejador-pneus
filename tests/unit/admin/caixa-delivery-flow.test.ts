import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { TestNode } from './helpers/partner-simple-dom.js';

function setup() {
  const nodes: Record<string, any> = {};
  const el = (id: string) => nodes[id] ||= Object.assign(new TestNode(), { checkValidity: () => true });
  let session = 'matrix-a'; let partner = false; let state: any;
  const rows = ['a', 'b'].map((id, index) => ({ order_id: id, order_number: 'PED-' + index,
    customer_name: 'Cliente ' + id, total_amount: 149.9, in_route: false, delivery_status: 'pending' }));
  let payload: any = { rows, matrix_route: null };
  const render = vi.fn(); const focus = vi.fn();
  const C: any = { isPartner: () => partner, sessionFingerprint: () => session, showToast: vi.fn(),
    createMatrixDeliveryView: () => ({ root: el('root'), byId: el, render, focus, orderLabel: (row: any) => row.order_number }),
    json: (response: any) => response.json(),
  };
  const reload = vi.fn(async () => C.matrixDeliveries.sync(payload, reload));
  const response = (data = {}, ok = true) => ({ ok, json: async () => data });
  C.authenticatedFetch = vi.fn(async (url: string, options: any) => {
    const body = options.headers?.['Content-Type'] === 'application/json' ? JSON.parse(options.body) : {};
    if (url.endsWith('rota/abrir')) {
      payload = { rows: rows.map(row => ({ ...row, in_route: body.order_ids.includes(row.order_id) })),
        matrix_route: { trip_id: 'route-a', total: body.order_ids.length, completed: 0, unresolved: body.order_ids.length } };
    } else if (url.endsWith('/status')) {
      payload.rows = payload.rows.map((row: any) => row.order_id === body.order_id ? { ...row, delivery_status: body.status } : row);
      payload.matrix_route.completed = payload.rows.filter((row: any) => row.in_route && row.delivery_status === 'delivered').length;
      payload.matrix_route.unresolved = payload.rows.filter((row: any) => row.in_route && ['pending', 'dispatched'].includes(row.delivery_status)).length;
    } else if (url.endsWith('/nao-entregue')) {
      payload.rows = payload.rows.map((row: any) => row.order_id === body.order_id ? { ...row, delivery_status: 'failed' } : row);
      payload.matrix_route.unresolved = 0; payload.matrix_route.reported = 1;
    } else if (url.endsWith('rota/fechar')) payload = { rows: [], matrix_route: null };
    return response();
  });
  const context = { window: { Caixa: C }, document: { activeElement: null, querySelectorAll: () => [] }, console };
  runInNewContext(readFileSync('painel/public/caixa-deliveries-flow-actions.js', 'utf8'), context);
  const factory = C.createMatrixDeliveryActions;
  C.createMatrixDeliveryActions = (current: any, ...rest: any[]) => { state = current; return factory(current, ...rest); };
  runInNewContext(readFileSync('painel/public/caixa-deliveries-matrix.js', 'utf8'), context);
  C.matrixDeliveries.sync(payload, reload);
  const action = (name: string, id?: string) => C.matrixDeliveries.handleAction(name, { dataset: { orderId: id } });
  const inRoute = (status = 'dispatched', unresolved = 1) => {
    payload = { rows: [{ ...rows[0], in_route: true, delivery_status: status }],
      matrix_route: { trip_id: 'route-a', total: 1, completed: status === 'delivered' ? 1 : 0, unresolved } };
    C.matrixDeliveries.sync(payload, reload);
  };
  return { C, el, action, inRoute, response, reload, render, get state() { return state; },
    setPayload: (value: any) => { payload = value; }, changeSession: () => { session = 'matrix-b'; },
    becomePartner: () => { partner = true; } };
}

describe('quatro etapas das entregas da Matriz', () => {
  it('seleciona vários pedidos e monta uma rota sem marcar saída ou pagamento', async () => {
    const s = setup(); await s.action('select', 'a'); await s.action('select', 'b');
    s.el('matrix-route-km-start').value = '45210'; await s.el('matrix-route-open').fire('click');
    expect(s.C.authenticatedFetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(s.C.authenticatedFetch.mock.calls[0][1].body)).toEqual({ order_ids: ['a', 'b'], km_start: 45210 });
    expect(s.state.view).toBe('route'); expect(s.state.rows.every((row: any) => row.delivery_status === 'pending')).toBe(true);
    expect(s.state.paymentMethod).toBeNull();
  });
  it('registra a saída por pedido separadamente da montagem da rota', async () => {
    const s = setup(); s.inRoute('pending'); await s.action('dispatch', 'a');
    expect(JSON.parse(s.C.authenticatedFetch.mock.calls[0][1].body)).toEqual({ order_id: 'a', status: 'dispatched', payment_method: null });
    expect(s.state.rows[0].delivery_status).toBe('dispatched');
  });
  it('não oferece pagamento para pedido que ainda não saiu', async () => {
    const s = setup(); s.inRoute('pending'); expect(await s.action('payment', 'a')).toBe(false);
    expect(s.state.view).toBe('route'); expect(s.C.authenticatedFetch).not.toHaveBeenCalled();
  });
  it('só conclui com forma de pagamento escolhida e recebimento conferido', async () => {
    const s = setup(); s.inRoute(); await s.action('payment', 'a');
    expect(s.state.paymentMethod).toBeNull(); expect(s.state.received).toBe(false);
    await s.el('mdf-payment-confirm').fire('click'); s.state.paymentMethod = 'pix';
    await s.el('mdf-payment-confirm').fire('click'); expect(s.C.authenticatedFetch).not.toHaveBeenCalled();
    s.state.received = true; await s.el('mdf-payment-confirm').fire('click');
    expect(JSON.parse(s.C.authenticatedFetch.mock.calls[0][1].body)).toEqual({ order_id: 'a', status: 'delivered', payment_method: 'pix' });
    expect(s.state.view).toBe('route'); expect(s.state.paymentOrderId).toBeNull();
  });
  it('impede dois cliques simultâneos na confirmação', async () => {
    const s = setup(); s.inRoute(); await s.action('payment', 'a'); s.state.paymentMethod = 'dinheiro'; s.state.received = true;
    await Promise.all([s.el('mdf-payment-confirm').fire('click'), s.el('mdf-payment-confirm').fire('click')]);
    expect(s.C.authenticatedFetch).toHaveBeenCalledTimes(1);
  });
  it('não confirma pagamento quando o valor do pedido está inválido', async () => {
    const s = setup(); s.inRoute(); await s.action('payment', 'a');
    s.state.rows[0].total_amount = NaN; s.state.paymentMethod = 'pix'; s.state.received = true;
    await s.el('mdf-payment-confirm').fire('click');
    expect(s.C.authenticatedFetch).not.toHaveBeenCalled();
  });
  it('aguarda o envio do comprovante antes de permitir o fechamento', async () => {
    const s = setup(); s.inRoute('delivered', 0); await s.action('close');
    let done!: (value: any) => void;
    s.C.authenticatedFetch.mockImplementationOnce(() => new Promise(resolve => { done = resolve; }));
    s.el('matrix-route-receipt').files = [{ type: 'image/jpeg' }];
    const upload = s.el('matrix-route-receipt').fire('change');
    await s.el('matrix-route-close-button').fire('click');
    expect(s.C.authenticatedFetch).toHaveBeenCalledTimes(1); expect(s.state.busy).toBe(true);
    done(s.response()); await upload;
    expect(s.state.busy).toBe(false); expect(s.el('matrix-route-receipt-status').textContent).toContain('enviado para conferência');
  });
  it('mantém a confirmação aberta e informa erro se o servidor recusar', async () => {
    const s = setup(); s.inRoute(); await s.action('payment', 'a'); s.state.paymentMethod = 'cartao'; s.state.received = true;
    s.C.authenticatedFetch.mockResolvedValueOnce(s.response({ error: 'delivery_not_found' }, false));
    await s.el('mdf-payment-confirm').fire('click');
    expect(s.state.view).toBe('payment'); expect(s.state.error).toContain('O pedido mudou'); expect(s.C.showToast).not.toHaveBeenCalled();
  });
  it('não permite encerrar rota com entrega pendente', async () => {
    const s = setup(); s.inRoute(); await s.action('close'); await s.el('matrix-route-close-button').fire('click');
    expect(s.state.view).toBe('route'); expect(s.C.authenticatedFetch).not.toHaveBeenCalled();
  });
  it('fecha a rota por endpoint existente com KM e combustível sem arredondar valores', async () => {
    const s = setup(); s.inRoute('delivered', 0); await s.action('close');
    s.el('matrix-route-km-end').value = '45245'; s.el('matrix-route-fuel').value = '20.50';
    await s.el('matrix-route-close-button').fire('click');
    expect(JSON.parse(s.C.authenticatedFetch.mock.calls[0][1].body)).toEqual({ km_end: 45245, fuel_spent: 20.5 });
    expect(s.state.view).toBe('prepare'); expect(s.state.notice).toContain('Rota encerrada');
  });
  it('recusa número inválido antes de enviar o fechamento', async () => {
    const s = setup(); s.inRoute('delivered', 0); s.el('matrix-route-fuel').value = '-1';
    await s.el('matrix-route-close-button').fire('click');
    expect(s.C.authenticatedFetch).not.toHaveBeenCalled(); expect(s.state.error).toContain('Confira o KM');
  });
  it('a janela de problema exige motivo e apenas registra a ocorrência', async () => {
    const s = setup(); s.inRoute(); await s.action('fail', 'a');
    expect(s.el('delivery-failure-modal').open).toBe(true);
    await s.el('delivery-failure-submit').fire('click'); expect(s.C.authenticatedFetch).not.toHaveBeenCalled();
    s.el('delivery-failure-reason').value = 'Cliente ausente'; await s.el('delivery-failure-submit').fire('click');
    expect(s.C.authenticatedFetch.mock.calls[0][0]).toBe('/api/caixa/entregas/nao-entregue');
    expect(JSON.parse(s.C.authenticatedFetch.mock.calls[0][1].body)).toEqual({ order_id: 'a', reason: 'Cliente ausente' });
    expect(s.el('delivery-failure-modal').open).toBe(false); expect(s.state.route.reported).toBe(1);
  });
  it('não reaproveita confirmação se o pedido já foi atualizado por outro operador', async () => {
    const s = setup(); s.inRoute(); await s.action('payment', 'a'); s.state.paymentMethod = 'pix'; s.state.received = true;
    s.inRoute('delivered', 0); await s.el('mdf-payment-confirm').fire('click');
    expect(s.state.view).toBe('route'); expect(s.state.received).toBe(false); expect(s.C.authenticatedFetch).not.toHaveBeenCalled();
  });
  it('remove seleção de pedido que deixou a fila e bloqueia outra rota aberta', async () => {
    const s = setup(); await s.action('select', 'a'); s.setPayload({ rows: [], matrix_route: null }); await s.reload();
    expect(s.state.selected.size).toBe(0); await s.el('matrix-route-open').fire('click');
    s.inRoute('pending'); expect(await s.action('select', 'a')).toBe(false); expect(s.C.authenticatedFetch).not.toHaveBeenCalled();
  });
  it('descarta resposta de escrita após troca de sessão', async () => {
    const s = setup(); s.inRoute('pending'); let done!: (value: any) => void;
    s.C.authenticatedFetch.mockImplementationOnce(() => new Promise(resolve => { done = resolve; }));
    const pending = s.action('dispatch', 'a'); s.changeSession(); s.setPayload({ rows: [], matrix_route: null }); await s.reload();
    done(s.response()); await pending;
    expect(s.state.rows).toHaveLength(0); expect(s.state.busy).toBe(false); expect(s.C.showToast).not.toHaveBeenCalled();
  });
  it('limpa a confirmação ao sair da tela e não executa ações com sessão de parceiro', async () => {
    const s = setup(); s.inRoute(); await s.action('payment', 'a'); s.state.received = true; s.C.matrixDeliveries.leave();
    expect(s.state.received).toBe(false); expect(s.state.paymentOrderId).toBeNull(); s.becomePartner();
    expect(await s.action('dispatch', 'a')).toBe(false); expect(s.C.authenticatedFetch).not.toHaveBeenCalled();
  });
});
