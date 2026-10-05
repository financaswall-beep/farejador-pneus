import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { TestNode } from './helpers/partner-simple-dom.js';

class Node extends TestNode {
  parentNode: Node | null = null;
  declare children: Node[];
  get nextSibling(): Node | null {
    if (!this.parentNode) return null;
    return this.parentNode.children[this.parentNode.children.indexOf(this) + 1] || null;
  }
  get isConnected(): boolean { return this.tagName === 'document' || Boolean(this.parentNode?.isConnected); }
  append(...nodes: Node[]) { nodes.forEach(node => this.appendChild(node)); }
  appendChild(node: Node): Node { return this.insertBefore(node, null); }
  insertBefore(node: Node, next: Node | null): Node {
    if (node.parentNode) node.parentNode.children = node.parentNode.children.filter(child => child !== node);
    node.parentNode = this;
    this.children.splice(next ? this.children.indexOf(next) : this.children.length, 0, node);
    return node;
  }
  replaceChildren(...nodes: Node[]) {
    this.children.forEach(child => { child.parentNode = null; }); this.children = []; this.ownText = '';
    this.append(...nodes);
  }
  querySelector() { return this.children[0]; }
}
function screen() {
  const nodes: Record<string, Node> = {};
  const node = (id: string) => nodes[id] ||= new Node();
  const elements: any = new Proxy({}, { get: (_, key) => node(String(key)) });
  const documentRoot = new Node('document');
  const sessionView = node('sessionView');
  documentRoot.append(sessionView, node('partner-home-screen'), node('partner-home-panel'), elements.receiptModal, node('afterReceipt'));
  elements.receiptModal.append(elements.receiptContent);
  sessionView.append(elements.salesPanel, node('nextPanel'));
  elements.salesPanel.append(elements.weeklySummary, elements.salesList);
  const weekNav = node('weekNav');
  weekNav.append(elements.weeklyPrev, node('weekCopy'), elements.weeklyNext);
  elements.weeklySummary.append(weekNav, node('summaryHead'));
  elements.salesEmpty.append(new Node('span'));
  const state = { selectedSalesDay: null, salesPayload: null, weekOffset: 0, salesRequest: null };
  let partner = true; let permission = true; let session = 'partner-a';
  const C: any = { elements, state,
    isPartner: () => partner, canModule: () => permission, sessionFingerprint: () => session, token: () => session,
    operationPath: (path: string, matrix: string) => partner ? '/parceiro/meier/api/' + path : matrix,
    stored: () => 'owner', keys: { role: 'role' }, createSvg: () => new Node('svg'),
    currency: new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }),
    dateTime: new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo' }),
    authenticatedFetch: vi.fn(), json: (response: any) => response.json(),
  };
  const context = { window: { Caixa: C }, document: { getElementById: node, createElement: (tag: string) => new Node(tag),
    createTextNode: (text: string) => { const result = new Node('#text'); result.textContent = text; return result; }, querySelectorAll: () => [] },
    Intl, Date, AbortController, URLSearchParams, DOMException };
  for (const file of ['partner-ui', 'sales-weekly', 'sales-view', 'sales', 'partner-receipt', 'partner-sales']) {
    runInNewContext(readFileSync('painel/public/caixa-' + file + '.js', 'utf8'), context);
  }
  return { C, elements, node, root: node('partner-home-screen'), sessionView,
    scope: (value: boolean) => { partner = value; }, permission: (value: boolean) => { permission = value; },
    session: (value: string) => { session = value; },
  };
}
const sale = { order_id: 'sale-a', order_number: 'PED-0248', status: 'delivered', payment_method: 'pix',
  total_amount: 180, created_at: '2026-10-03T18:30:00Z', items_quantity: 1, item_summary: '90/90-18',
  commission_amount: 9, commission_kind: 'percent', commission_value: 5 };
const summary = { revenue: 180, sales_count: 1, items_quantity: 1, average_ticket: 180, commission_amount: 9 };
const payload = { week_offset: -1, summary, sales: [sale], daily_series: [
  { date: '2026-10-02', revenue: 0, sales_count: 0 }, { date: '2026-10-03', ...summary },
] };
const response = (body: unknown) => ({ ok: true, json: async () => body });

