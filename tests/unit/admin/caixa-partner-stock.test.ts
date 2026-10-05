import { describe, expect, it, vi } from 'vitest';
import { partnerScreen, TestNode } from './helpers/partner-simple-dom.js';

const row = { stock_id: 'stock-a', item_type: 'pneu', tire_size: '90/90-18', tire_condition: 'meia_vida',
  is_tracked: true, quantity_on_hand: 3, quantity_reserved: 2 };
const reply = (body: unknown) => ({ ok: true, json: async () => body });
async function stockView(rows: object[] = [row]) {
  const view = partnerScreen(); view.ready();
  view.C.authenticatedFetch.mockResolvedValue(reply({ rows }));
  view.C.partnerHome.open('partner-stock');
  await vi.waitFor(() => expect(view.root.textContent).toContain('NA LOJA'));
  return view;
}
const steps = (root: TestNode) => root.querySelectorAll('button').filter(button => button.className.includes('ps-stock-step'));

describe('Estoque simples do parceiro com reservas preservadas', () => {
  it('separa saldo físico, disponível e reservado e busca medida pelos dígitos', async () => {
    const { root, C } = await stockView([row, { ...row, stock_id: 'b', tire_size: '80/100-14', quantity_reserved: 0 }]);
    expect(root.textContent).toContain('1 disponível'); expect(root.textContent).toContain('2 separados');
    const input = root.querySelectorAll('input')[0]; input.value = '9018'; await input.fire('input');
    expect(root.textContent).toContain('90/90-18'); expect(root.textContent).not.toContain('80/100-14');
    const before = input; C.partnerHome.render(); expect(root.querySelectorAll('input')[0]).toBe(before);
    expect(input.value).toBe('9018');
  });
  it('faz uma correção por vez usando saldo atualizado e permite desfazer a diminuição', async () => {
    const view = await stockView(); const { C, root, button } = view;
    let physical = 4; // Outro processo alterou o saldo depois que a tela abriu.
    C.authenticatedFetch.mockImplementation(async (_url: string, options: any) => {
      if (options?.method === 'POST') physical = JSON.parse(options.body).quantity_on_hand;
      return reply({ rows: [{ ...row, quantity_on_hand: physical }] });
    });
    C.authenticatedFetch.mockClear();
    const minus = steps(root)[0]; const first = minus.click(); const second = minus.click(); await Promise.all([first, second]);
    await vi.waitFor(() => expect(root.textContent).toContain('Desfazer'));
    const writes = C.authenticatedFetch.mock.calls.filter(([, options]: any) => options?.method === 'POST');
    expect(writes).toHaveLength(1);
    expect(writes[0]).toEqual(['/parceiro/meier/api/operacao/estoque/stock-a/saldo', expect.objectContaining({ body: JSON.stringify({ quantity_on_hand: 3 }) })]);
    await button('Desfazer').click();
    await vi.waitFor(() => expect(physical).toBe(4));
    expect(root.textContent).not.toContain('Desfazer');
  });
  it('bloqueia saldo abaixo do reservado inclusive quando uma nova reserva chega depois da tela', async () => {
    const view = await stockView([{ ...row, quantity_on_hand: 2 }]);
    expect(steps(view.root)[0].disabled).toBe(true);
    const second = await stockView();
    second.C.authenticatedFetch.mockClear();
    second.C.authenticatedFetch.mockResolvedValue(reply({ rows: [{ ...row, quantity_reserved: 3 }] }));
    await steps(second.root)[0].click();
    expect(second.C.authenticatedFetch.mock.calls.filter(([, options]: any) => options?.method === 'POST')).toHaveLength(0);
    expect(second.root.textContent).toContain('Esses pneus estão separados');
  });
  it('não inventa saldo ausente e impede novas correções depois de falha de atualização', async () => {
    const { root, C, button } = await stockView([{ ...row, quantity_on_hand: null }]);
    expect(root.textContent).toContain('Saldo não informado'); expect(steps(root).every(control => control.disabled)).toBe(true);
    C.authenticatedFetch.mockRejectedValueOnce(new Error('offline'));
    await C.partnerStock.load(); expect(root.textContent).toContain('Não consegui atualizar');
    C.authenticatedFetch.mockResolvedValue(reply({ rows: [row] })); await button('ATUALIZAR LISTA').click();
    expect(root.textContent).toContain('1 disponível'); expect(steps(root)[0].disabled).toBe(false);
  });
  it('ignora resposta de sessão anterior e não consulta estoque do parceiro na Matriz ou sem permissão', async () => {
    const { C, setSession, root } = await stockView();
    let finish!: (value: unknown) => void;
    C.authenticatedFetch.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const pending = C.partnerStock.load(); setSession('session-b'); C.partnerStock.reset();
    finish(reply({ rows: [{ ...row, tire_size: 'OLD-ACCOUNT' }] })); await pending;
    C.partnerStock.render(); expect(root.textContent).not.toContain('OLD-ACCOUNT');
    const matrix = partnerScreen(false); await matrix.C.partnerStock.load(); matrix.C.partnerStock.render();
    expect(matrix.C.authenticatedFetch).not.toHaveBeenCalled(); expect(matrix.root.textContent).toBe('');
    const denied = partnerScreen(true, { vendas: true, estoque: false }); await denied.C.partnerStock.load(); denied.C.partnerStock.render();
    expect(denied.C.authenticatedFetch).not.toHaveBeenCalled(); expect(denied.root.textContent).toBe('');
  });
  it('cadastra pelos campos sem foto, preserva o formulário ao atualizar avisos e recarrega a lista', async () => {
    const { C, root, button } = await stockView();
    C.populateCatalogBrandSelect = vi.fn((select: TestNode) => { select.value = 'Pirelli'; });
    await button('ADICIONAR PNEU').click();
    const form: any = root.querySelectorAll('form')[0]; form.reportValidity = () => true;
    const inputs: any[] = root.querySelectorAll('input');
    inputs.find(input => input.name === 'tire_size').value = '110/90-17';
    inputs.find(input => input.name === 'quantity_on_hand').value = '4';
    inputs.find(input => input.name === 'sale_price').value = '180';
    C.partnerHome.render(); expect(root.querySelectorAll('form')[0]).toBe(form);
    expect(inputs.some(input => input.type === 'file')).toBe(false);
    C.authenticatedFetch.mockClear(); C.authenticatedFetch.mockResolvedValue(reply({ rows: [row] }));
    await form.fire('submit');
    expect(C.authenticatedFetch.mock.calls[0]).toEqual(['/parceiro/meier/api/operacao/estoque/itens', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ tire_size: '110/90-17', brand: 'Pirelli', tire_condition: 'meia_vida', quantity_on_hand: 4, sale_price: 180 }),
    })]);
    expect(root.dataset.view).toBe('stock'); expect(root.textContent).toContain('90/90-18');
  });
  it('envia a condição escolhida e preserva os dados e limites da quantidade quando o cadastro falha', async () => {
    const { C, root, button } = await stockView();
    C.populateCatalogBrandSelect = vi.fn((select: TestNode) => { select.value = 'Pirelli'; });
    await button('ADICIONAR PNEU').click();
    const form: any = root.querySelectorAll('form')[0]; form.reportValidity = () => true;
    const inputs: any[] = root.querySelectorAll('input');
    const quantity = inputs.find(input => input.name === 'quantity_on_hand');
    await button('Aumentar quantidade').click(); expect(quantity.value).toBe('2');
    await button('Diminuir quantidade').click(); await button('Diminuir quantidade').click();
    expect(quantity.value).toBe('0'); expect(button('Diminuir quantidade').disabled).toBe(true);
    quantity.value = '999999'; await quantity.fire('input'); expect(button('Aumentar quantidade').disabled).toBe(true);
    quantity.value = '0'; await quantity.fire('input');
    inputs.find(input => input.name === 'tire_size').value = '90/90-18';
    inputs.find(input => input.name === 'sale_price').value = '50';
    inputs.filter(input => input.type === 'radio').forEach(input => { input.checked = input.value === 'novo'; });
    C.authenticatedFetch.mockClear(); C.authenticatedFetch.mockRejectedValueOnce(new Error('offline'));
    await form.fire('submit');
    expect(JSON.parse(C.authenticatedFetch.mock.calls[0][1].body)).toEqual({ tire_size: '90/90-18', brand: 'Pirelli', tire_condition: 'novo', quantity_on_hand: 0, sale_price: 50 });
    expect(root.querySelectorAll('form')[0]).toBe(form); expect(root.textContent).toContain('Não consegui cadastrar');
    expect(quantity.value).toBe('0'); expect(button('Diminuir quantidade').disabled).toBe(true);
    expect(button('Aumentar quantidade').disabled).toBe(false);
  });
  it('converte reais com vírgula sem alterar o valor e bloqueia preço inválido antes de enviar', async () => {
    const { C, root, button } = await stockView();
    C.populateCatalogBrandSelect = vi.fn((select: TestNode) => { select.value = 'Pirelli'; });
    await button('ADICIONAR PNEU').click();
    const form: any = root.querySelectorAll('form')[0]; form.reportValidity = () => true;
    const inputs: any[] = root.querySelectorAll('input');
    inputs.find(input => input.name === 'tire_size').value = '90/90-18';
    const price = inputs.find(input => input.name === 'sale_price');
    C.authenticatedFetch.mockClear();
    for (const value of ['', '0', '-10', '180.123', '1,2,3', '100000000']) {
      price.value = value; await form.fire('submit');
    }
    expect(C.authenticatedFetch).not.toHaveBeenCalled();
    price.value = '1234,56'; await price.fire('blur'); expect(price.value).toBe('1.234,56');
    C.authenticatedFetch.mockRejectedValueOnce(new Error('offline'));
    await form.fire('submit'); expect(JSON.parse(C.authenticatedFetch.mock.calls[0][1].body).sale_price).toBe(1234.56);
    C.authenticatedFetch.mockClear(); C.authenticatedFetch.mockRejectedValueOnce(new Error('offline'));
    price.value = '180.50'; await price.fire('blur'); expect(price.value).toBe('180,50');
    await form.fire('submit'); expect(JSON.parse(C.authenticatedFetch.mock.calls[0][1].body).sale_price).toBe(180.5);
  });
});
