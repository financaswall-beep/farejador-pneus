import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { partnerScreen, TestNode } from './helpers/partner-simple-dom.js';

const tire = { stock_id: 'stock-a', item_type: 'pneu', tire_size: '90/90-18', brand: 'Pirelli',
  tire_condition: 'meia_vida', is_tracked: true, quantity_on_hand: 3, quantity_reserved: 2 };
const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
async function priceView(owner = true) {
  const view = partnerScreen();
  if (!owner) view.storage.set('role', 'estoque');
  const close = editor(view);
  let price: number | null = 89;
  view.C.authenticatedFetch.mockImplementation(async (url: string, options: any) => {
    if (options?.method === 'POST') {
      price = JSON.parse(options.body).sale_price;
      return reply({ changed: true, stock_id: tire.stock_id, sale_price: price });
    }
    return reply({ rows: url.endsWith('estoque-valores') ? [{ stock_id: tire.stock_id, sale_price: price }] : [tire] });
  });
  view.ready(); view.C.partnerHome.open('partner-stock');
  await vi.waitFor(() => expect(view.root.textContent).toContain('NA LOJA'));
  return { ...view, close };
}
function editor(view: ReturnType<typeof partnerScreen>) {
  const close = new TestNode('button');
  Object.assign(view.context.document, { querySelectorAll: () => [close], addEventListener: vi.fn() });
  Object.assign(view.node('stock-price-form'), { reset: () => { view.node('stock-price-reason').value = ''; } });
  view.node('stock-price-modal').classList.add('hidden');
  runInNewContext(readFileSync('painel/public/caixa-stock-price.js', 'utf8'), view.context);
  return close;
}

