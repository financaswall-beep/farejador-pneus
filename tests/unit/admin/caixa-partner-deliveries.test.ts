import { describe, expect, it, vi } from 'vitest';
import { partnerScreen } from './helpers/partner-simple-dom.js';

const tire = (id: string, measure: string) => ({ order_item_id: id, photo_request_id: 'photo-' + id,
  tire_size: measure, quantity: 1, tire_condition: 'meia_vida', brand: 'Pirelli' });
const delivery = { order_id: 'delivery-a', order_status: 'confirmed', delivery_status: 'dispatched', delivery_courier: 'João',
  customer_name: 'Cliente Teste', customer_avatar_url: 'https://chat.example/avatar.png', total_amount: 180,
  delivery_address: 'Rua Exemplo, 120\nMéier, Rio de Janeiro', items: [tire('a', '90/90-18'), tire('b', '80/100-14')] };
async function open(row = delivery) {
  const screen = partnerScreen(); screen.C.partnerData.state.deliveries = [row];
  screen.C.authenticatedFetch.mockResolvedValue({ ok: true, blob: async () => ({ type: 'image/webp' }) });
  screen.ready(); screen.C.partnerHome.open('partner-deliveries'); await screen.button('VER ENTREGA').click(); return screen;
}
describe('entregas simples do parceiro', () => {
  it('agrupa os pedidos e mostra apenas os estados pendentes reais', () => {
    const { C, ready, root } = partnerScreen();
    C.partnerData.state.deliveries = [delivery, { ...delivery, order_id: 'b', delivery_status: 'pending' }, { ...delivery, order_id: 'c', delivery_status: 'delivered' }];
    ready(); C.partnerHome.open('partner-deliveries');
    expect(root.querySelectorAll('.pd-order')).toHaveLength(2);
    expect(root.textContent).toContain('2 entregas pendentes'); expect(root.textContent).toContain('1 a preparar • 1 em rota');
  });
  it('carrega a foto de cada pneu sem usar a foto genérica do pedido, e reaproveita o cache durante polling', async () => {
    const { C, root } = await open();
    await vi.waitFor(() => expect(root.querySelectorAll('.pd-photo').every(el => el.querySelectorAll('img').length === 1)).toBe(true));
    expect(C.authenticatedFetch.mock.calls.map((call: any[]) => call[0])).toEqual([
      '/parceiro/meier/api/operacao/entregas/fotos/photo-a', '/parceiro/meier/api/operacao/entregas/fotos/photo-b',
    ]);
    C.partnerHome.render(); expect(C.authenticatedFetch).toHaveBeenCalledTimes(2);
    const route: any = root.querySelectorAll('a')[0];
    expect(route.href).toBe('https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(delivery.delivery_address));
    expect(route.rel).toBe('noopener');
  });
  it('só conclui após escolher pagamento e confirmar; clique duplo não duplica a chamada', async () => {
    const { C, button, root } = await open(); C.partnerData.load = vi.fn(async () => {});
    let finish: (value: any) => void = () => {};
    C.partnerData.api = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    await button('ENTREGUEI E RECEBI').click(); await button('CONFIRMAR ENTREGA').click();
    expect(C.partnerData.api).not.toHaveBeenCalled(); expect(root.textContent).toContain('Escolha como recebeu.');
    await button('Pix').click(); await button('CONFIRMAR ENTREGA').click(); await button('CONCLUINDO…').click();
    expect(C.partnerData.api).toHaveBeenCalledTimes(1);
    expect(JSON.parse(C.partnerData.api.mock.calls[0][1].body)).toEqual({ delivery_status: 'delivered', delivery_courier: 'João', payment_method: 'Pix' });
    finish({ order_id: 'delivery-a', delivery_status: 'delivered' });
    await vi.waitFor(() => expect(C.partnerHome.currentTab()).toBe('partner-home'));
  });
  it('reutiliza assumir e iniciar no endpoint existente e só muda após resposta confirmada', async () => {
    const { C, button, root } = await open({ ...delivery, delivery_status: 'pending', delivery_courier: '' });
    C.partnerData.load = vi.fn(async () => {});
    C.partnerData.api = vi.fn(async (_: string, options: any) => ({ order_id: delivery.order_id, delivery_status: JSON.parse(options.body).delivery_status }));
    await button('ASSUMIR ENTREGA').click(); await vi.waitFor(() => expect(button('INICIAR ENTREGA')).toBeTruthy());
    await button('INICIAR ENTREGA').click(); await vi.waitFor(() => expect(button('ENTREGUEI E RECEBI')).toBeTruthy());
    expect(root.textContent).toContain('Em rota');
    expect(C.partnerData.api.mock.calls.every((call: any[]) => call[0] === 'entregas/delivery-a')).toBe(true);
  });
  it('falha da API não remove pedido nem anuncia sucesso', async () => {
    const { C, button, root } = await open({ ...delivery, delivery_status: 'pending', delivery_courier: '' });
    C.partnerData.api = vi.fn(async () => ({})); await button('ASSUMIR ENTREGA').click();
    await vi.waitFor(() => expect(root.textContent).toContain('Esse pedido já mudou'));
    expect(C.showToast).not.toHaveBeenCalled(); expect(C.partnerData.state.deliveries[0].delivery_courier).toBe('');
  });
  it('não oferece rota sem endereço nem ações sobre entrega de outro operador ou com problema', async () => {
    const { root, button } = await open({ ...delivery, delivery_address: '', delivery_courier: 'Outro' });
    expect(root.querySelectorAll('a')).toHaveLength(0); expect(root.textContent).toContain('Outro');
    expect(button('ENTREGUEI E RECEBI')).toBeUndefined();
    expect(button('PROBLEMA NA ENTREGA')).toBeUndefined();
    const failed = await open({ ...delivery, delivery_status: 'failed' });
    expect(failed.root.textContent).toContain('A reserva continua protegida'); expect(failed.button('ENTREGUEI E RECEBI')).toBeUndefined();
    expect(failed.button('PROBLEMA NA ENTREGA')).toBeUndefined();
  });
  it('abrir problema e voltar não altera o pedido; exige motivo antes de registrar', async () => {
    const { C, button, root } = await open(); C.partnerData.api = vi.fn();
    await button('PROBLEMA NA ENTREGA').click(); await button('REGISTRAR PROBLEMA').click();
    expect(C.partnerData.api).not.toHaveBeenCalled(); expect(root.textContent).toContain('Informe o que aconteceu');
    await button('VOLTAR PARA ENTREGA').click(); expect(button('ENTREGUEI E RECEBI')).toBeTruthy();
    expect(C.partnerData.state.deliveries[0].delivery_status).toBe('dispatched');
  });
  it('registra falha com motivo, preserva rascunho no polling e bloqueia clique duplo', async () => {
    const { C, button, root } = await open(); C.partnerData.load = vi.fn(async () => {});
    let finish: (value: any) => void = () => {};
    C.partnerData.api = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    await button('PROBLEMA NA ENTREGA').click();
    const input = root.querySelectorAll('textarea')[0]; input.value = '  Cliente ausente  '; await input.fire('input');
    expect(root.querySelectorAll('.ps-error')).toHaveLength(0);
    C.partnerHome.render(); expect(root.querySelectorAll('textarea')[0].value).toBe('  Cliente ausente  ');
    await button('REGISTRAR PROBLEMA').click(); await button('REGISTRANDO…').click();
    expect(C.partnerData.api).toHaveBeenCalledTimes(1);
    expect(C.partnerData.api.mock.calls[0][0]).toBe('entregas/delivery-a');
    expect(JSON.parse(C.partnerData.api.mock.calls[0][1].body)).toEqual({
      delivery_status: 'failed', delivery_courier: 'João', payment_method: null, reason: 'Cliente ausente',
    });
    finish({ order_id: delivery.order_id, delivery_status: 'failed' });
    await vi.waitFor(() => expect(root.textContent).toContain('A reserva continua protegida'));
    expect(C.partnerData.state.deliveries[0].delivery_status).toBe('failed');
    expect(C.showToast).toHaveBeenCalledWith('Problema registrado. Pneus continuam reservados.');
    expect(button('ENTREGUEI E RECEBI')).toBeUndefined();
  });
  it('erro no registro de problema mantém motivo e pedido para nova tentativa', async () => {
    const { C, root, button } = await open();
    C.partnerData.api = vi.fn(async () => { throw new Error('offline'); });
    await button('PROBLEMA NA ENTREGA').click();
    const input = root.querySelectorAll('textarea')[0]; input.value = 'Endereço não encontrado'; await input.fire('input');
    await button('REGISTRAR PROBLEMA').click();
    await vi.waitFor(() => expect(root.textContent).toContain('Não consegui concluir'));
    expect(root.querySelectorAll('textarea')[0].value).toBe('Endereço não encontrado');
    expect(C.partnerData.state.deliveries[0].delivery_status).toBe('dispatched');
    expect(C.showToast).not.toHaveBeenCalled();
  });
  it('aborta e descarta fotos quando sai da tela ou troca de sessão', async () => {
    const { C, context, setSession, root } = await open();
    await vi.waitFor(() => expect(context.URL.createObjectURL).toHaveBeenCalledTimes(2));
    C.partnerHome.open('partner-deliveries'); expect(context.URL.revokeObjectURL).toHaveBeenCalledTimes(2);
    let finish: (value: any) => void = () => {};
    C.authenticatedFetch.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await root.querySelectorAll('button').find(el => el.textContent.includes('VER ENTREGA'))!.click();
    setSession('other'); C.partnerDeliveries.reset(); finish({ ok: true, blob: async () => ({ type: 'image/webp' }) });
    await Promise.resolve(); await Promise.resolve(); expect(context.URL.createObjectURL).toHaveBeenCalledTimes(2);
  });
});
