import { describe, expect, it, vi } from 'vitest';
import { partnerScreen, TestNode } from './helpers/partner-simple-dom.js';

const offer = (measure = '90/90-18', brand = 'Pirelli', price = 6500, quantity = 3) => ({
  offer_key: JSON.stringify([measure, brand, 'meia_vida']), measure, brand, tire_condition: 'meia_vida',
  vehicle_type: 'motorcycle', quantity_available: quantity, price_cents: price,
});
const reply = (body: unknown, ok = true) => ({ ok, json: async () => body });
async function catalog(rows = [offer()]) {
  const view = partnerScreen(); view.ready();
  view.C.authenticatedFetch.mockResolvedValue(reply({ rows, checkout_enabled: true }));
  view.C.partnerHome.open('partner-buy');
  await vi.waitFor(() => expect(view.C.partnerBuy.state.loaded).toBe(true));
  return view;
}
function add(root: TestNode, index = 0) {
  return root.querySelectorAll('article')[index].querySelectorAll('button').find(button => button.textContent === 'ADICIONAR')!;
}
async function openCart(view: Awaited<ReturnType<typeof catalog>>) {
  await view.button('Carrinho').click();
  await vi.waitFor(() => expect(view.C.partnerBuy.state.loading).toBe(false));
}

describe('Comprar e carrinho simples do parceiro', () => {
  it('oculta produtos sem preço publicado e bloqueia envio enquanto o catálogo é só consulta', async () => {
    const view = await catalog([offer(), {...offer('80/100-14'),price_cents:null} as any]);
    expect(view.root.querySelectorAll('article')).toHaveLength(1);
    await add(view.root).click(); await openCart(view);
    view.C.authenticatedFetch.mockResolvedValue(reply({rows:[offer()],checkout_enabled:false}));
    await view.C.partnerBuy.load();
    expect(view.button('ENVIAR PEDIDO').disabled).toBe(true);
    expect(view.root.textContent).toContain('Envio de pedidos em breve.');
    view.C.authenticatedFetch.mockClear(); await view.button('ENVIAR PEDIDO').click();
    expect(view.C.authenticatedFetch).not.toHaveBeenCalled();
  });
  it('separa variantes da mesma medida e volta do carrinho para o catálogo', async () => {
    const rows = [offer(), offer('90/90-18', 'Vipal', 6000)];
    const view = await catalog(rows);
    await add(view.root).click();
    expect(view.root.textContent).not.toContain('clientes pediram');
    await add(view.root, 1).click(); await openCart(view);
    expect(view.root.textContent).toContain('2 pneus • 1 medida');
    expect(view.root.querySelectorAll('article')).toHaveLength(2);
    expect(view.root.querySelectorAll('.ps-buy-total')[0].textContent).toBe('R$\u00a0125,00');
    await view.button('Voltar').click(); expect(view.location.hash).toBe('#comprar');
  });

  it('limita quantidade ao saldo disponível, calcula em centavos e remove o último item', async () => {
    const view = await catalog([offer('90/90-18', 'Pirelli', 1001, 2)]);
    await add(view.root).click(); await add(view.root).click();
    expect(add(view.root).disabled).toBe(true); await openCart(view);
    expect(view.button('Aumentar quantidade de 90/90-18').disabled).toBe(true);
    expect(view.root.querySelectorAll('.ps-buy-total')[0].textContent).toBe('R$\u00a020,02');
    await view.button('Diminuir quantidade de 90/90-18').click();
    expect(view.root.querySelectorAll('.ps-buy-total')[0].textContent).toBe('R$\u00a010,01');
    await view.button('Remover 90/90-18 do carrinho').click();
    expect(view.root.textContent).toContain('Seu carrinho está vazio.');
    expect(view.root.querySelectorAll('.ps-buy-send')).toHaveLength(0);
  });

  it('normaliza busca pelos dígitos e mantém o campo durante atualização dos avisos', async () => {
    const view = await catalog([offer(), offer('80/100-14')]);
    const input = view.root.querySelectorAll('input')[0]; input.value = '909018'; await input.fire('input');
    expect(view.root.textContent).toContain('90/90-18'); expect(view.root.textContent).not.toContain('80/100-14');
    view.C.partnerHome.render(); expect(view.root.querySelectorAll('input')[0]).toBe(input);
    expect(input.value).toBe('909018');
  });

  it('atualiza o preço e bloqueia envio quando o saldo do galpão diminui', async () => {
    const view = await catalog(); await add(view.root).click(); await add(view.root).click(); await openCart(view);
    view.C.authenticatedFetch.mockResolvedValue(reply({ rows: [offer('90/90-18', 'Pirelli', 7000, 1)], checkout_enabled: true }));
    await view.C.partnerBuy.load();
    expect(view.root.textContent).toContain('O estoque mudou. Ajuste as quantidades');
    expect(view.button('ENVIAR PEDIDO').disabled).toBe(true);
    expect(view.root.querySelectorAll('.ps-buy-total')[0].textContent).toBe('R$\u00a0140,00');
    await view.button('Diminuir quantidade de 90/90-18').click();
    expect(view.button('ENVIAR PEDIDO').disabled).toBe(false);
  });

  it('mantém o carrinho e a chave de envio quando a rede falha e limpa só após resposta', async () => {
    const view = await catalog(); await add(view.root).click(); await openCart(view);
    const bodies: any[] = [];
    view.C.authenticatedFetch.mockImplementation(async (_: string, options: any) => {
      bodies.push(JSON.parse(options.body));
      if (bodies.length === 1) throw Error('offline');
      return reply({ request_id: 'request-1', request_number: 'CMP-0001' });
    });
    await view.button('ENVIAR PEDIDO').click();
    expect(view.root.textContent).toContain('Seu carrinho foi mantido'); expect(view.C.partnerBuy.count()).toBe(1);
    await view.button('ENVIAR PEDIDO').click();
    expect(bodies[1].idempotency_key).toBe(bodies[0].idempotency_key);
    expect(bodies[0].items).toEqual([{ offer_key: offer().offer_key, quantity: 1, expected_price_cents: 6500 }]);
    expect(view.root.textContent).toContain('Pedido enviado'); expect(view.C.partnerBuy.count()).toBe(0);
  });

  it('impede envios duplicados e navegação enquanto o primeiro está em andamento', async () => {
    const view = await catalog(); await add(view.root).click(); await openCart(view);
    let finish!: (value: unknown) => void;
    view.C.authenticatedFetch.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    view.C.authenticatedFetch.mockClear();
    const send = view.button('ENVIAR PEDIDO'); const pending = send.click(); await send.click();
    view.C.partnerHome.open('partner-buy');
    expect(view.location.hash).toBe('#carrinho'); expect(view.C.authenticatedFetch).toHaveBeenCalledTimes(1);
    finish(reply({ request_id: 'request-1' })); await pending;
    expect(view.root.textContent).toContain('Pedido enviado');
  });

  it('não consulta a matriz ou acesso sem estoque e bloqueia envio por funcionário sem compras', async () => {
    for (const view of [partnerScreen(false), partnerScreen(true, { vendas: true })]) {
      await view.C.partnerBuy.load(); expect(view.C.authenticatedFetch).not.toHaveBeenCalled();
      expect(view.C.authorizedOperationTab('partner-buy')).not.toBe('partner-buy');
    }
    const view = await catalog(); view.storage.set('role', 'funcionario');
    await add(view.root).click(); await openCart(view);
    expect(view.button('ENVIAR PEDIDO').disabled).toBe(true);
    expect(view.root.textContent).toContain('Seu acesso não permite enviar compras');
  });

  it('limpa o carrinho na troca de sessão e ignora a resposta antiga', async () => {
    const view = await catalog(); await add(view.root).click();
    let finish!: (value: unknown) => void;
    view.C.authenticatedFetch.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const old = view.C.partnerBuy.load(); view.setSession('session-b');
    view.C.authenticatedFetch.mockResolvedValue(reply({ rows: [offer('80/100-14')] }));
    await view.C.partnerBuy.load(); finish(reply({ rows: [offer()] })); await old;
    expect(view.C.partnerBuy.count()).toBe(0);
    expect(view.C.partnerBuy.state.rows.map((row: any) => row.measure)).toEqual(['80/100-14']);
  });
});