describe('editar o preço de venda em Meus pneus', () => {
  it('mostra o preço local e abre o editor no pneu certo, sem mostrar preço de compra', async () => {
    const view = await priceView();
    expect(view.root.textContent).toContain('Preço de venda');
    expect(view.root.textContent.replace(/\s/g, '')).toContain('R$89,00');
    await view.button('Editar preço').click();
    expect(view.node('stock-price-modal').classList.contains('hidden')).toBe(false);
    expect(view.node('stock-price-product').textContent).toContain('Pirelli');
    expect(view.node('stock-price-product').textContent).toContain('90/90-18');
    expect(view.node('stock-price-value').value).toBe('89,00');
    expect(view.node('stock-price-submit').textContent).toBe('Salvar preço');
  });

  it('salva somente preço e motivo, recarrega a lista e preserva saldo e reservas', async () => {
    const view = await priceView(); await view.button('Editar preço').click();
    view.node('stock-price-value').value = '99,90'; view.node('stock-price-reason').value = 'Ajuste da revenda';
    await view.node('stock-price-form').fire('submit');
    const writes = view.C.authenticatedFetch.mock.calls.filter(([, options]: any) => options?.method === 'POST');
    expect(writes).toEqual([['/parceiro/meier/api/operacao/estoque/stock-a/preco', expect.objectContaining({
      body: JSON.stringify({ sale_price: 99.9, reason: 'Ajuste da revenda' }),
    })]]);
    expect(view.root.textContent.replace(/\s/g, '')).toContain('R$99,90');
    expect(view.root.textContent).toContain('1 disponível'); expect(view.root.textContent).toContain('2 separados');
    expect(view.node('stock-price-modal').classList.contains('hidden')).toBe(true);
  });

  it('esconde a edição de funcionários e impede enviar pela sessão de outra loja', async () => {
    const employee = await priceView(false);
    expect(employee.button('Editar preço')).toBeUndefined();
    employee.C.openStockPrice({ ...tire, sale_price: 89 });
    expect(employee.node('stock-price-modal').classList.contains('hidden')).toBe(true);
    const owner = await priceView(); await owner.button('Editar preço').click();
    owner.node('stock-price-value').value = '100'; owner.node('stock-price-reason').value = 'Ajuste';
    owner.setSession('outra-loja'); await owner.node('stock-price-form').fire('submit');
    expect(owner.C.authenticatedFetch.mock.calls.filter(([, options]: any) => options?.method === 'POST')).toHaveLength(0);
  });

  it('não duplica o salvamento e mantém o formulário depois de erro', async () => {
    const view = await priceView(); await view.button('Editar preço').click();
    view.node('stock-price-reason').value = 'Ajuste';
    for (const value of ['0', '-1', '12,345', '1,2,3', '100000000']) {
      view.node('stock-price-value').value = value; await view.node('stock-price-form').fire('submit');
    }
    expect(view.C.authenticatedFetch.mock.calls.filter(([, options]: any) => options?.method === 'POST')).toHaveLength(0);
    view.node('stock-price-value').value = '110,00';
    let finish!: (value: unknown) => void;
    view.C.authenticatedFetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = view.node('stock-price-form').fire('submit');
    await view.node('stock-price-form').fire('submit'); await view.close.click();
    expect(view.node('stock-price-modal').classList.contains('hidden')).toBe(false);
    expect(view.C.authenticatedFetch.mock.calls.filter(([, options]: any) => options?.method === 'POST')).toHaveLength(1);
    finish(reply({ error: 'request_failed' }, 500)); await first;
    expect(view.node('stock-price-value').value).toBe('110,00');
    expect(view.node('stock-price-error').textContent).toContain('Não foi possível');
    expect(view.node('stock-price-submit').disabled).toBe(false);
  });

  it('mantém os controles de saldo quando a leitura do preço falha e permite tentar de novo', async () => {
    const view = await priceView();
    view.C.authenticatedFetch.mockImplementation(async (url: string) => url.endsWith('estoque-valores')
      ? reply({ error: 'unavailable' }, 503) : reply({ rows: [tire] }));
    await view.C.partnerStock.load();
    expect(view.root.textContent).toContain('Preço indisponível');
    expect(view.button('Editar preço').disabled).toBe(true);
    expect(view.root.querySelectorAll('.ps-stock-step').every(button => !button.disabled)).toBe(true);
    view.C.authenticatedFetch.mockImplementation(async (url: string) => reply({ rows: url.endsWith('estoque-valores')
      ? [{ stock_id: tire.stock_id, sale_price: 95 }] : [tire] }));
    await view.button('ATUALIZAR PREÇOS').click();
    expect(view.root.textContent.replace(/\s/g, '')).toContain('R$95,00');
    expect(view.button('Editar preço').disabled).toBe(false);
  });

  it('ignora o retorno da conta anterior depois de sair durante o salvamento', async () => {
    const view = await priceView(); await view.button('Editar preço').click();
    view.node('stock-price-value').value = '99'; view.node('stock-price-reason').value = 'Ajuste';
    let finish!: (value: unknown) => void;
    view.C.authenticatedFetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = view.node('stock-price-form').fire('submit');
    view.setSession('outra-loja'); view.C.partnerStock.reset(); view.C.showToast.mockClear();
    view.C.openStockPrice({ ...tire, stock_id: 'stock-b', sale_price: 150 });
    finish(reply({ changed: true, sale_price: 99 })); await pending;
    expect(view.node('stock-price-value').value).toBe('150,00');
    expect(view.node('stock-price-modal').classList.contains('hidden')).toBe(false);
    expect(view.C.showToast).not.toHaveBeenCalled();
  });

  it('mantém a edição da Matriz usando o endpoint e as atualizações do catálogo próprios', async () => {
    const view = partnerScreen(false); editor(view);
    view.C.operationPath = (path: string) => '/api/caixa/' + path;
    view.C.loadStock = vi.fn(); view.C.loadOperationCatalog = vi.fn(); view.C.loadCatalog = vi.fn();
    view.C.authenticatedFetch.mockResolvedValue(reply({ changed: true, sale_price: 99.9 }));
    view.C.openStockPrice({ ...tire, sale_price: 89 });
    view.node('stock-price-value').value = '99,90'; view.node('stock-price-reason').value = 'Tabela da Matriz';
    await view.node('stock-price-form').fire('submit');
    expect(view.C.authenticatedFetch).toHaveBeenCalledWith('/api/caixa/operacao/estoque/stock-a/preco',
      expect.objectContaining({ body: JSON.stringify({ sale_price: 99.9, reason: 'Tabela da Matriz' }) }));
    expect(view.C.loadStock).toHaveBeenCalledOnce(); expect(view.C.loadOperationCatalog).toHaveBeenCalledWith(1);
    expect(view.C.loadCatalog).toHaveBeenCalledOnce();
  });
});