describe('Vendas metálicas do parceiro reutilizando os motores existentes', () => {
  it('monta uma única tela e devolve os controles à Matriz na mesma posição', () => {
    const { C, root, sessionView, elements, node, scope } = screen();
    C.partnerSales.render();
    expect(elements.salesPanel.parentNode.parentNode).toBe(root);
    const page = elements.salesPanel.parentNode;
    expect(elements.weeklyPrev.parentNode.parentNode).toBe(page.children[0]);
    C.partnerSales.render(); expect(elements.salesPanel.parentNode).toBe(page);
    C.partnerSales.leave();
    expect(elements.weeklySummary.children).toEqual([node('weekNav'), node('summaryHead')]);
    expect(sessionView.children).toEqual([elements.salesPanel, node('nextPanel')]);
    expect(elements.salesPanel.classList.contains('hidden')).toBe(true);
    scope(false); C.partnerSales.render();
    expect(elements.salesPanel.parentNode).toBe(sessionView);
  });
  it('consulta somente as vendas do parceiro e respeita sessão e permissão', async () => {
    const view = screen(); const { C } = view;
    C.partnerSales.render();
    C.authenticatedFetch.mockResolvedValue(response(payload));
    await C.partnerSales.load();
    expect(C.authenticatedFetch.mock.calls[0][0]).toBe('/parceiro/meier/api/minhas-vendas?week=0');
    expect(view.elements.weeklyWeekState.textContent).toBe('Semana anterior');
    expect(view.elements.salesList.textContent).toContain('03/10');
    expect(view.elements.salesList.textContent).toContain('Sua comissão:');
    C.authenticatedFetch.mockClear(); view.permission(false); await C.partnerSales.load();
    expect(C.authenticatedFetch).not.toHaveBeenCalled();
    view.permission(true); view.scope(false); await C.partnerSales.load();
    expect(C.authenticatedFetch).not.toHaveBeenCalled();
  });
  it('troca semanas pelas setas, bloqueia o futuro e mantém o limite de 52 semanas', async () => {
    const { C, elements } = screen(); C.partnerSales.render();
    C.authenticatedFetch.mockImplementation(async (url: string) => response({ ...payload,
      week_offset: Number(new URL(url, 'http://localhost').searchParams.get('week')) }));
    await C.partnerSales.load();
    expect(elements.weeklyNext.disabled).toBe(true);
    await elements.weeklyPrev.click();
    await vi.waitFor(() => expect(elements.weeklyWeekState.textContent).toBe('Semana anterior'));
    expect(C.authenticatedFetch.mock.calls.at(-1)[0]).toContain('week=-1');
    await elements.weeklyNext.click();
    await vi.waitFor(() => expect(elements.weeklyWeekState.textContent).toBe('Semana atual'));
    const calls = C.authenticatedFetch.mock.calls.length; await elements.weeklyNext.click();
    expect(C.authenticatedFetch).toHaveBeenCalledTimes(calls);
    C.state.weekOffset = -52; C.renderSales({ ...payload, week_offset: -52 });
    expect(elements.weeklyPrev.disabled).toBe(true);
    await elements.weeklyPrev.click(); expect(C.authenticatedFetch).toHaveBeenCalledTimes(calls);
  });
  it('filtra resumo e lista pelo dia e não perde a seleção ao atualizar avisos', () => {
    const { C, elements } = screen(); C.partnerSales.render(); C.renderSales(payload);
    C.selectSalesDay('2026-10-02');
    expect(elements.weeklyTotal.textContent).toContain('0,00');
    expect(elements.salesList.children).toHaveLength(0);
    expect(elements.salesEmpty.textContent).toBe('Nenhuma venda neste dia.');
    expect(elements.weeklyClearDay.classList.contains('hidden')).toBe(false);
    C.partnerSales.render(); expect(C.state.selectedSalesDay).toBe('2026-10-02');
    C.clearSalesDay(); expect(elements.salesList.children).toHaveLength(1);
    expect(elements.weeklyTotal.textContent).toContain('180,00');
  });
  it('abre detalhes pelo pedido e fecha o recibo ao sair da tela', async () => {
    const { C, elements } = screen(); C.partnerSales.render(); C.renderSales(payload);
    C.authenticatedFetch.mockResolvedValue(response({ ...sale, items: [], seller_name: 'João' }));
    const button = elements.salesList.querySelectorAll('button')[0]; await button.click();
    await vi.waitFor(() => expect(elements.receiptContent.textContent).toContain('Minha comissão'));
    expect(C.authenticatedFetch.mock.calls[0][0]).toBe('/parceiro/meier/api/minhas-vendas/sale-a');
    expect(elements.receiptModal.classList.contains('hidden')).toBe(false);
    C.partnerSales.leave(); expect(elements.receiptModal.classList.contains('hidden')).toBe(true);
  });
  it('não exibe resposta antiga após troca de conta e permite repetir uma consulta com erro', async () => {
    const { C, session, elements } = screen(); C.partnerSales.render();
    let finish!: (value: unknown) => void;
    C.authenticatedFetch.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const pending = C.partnerSales.load();
    session('partner-b'); C.partnerSales.leave(); C.resetSales();
    finish(response(payload)); await pending;
    expect(C.state.salesPayload).toBeNull(); expect(elements.salesList.children).toHaveLength(0);
    C.partnerSales.render(); C.authenticatedFetch.mockRejectedValueOnce(new Error('offline'));
    await C.partnerSales.load(); expect(elements.salesError.classList.contains('hidden')).toBe(false);
    C.authenticatedFetch.mockResolvedValue(response({ week_offset: 0, summary: {}, daily_series: [], sales: [] }));
    await C.partnerSales.load(); expect(elements.salesEmpty.classList.contains('hidden')).toBe(false);
    expect(elements.salesError.classList.contains('hidden')).toBe(true);
  });

  it('usa o detalhe em tela cheia só no parceiro e restaura o recibo ao voltar', async () => {
    const { C, elements, node, scope } = screen();
    const original = elements.receiptModal.parentNode;
    C.authenticatedFetch.mockResolvedValue(response({ ...sale, items: [] }));
    await C.openReceipt(sale.order_id);
    expect(elements.receiptModal.parentNode).toBe(node('partner-home-panel'));
    expect(elements.receiptModal.attributes.role).toBe('region');
    expect(elements.receiptModal.attributes['aria-modal']).toBeUndefined();
    C.closeReceipt();
    expect(elements.receiptModal.parentNode).toBe(original);
    expect(elements.receiptModal.nextSibling).toBe(node('afterReceipt'));
    expect(elements.receiptModal.attributes.role).toBe('dialog');
    expect(elements.receiptModal.attributes['aria-modal']).toBe('true');
    scope(false); await C.openReceipt(sale.order_id);
    expect(elements.receiptModal.parentNode).toBe(original);
    expect(elements.receiptModal.classList.contains('pr-detail')).toBe(false);
    expect(C.authenticatedFetch.mock.calls.at(-1)[0]).toBe('/api/caixa/vendas/sale-a/recibo');
  });

  it('mantém total, quantidade, marca e imagem sem duplicar o preço unitário normal', () => {
    const { C, elements } = screen();
    C.renderReceipt({ ...sale, seller_name: 'João', commission_status: 'receivable', items: [
      { product_name: 'Pneu Bridgestone 225/45-17', quantity: 2, unit_price: 90,
        reference_unit_price: 90, line_total: 180, vehicle_type: 'car' },
    ] });
    const text = elements.receiptContent.textContent;
    expect(text).toContain('225/45-17'); expect(text).toContain('Bridgestone');
    expect(text).toContain('2 pneus'); expect(text).toContain('Você ganhou R$');
    expect(text).toContain('A receber'); expect(text).not.toContain(' cada');
    const image = elements.receiptContent.querySelectorAll('img')[0] as Node & { src: string };
    expect(image.src).toBe('/operacao/catalog-tire-car.png');
    expect(elements.receiptContent.querySelectorAll('strong').filter(el => el.className === 'pr-recessed').map(el => el.textContent))
      .toEqual([C.currency.format(180), C.currency.format(180)]);
  });

  it('preserva a informação de negociação e os estados reais da comissão', () => {
    const { C, elements } = screen();
    C.renderReceipt({ ...sale, commission_status: 'paid', items: [
      { product_name: 'Pneu 90/90-18', quantity: 1, unit_price: 180, reference_unit_price: 200, line_total: 180 },
    ] });
    expect(elements.receiptContent.textContent).toContain('Oficial R$');
    expect(elements.receiptContent.textContent).toContain('negociado R$');
    expect(elements.receiptContent.textContent).toContain('Paga');
    C.renderReceipt({ ...sale, status: 'cancelled', commission_status: 'reversed', seller_name: null, items: [] });
    expect(elements.receiptContent.textContent).toContain('Cancelada');
    expect(elements.receiptContent.textContent).not.toContain('Concluída');
    expect(elements.receiptContent.textContent).not.toContain('null');
  });

  it('descarta o detalhe que chega depois de fechar e permite voltar quando a consulta falha', async () => {
    const { C, elements, node } = screen();
    let finish!: (value: unknown) => void;
    C.authenticatedFetch.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const pending = C.openReceipt(sale.order_id);
    expect(node('receipt-print').disabled).toBe(true);
    C.closeReceipt();
    finish(response({ ...sale, items: [] })); await pending;
    expect(elements.receiptContent.textContent).toBe('');
    expect(elements.receiptModal.classList.contains('hidden')).toBe(true);
    C.authenticatedFetch.mockRejectedValueOnce(new Error('offline'));
    await C.openReceipt(sale.order_id);
    expect(elements.receiptContent.textContent).toBe('Não foi possível abrir esta venda.');
    expect(node('receipt-print').disabled).toBe(true);
    C.closeReceipt(); expect(elements.receiptModal.classList.contains('pr-detail')).toBe(false);
  });
});
