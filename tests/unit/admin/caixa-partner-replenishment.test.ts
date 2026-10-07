import { describe, expect, it, vi } from 'vitest';
import { partnerScreen } from './helpers/partner-simple-dom.js';

const payload = {
  replenishment: { measure: '90/90-18', demand_count: 3, quantity_available: 8, period_days: 7 },
  rows: [{ measure: '90/90-18', brand: 'Pirelli', tire_condition: 'meia_vida', quantity_available: 8 }],
};
function catalogRow(row: any, index = 0) {
  return { ...row, offer_key: 'product-' + index, vehicle_type: 'motorcycle', price_cents: 6500 };
}
function responses(C: any, restock: any = payload, catalog = restock.rows.map(catalogRow)) {
  C.authenticatedFetch.mockImplementation(async (path: string) => ({
    ok: true, json: async () => path.endsWith('/reposicao') ? restock : path.endsWith('/comprar') ? { rows: catalog, checkout_enabled: false } : { rows: [] },
  }));
}
async function loaded(C: any) { await vi.waitFor(() => expect(C.partnerBuy.state.loaded && !C.partnerReplenishment.loading()).toBe(true)); }

describe('Oportunidade de reposição do parceiro', () => {
  it('carrega sem permissão de entrega e abre somente os pneus da oportunidade', async () => {
    const { C, root, ready, button, location, node } = partnerScreen(true, { estoque: true });
    ready(); responses(C); await C.partnerData.load();
    expect(root.textContent).toContain('Te pediram e você não tinha');
    expect(root.textContent).toContain('1 medida para repor');
    expect(root.textContent).not.toContain('Exemplo');
    await button('REPOR PNEUS').click();
    await loaded(C);
    expect(location.hash).toBe('#reposicao');
    expect(root.textContent).toContain('90/90-18');
    expect(root.textContent).toContain('3 clientes pediram');
    expect(root.textContent).toContain('8 disponíveis no galpão');
    expect(root.textContent).toContain('R$\u00a065,00');
    expect(root.querySelectorAll('.ps-buy-screw')).toHaveLength(4);
    expect(node('partner-home-buy').attributes['aria-current']).toBe('page');
    expect(root.textContent).not.toContain('Faturamento');
    await button('Voltar').click(); expect(location.hash).toBe('#pedidos');
  });
  it('remove o cartão quando a oportunidade acaba e descarta saldo antigo se a consulta falhar', async () => {
    const { C, root, ready } = partnerScreen(); ready(); responses(C); await C.partnerData.load();
    responses(C, { replenishment: null, rows: [] }); await C.partnerData.load();
    expect(root.textContent).not.toContain('Te pediram');
    expect(C.partnerData.state.offers).toEqual([]);
    responses(C); await C.partnerData.load();
    C.authenticatedFetch.mockImplementation(async (path: string) => {
      if (path.endsWith('/reposicao')) throw Error('offline');
      return { ok: true, json: async () => ({ rows: [] }) };
    });
    await C.partnerData.load();
    expect(C.partnerData.state.replenishment).toBeNull();
    expect(root.textContent).not.toContain('REPOR PNEUS');
    C.partnerHome.open('partner-replenishment');
    await vi.waitFor(() => expect(root.textContent).toContain('Não consegui atualizar a reposição'));
    expect(root.querySelectorAll('.ps-buy-item')).toHaveLength(0);
  });
  it('conta medidas, sem somar clientes nem variantes, e abre todas as oportunidades', async () => {
    const { C, root, ready, button } = partnerScreen(); ready();
    const measures = [
      { measure: '100/90-18', demand_count: 4, quantity_available: 10 },
      { measure: '90/90-18', demand_count: 3, quantity_available: 12 },
      { measure: '80/100-14', demand_count: 2, quantity_available: 8 },
      { measure: '110/90-17', demand_count: 8, quantity_available: 0 },
    ];
    responses(C, { replenishment: { ...measures[0], measures }, rows: measures.map(row => ({ ...row, brand: 'Pirelli', tire_condition: 'meia_vida' })) });
    await C.partnerData.load(); expect(root.textContent).toContain('3 medidas para repor');
    expect(root.textContent).not.toContain('9 medidas');
    await button('REPOR PNEUS').click();
    await loaded(C);
    for (const row of measures.slice(0, 3)) expect(root.textContent).toContain(row.measure);
    expect(root.textContent).not.toContain('110/90-17');
  });
  it('respeita a permissão de estoque, o ambiente matriz e o fim da sessão', async () => {
    const denied = partnerScreen(true, { vendas: true }); denied.ready(); responses(denied.C);
    await denied.C.partnerData.load();
    expect(denied.C.authenticatedFetch.mock.calls.some(([path]: [string]) => path.endsWith('/reposicao'))).toBe(false);
    expect(denied.C.authorizedOperationTab('partner-replenishment')).toBe('partner-home');
    const matrix = partnerScreen(false); await matrix.C.partnerData.load();
    expect(matrix.C.authenticatedFetch).not.toHaveBeenCalled();
    const own = partnerScreen(); own.ready(); responses(own.C); await own.C.partnerData.load();
    own.C.partnerHome.reset(); expect(own.C.partnerData.state.offers).toEqual([]);
    expect(own.C.partnerData.state.replenishment).toBeNull();
  });
  it('usa só variantes elegíveis e publicadas, com preço, saldo e chave do catálogo', async () => {
    const { C, root, ready } = partnerScreen(); ready();
    const eligible = { measure: '90-90/18', brand: 'PIRELLI', tire_condition: 'meia_vida', quantity_available: 99 };
    const restock = { replenishment: { ...payload.replenishment, measure: '909018' }, rows: [eligible, eligible] };
    const correct = { ...catalogRow(payload.rows[0]), quantity_available: 2, price_cents: 7500 };
    responses(C, restock, [correct,
      { ...correct, offer_key: 'other-brand', brand: 'Michelin' },
      { ...correct, offer_key: 'other-condition', tire_condition: 'novo' },
      { ...correct, offer_key: 'unpublished', price_cents: null },
      { ...correct, offer_key: 'empty', quantity_available: 0 },
    ]);
    C.partnerHome.open('partner-replenishment'); await loaded(C);
    const cards = root.querySelectorAll('.ps-buy-item');
    expect(cards).toHaveLength(1);
    expect(cards[0].dataset.offer).toBe('product-0');
    expect(cards[0].textContent).toContain('R$\u00a075,00');
    expect(cards[0].textContent).toContain('2 disponíveis no galpão');
    expect(cards[0].textContent).not.toContain('99 disponíveis');
    responses(C, restock, []); await C.partnerReplenishment.refresh();
    expect(root.querySelectorAll('.ps-buy-item')).toHaveLength(0);
    expect(root.textContent).toContain('ainda não estão disponíveis para compra');
  });
  it('compartilha o carrinho com Comprar, sem duplicar a variante e retornando à reposição', async () => {
    const { C, ready, root, button, location } = partnerScreen(); ready(); responses(C);
    C.partnerHome.open('partner-replenishment'); await loaded(C);
    await button('ADICIONAR').click(); expect(C.partnerBuy.count()).toBe(1);
    C.partnerHome.open('partner-buy');
    await vi.waitFor(() => expect(C.partnerBuy.state.loading).toBe(false));
    await button('ADICIONAR').click();
    expect(C.partnerBuy.count()).toBe(2); expect(C.partnerBuy.state.cart.size).toBe(1);
    C.partnerHome.open('partner-replenishment'); await loaded(C);
    await root.querySelectorAll('.ps-buy-control--cart')[0].click();
    expect(location.hash).toBe('#carrinho');
    await vi.waitFor(() => expect(C.partnerBuy.state.loading).toBe(false));
    expect(root.textContent).toContain('R$\u00a0130,00');
    expect(button('ENVIAR PEDIDO').disabled).toBe(true);
    await button('Voltar').click(); await loaded(C);
    expect(location.hash).toBe('#reposicao');
    expect(C.partnerBuy.count()).toBe(2);
  });
  it('não mantém cards de compra quando a atualização da procura falha', async () => {
    const { C, ready, root } = partnerScreen(); ready(); responses(C);
    C.partnerHome.open('partner-replenishment'); await loaded(C);
    expect(root.querySelectorAll('.ps-buy-item')).toHaveLength(1);
    C.authenticatedFetch.mockImplementation(async (path: string) => {
      if (path.endsWith('/reposicao')) throw Error('offline');
      return { ok: true, json: async () => ({ rows: [catalogRow(payload.rows[0])] }) };
    });
    await C.partnerReplenishment.refresh();
    expect(root.querySelectorAll('.ps-buy-item')).toHaveLength(0);
    expect(root.textContent).toContain('Não consegui atualizar a reposição');
    responses(C); await C.partnerReplenishment.refresh();
    expect(root.querySelectorAll('.ps-buy-item')).toHaveLength(1);
  });
  it('um resultado da sessão anterior não preenche a nova loja', async () => {
    const { C, ready, setSession } = partnerScreen(); ready();
    let done: (value: unknown) => void = () => {};
    C.authenticatedFetch.mockImplementation(async (path: string) => path.endsWith('/reposicao')
      ? new Promise(resolve => { done = resolve; }) : { ok: true, json: async () => ({ rows: [] }) });
    const loading = C.partnerData.load(); setSession('session-b');
    C.partnerData.reset(); done({ ok: true, json: async () => payload }); await loading;
    expect(C.partnerData.state.replenishment).toBeNull();
  });
});
