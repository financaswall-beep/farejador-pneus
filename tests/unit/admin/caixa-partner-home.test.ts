import { describe, expect, it, vi } from 'vitest';
import { partnerScreen } from './helpers/partner-simple-dom.js';

const pickup = { order_id: 'pickup-a', awaiting_pickup: true, customer_name: 'Carlos', status: 'confirmed', payment_method: 'Pix', total_amount: '150', items: [{ tire_size: '90/90-18', quantity: 1 }] };
const delivery = { order_id: 'delivery-a', order_status: 'confirmed', delivery_status: 'pending', customer_name: 'Maria', total_amount: 120, items: [{ label: '80/100-14', quantity: 1 }] };

describe('Operação simples exclusiva do parceiro', () => {
  it('abre diretamente a confirmação mais urgente e envia a revisão recebida pelo servidor', async () => {
    const screen = partnerScreen(); screen.ready();
    const item = (id: string, seconds: number) => ({ id, revision: 2, expires_at: new Date(Date.now() + seconds * 1000).toISOString(), items: [{ tire_size: '90/90-18', quantity: 1 }] });
    screen.C.partnerWaiting.sync([item('menos-urgente', 240), item('urgente', 60)]);
    expect(screen.C.partnerHome.currentTab()).toBe('partner-waiting');
    screen.C.authenticatedFetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true, status: 'confirmed' }) });
    screen.button('TENHO').click();
    await vi.waitFor(() => expect(screen.C.authenticatedFetch).toHaveBeenCalledWith(
      '/parceiro/meier/api/operacao/confirmacoes-estoque/urgente', expect.objectContaining({ body: JSON.stringify({ available: true, revision: 2 }) })));
  });
  it('mantém a matriz no Caixa, sem aceitar telas ou URLs do parceiro', () => {
    const { C, location, node } = partnerScreen(false);
    expect(C.initialOperationTab()).toBe('cash');
    location.hash = '#pedidos';
    expect(C.initialOperationTab()).toBe('cash');
    expect(C.authorizedOperationTab('partner-home')).toBe('cash');
    C.partnerHome.sync('cash');
    expect(node('app').classList.contains('is-partner-home')).toBe(false);
  });
  it('mapeia menu e links antigos para telas simples e respeita permissões', () => {
    const { C, location } = partnerScreen();
    expect(C.initialOperationTab()).toBe('partner-home');
    for (const [old, simple] of Object.entries({ sales: 'partner-sales', stock: 'partner-stock', pickups: 'partner-pickups', deliveries: 'partner-deliveries', profile: 'partner-profile', cash: 'partner-home', finance: 'partner-home' })) {
      expect(C.authorizedOperationTab(old)).toBe(simple);
    }
    location.hash = '#catalogo'; expect(C.initialOperationTab()).toBe('partner-stock');
    const denied = partnerScreen(true, { vendas: false, estoque: false, retiradas: false, entregas: false });
    expect(denied.C.authorizedOperationTab('partner-deliveries')).toBe('partner-home');
    expect(denied.C.authorizedOperationTab('partner-photo')).toBe('partner-home');
  });
  it('usa o motor existente de Vendas e o libera ao navegar para Pedidos', () => {
    const { C, ready } = partnerScreen(); ready();
    C.partnerHome.open('partner-sales');
    expect(C.partnerSales.render).toHaveBeenCalled();
    expect(C.partnerSales.load).toHaveBeenCalledOnce();
    C.partnerSales.leave.mockClear(); C.partnerHome.open('partner-home');
    expect(C.partnerSales.leave).toHaveBeenCalledOnce();
    const denied = partnerScreen(true, { vendas: false });
    denied.C.partnerHome.open('partner-sales');
    expect(denied.C.partnerSales.load).not.toHaveBeenCalled();
  });
  it('não anuncia tudo em dia antes de consultar todas as fontes permitidas', () => {
    const { C, root, ready } = partnerScreen();
    C.partnerHome.sync('partner-home'); expect(root.textContent).toContain('Conferindo pedidos');
    C.state.photoLoadState = 'idle'; ready(); expect(root.textContent).toContain('Conferindo pedidos');
    C.state.photoLoadState = 'ready'; C.partnerHome.render(); expect(root.textContent).toContain('Tudo em dia!');
  });
  it('mostra somente foto e retirada quando não existe entrega, com contador real', () => {
    const { C, root, ready, node, button } = partnerScreen();
    C.state.photoRequests = [{ id: 'photo-a', tire_size: '90/90-18', customer_name: 'Segredo' }];
    C.partnerData.state.pickups = [pickup]; ready();
    expect(root.textContent).toContain('Cliente pediu foto'); expect(root.textContent).toContain('Retirada pendente');
    expect(button('VER ENTREGAS')).toBeUndefined(); expect(root.textContent).not.toContain('Segredo');
    expect(node('partner-home-badge').textContent).toBe('2');
  });
  it('some com categorias vazias e não oculta falhas de consulta', () => {
    const { C, root, ready, button } = partnerScreen();
    C.partnerData.state.deliveries = [delivery]; ready();
    expect(button('VER ENTREGAS')).toBeDefined(); expect(button('ENVIAR FOTO')).toBeUndefined();
    C.partnerData.state.deliveries = []; C.partnerData.state.errors = ['deliveries']; C.partnerHome.render();
    expect(root.textContent).toContain('Não consegui atualizar'); expect(root.textContent).not.toContain('Tudo em dia!');
  });
  it('não mostra concluídos e mantém pendências antigas visíveis', () => {
    const { C, ready } = partnerScreen();
    C.partnerData.state.pickups = [pickup, { ...pickup, order_id: 'done', retrieved_at: '2026-10-01', awaiting_pickup: false }];
    C.partnerData.state.deliveries = [delivery, { ...delivery, order_id: 'done', delivery_status: 'delivered' }]; ready();
    expect(C.partnerData.pendingPickups()).toHaveLength(1); expect(C.partnerData.pendingDeliveries()).toHaveLength(1);
  });
  it('descarta consulta antiga depois da troca de sessão e não busca módulos negados', async () => {
    const { C, setSession } = partnerScreen(true, { vendas: false, retiradas: true, entregas: false });
    let resolve: (value: any) => void = () => {};
    C.authenticatedFetch.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    const load = C.partnerData.load(); setSession('session-b'); C.partnerData.reset();
    resolve({ ok: true, json: async () => ({ rows: [pickup] }) }); await load;
    expect(C.partnerData.state.pickups).toHaveLength(0); expect(C.partnerData.state.ready).toBe(false);
    expect(C.authenticatedFetch).toHaveBeenCalledTimes(1);
    expect(C.authenticatedFetch.mock.calls[0][0]).toContain('/parceiro/meier/api/retiradas');
  });
  it('preserva o pagamento escolhido e não repete conclusão com clique duplo', async () => {
    const { C, ready, button, root } = partnerScreen(); C.partnerData.state.pickups = [pickup]; ready();
    C.partnerHome.open('partner-pickups'); await button('CLIENTE CHEGOU').click();
    const select = root.querySelectorAll('select')[0]; select.value = 'Dinheiro'; await select.fire('change');
    let done: (value: any) => void = () => {};
    C.partnerData.api = vi.fn(() => new Promise(resolve => { done = resolve; }));
    C.partnerData.load = vi.fn(async () => {});
    await button('ENTREGUEI E RECEBI').click(); await button('CONCLUINDO…').click();
    expect(C.partnerData.api).toHaveBeenCalledTimes(1);
    expect(JSON.parse(C.partnerData.api.mock.calls[0][1].body).payment_method).toBe('Dinheiro');
    done({ retrieved: true }); await vi.waitFor(() => expect(C.partnerHome.currentTab()).toBe('partner-home'));
  });
  it('cancelar retirada exige um segundo toque antes de liberar a reserva', async () => {
    const { C, ready, button, root } = partnerScreen(); C.partnerData.state.pickups = [pickup]; ready();
    C.partnerData.api = vi.fn(async () => ({ cancelled: true })); C.partnerData.load = vi.fn(async () => {});
    C.partnerHome.open('partner-pickups'); await button('CLIENTE CHEGOU').click(); await button('Cliente não veio').click();
    expect(C.partnerData.api).not.toHaveBeenCalled(); expect(root.textContent).toContain('Cancelar este pedido');
    await button('SIM, CANCELAR').click(); await vi.waitFor(() => expect(C.partnerData.api).toHaveBeenCalledOnce());
    expect(C.partnerData.api.mock.calls[0][1].method).toBe('DELETE');
  });
  it('não apresenta ação de entrega atribuída a outro operador', async () => {
    const { C, ready, root, button } = partnerScreen();
    C.partnerData.state.deliveries = [{ ...delivery, delivery_status: 'dispatched', delivery_courier: 'Outro operador' }]; ready();
    C.partnerHome.open('partner-deliveries'); await button('VER ENTREGA').click();
    expect(root.textContent).toContain('Outro operador'); expect(root.textContent).not.toContain('ENTREGUEI E RECEBI');
  });
  it('foto usa a compressão e o upload existentes sem abrir o modal completo', async () => {
    const { C, ready, button, root } = partnerScreen(); C.state.photoRequests = [{ id: 'photo-a', tire_size: '90/90-18', photo_count: 0 }]; ready();
    C.partnerPhoto.open('photo-a'); const input = root.querySelectorAll('input')[0]; input.files = [{ name: 'foto.jpg' }];
    await input.fire('change'); await vi.waitFor(() => expect(root.textContent).toContain('ENVIAR'));
    C.authenticatedFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ attached: true }) });
    await button('ENVIAR').click(); await vi.waitFor(() => expect(C.loadPhotoRequests).toHaveBeenCalled());
    expect(C.compressPhoto).toHaveBeenCalledOnce();
    expect(C.authenticatedFetch.mock.calls[0][0]).toContain('/operacao/pedidos-foto/photo-a/foto');
    expect(C.authenticatedFetch.mock.calls[0][1].headers['Content-Type']).toBe('image/jpeg');
  });
  it('cliente esperando usa prazo recebido, esconde identidade e responde uma única vez', async () => {
    const { C, root, ready, button } = partnerScreen(); ready();
    const respond = vi.fn(async () => {});
    C.partnerHome.refresh = vi.fn(async () => {});
    C.partnerWaiting.open({ id: 'waiting-a', customer_name: 'Nome escondido', expires_at: new Date(Date.now() + 282000).toISOString(), items: pickup.items }, respond);
    expect(root.textContent).toContain('Cliente esperando'); expect(root.textContent).toContain('4:42');
    expect(root.textContent).not.toContain('Nome escondido');
    await button('TENHO').click(); await vi.waitFor(() => expect(respond).toHaveBeenCalledWith('waiting-a', true));
    expect(respond).toHaveBeenCalledOnce();
  });
  it('não fabrica prazo nem aceita resposta depois de vencer', () => {
    const { C, root, ready } = partnerScreen(); ready();
    const respond = vi.fn();
    C.partnerWaiting.open({ id: 'invalid', expires_at: '', items: pickup.items }, respond);
    expect(C.partnerWaiting.current()).toBeNull();
    C.partnerWaiting.open({ id: 'expired', expires_at: new Date(Date.now() - 1000).toISOString(), items: pickup.items }, respond);
    expect(root.textContent).toContain('Prazo encerrado');
    expect(root.textContent).not.toContain('NÃO TENHO'); expect(respond).not.toHaveBeenCalled();
  });
});
