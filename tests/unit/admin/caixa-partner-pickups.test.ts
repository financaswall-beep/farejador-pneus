import { describe, expect, it, vi } from 'vitest';
import { partnerScreen } from './helpers/partner-simple-dom.js';

const tire = (id: string, size: string) => ({ order_item_id: id, photo_request_id: 'photo-' + id,
  tire_size: size, quantity: 1, brand: 'Pirelli', tire_condition: 'meia_vida' });
const order = { order_id: 'order-a', awaiting_pickup: true, status: 'confirmed', customer_name: 'João Silva',
  customer_avatar_url: 'https://chat.example/avatar.png', items: [tire('a', '90/90-18'), tire('b', '80/100-14')] };

describe('retiradas simples: identidade e itens do pedido', () => {
  it('agrupa por pedido, soma quantidade e exclui serviços da contagem de pneus', async () => {
    const { C, ready, root } = partnerScreen();
    C.partnerData.state.pickups = [{ ...order, items: [...order.items, { quantity: 1, item_name: 'Montagem', pickup_service_code: 'mounting' }] },
      { ...order, order_id: 'order-b', customer_name: 'Carlos', items: [{ ...tire('c', '2.75-18'), quantity: 3 }] }];
    ready(); C.partnerHome.open('partner-pickups');
    expect(root.querySelectorAll('.pu-order')).toHaveLength(2);
    expect(root.querySelectorAll('.pu-quantity-badge').map(el => el.textContent)).toEqual(['2 pneus', '3 pneus']);
    expect(root.textContent).not.toContain('Montagem');
  });
  it('carrega a foto pelo item exato e não confunde pneus do mesmo pedido', async () => {
    const { C, ready, root, button } = partnerScreen(); C.partnerData.state.pickups = [order];
    C.authenticatedFetch.mockResolvedValue({ ok: true, blob: async () => ({ type: 'image/webp' }) });
    ready(); C.partnerHome.open('partner-pickups'); await button('VER RETIRADA').click();
    await vi.waitFor(() => expect(root.querySelectorAll('.pu-tire-photo').every(frame => frame.querySelectorAll('img').length === 1)).toBe(true));
    expect(C.authenticatedFetch.mock.calls.map((call: any[]) => call[0])).toEqual([
      '/parceiro/meier/api/operacao/retiradas/order-a/itens/a/foto', '/parceiro/meier/api/operacao/retiradas/order-a/itens/b/foto',
    ]);
    expect(root.textContent).toContain('Quais pneus entregar');
    expect(root.querySelectorAll('.pu-tire')).toHaveLength(2);
    C.partnerHome.render(); expect(C.authenticatedFetch).toHaveBeenCalledTimes(2);
  });
  it('descarta fotos ao trocar de sessão e mantém falha de foto sem bloquear retirada', async () => {
    const { C, ready, root, button, setSession, context } = partnerScreen(); C.partnerData.state.pickups = [order];
    let done: (response: any) => void = () => {};
    C.authenticatedFetch.mockImplementation(() => new Promise(resolve => { done = resolve; }));
    ready(); C.partnerHome.open('partner-pickups'); await button('VER RETIRADA').click();
    setSession('other'); C.partnerPickups.reset(); done({ ok: true, blob: async () => ({ type: 'image/webp' }) });
    await Promise.resolve(); await Promise.resolve();
    expect(context.URL.createObjectURL).not.toHaveBeenCalled();
    C.authenticatedFetch.mockResolvedValue({ ok: false }); C.partnerHome.open('partner-pickups'); await button('VER RETIRADA').click();
    await vi.waitFor(() => expect(root.textContent).toContain('Sem foto do pneu'));
    expect(button('CONFIRMAR RETIRADA').disabled).toBe(false);
  });
  it('usa iniciais se o avatar falha e rejeita URLs executáveis', async () => {
    const { C, ready, root } = partnerScreen(); C.partnerData.state.pickups = [order]; ready(); C.partnerHome.open('partner-pickups');
    const frame = root.querySelectorAll('.pu-avatar')[0]; await frame.querySelectorAll('img')[0].fire('error');
    expect(frame.textContent).toBe('JS'); expect(frame.querySelectorAll('img')).toHaveLength(0);
    C.partnerData.state.pickups[0] = { ...order, customer_avatar_url: 'javascript:alert(1)' }; C.partnerHome.render();
    expect(root.querySelectorAll('img')).toHaveLength(0);
  });
  it('não anuncia retirada confirmada se o servidor não confirmou a transição', async () => {
    const { C, ready, root, button } = partnerScreen(); C.partnerData.state.pickups = [{ ...order, items: [] }];
    C.partnerData.api = vi.fn(async () => ({})); ready(); C.partnerHome.open('partner-pickups'); await button('VER RETIRADA').click();
    await button('CONFIRMAR RETIRADA').click(); await vi.waitFor(() => expect(root.textContent).toContain('Esse pedido já mudou'));
    expect(C.showToast).not.toHaveBeenCalled(); expect(C.partnerData.state.pickups).toHaveLength(1);
  });
});
