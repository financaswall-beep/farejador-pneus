import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

class Element {
  children: Element[] = [];
  value = '';
  className = '';
  src = '';
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  classList = { toggle: vi.fn(), add: vi.fn(), remove: vi.fn(), contains: vi.fn(() => false) };
  set textContent(value: string) { this.value = String(value); this.children = []; }
  get textContent(): string { return this.value + this.children.map(c => c.textContent).join(' '); }
  append(...children: Element[]) { this.children.push(...children); }
  appendChild(child: Element) { this.append(child); return child; }
  replaceChildren(...children: Element[]) { this.children = children; this.value = ''; }
  addEventListener() {}
  setAttribute() {}
  querySelector() { return this.children[0]; }
}
function screen() {
  const nodes: Record<string, Element> = {};
  const node = (id: string) => nodes[id] ??= new Element();
  const elements: any = new Proxy({}, { get: (_, key) => node(String(key)) });
  elements.salesEmpty.append(new Element());
  const state: any = { selectedSalesDay: null, salesPayload: null, weekOffset: 0, salesRequest: null };
  const Caixa: any = { elements, state, isPartner: () => false, stored: () => 'owner', keys: { role: 'role' },
    createSvg: () => new Element(), currency: new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }),
    dateTime: new Intl.DateTimeFormat('pt-BR'), openReceipt: vi.fn(), session: 'owner-session',
    sessionFingerprint: () => Caixa.session, token: () => 'token', canModule: () => true,
    operationPath: (_path: string, matrix: string) => matrix, authenticatedFetch: vi.fn(), json: (response: any) => response.json() };
  const context = { window: { Caixa }, document: { getElementById: node, createElement: () => new Element(), querySelectorAll: () => [],
    createTextNode: (text: string) => { const el = new Element(); el.textContent = text; return el; } }, Intl, Date,
    AbortController, URLSearchParams, DOMException };
  for (const file of ['caixa-sales-weekly.js', 'caixa-sales-view.js']) {
    runInNewContext(readFileSync('painel/public/' + file, 'utf8'), context);
  }
  return { Caixa, nodes, elements, loadController: () => runInNewContext(readFileSync('painel/public/caixa-sales.js', 'utf8'), context) };
}
const sale = { order_id: 'bot-order', order_number: 'PED-0019', status: 'delivered', payment_method: 'pix',
  total_amount: 193, items_quantity: 1, item_summary: 'Pneu Bridgestone 225/45-17', commission_amount: 0,
  seller_name: null, source: 'chatwoot_com_bot', created_at: '2026-09-23T11:48:00Z' };

describe('Vendas do app conforme a abrangência enviada pelo servidor', () => {
  it('mostra origem e comissões da equipe sem chamar de comissão do administrador', () => {
    const { Caixa, elements, nodes } = screen();
    Caixa.renderSales({ sales_scope: 'matrix', sales: [sale, { ...sale, order_id: 'staff', seller_name: 'Ana', source: 'walkin_balcao' }], summary: {}, daily_series: [] });
    expect(elements.appHeadingTitle.textContent).toBe('Vendas da Matriz');
    expect(elements.salesList.textContent).toContain('Bot');
    expect(elements.salesList.textContent).toContain('Balcão · Ana');
    expect(elements.salesList.textContent).not.toContain('Sua comissão');
    expect(nodes['weekly-commission-label'].textContent).toBe('Comissões das vendas');
    expect(nodes['weekly-scope-label'].textContent).toBe('Vendas da Matriz · bot e equipe');
  });
  it('preserva a visão pessoal e os rótulos dos funcionários e parceiros', () => {
    const { Caixa, elements, nodes } = screen();
    Caixa.renderSales({ sales: [sale], summary: {}, daily_series: [] });
    expect(elements.appHeadingTitle.textContent).toBe('Minhas vendas');
    expect(elements.salesList.textContent).toContain('Sua comissão');
    expect(nodes['weekly-commission-label'].textContent).toBe('Minha comissão');
    Caixa.isPartner = () => true;
    expect(Caixa.matrixSales()).toBe(false);
  });
  it('abre o pneu de carro com a imagem correta e identifica a origem do recibo', () => {
    const { Caixa, elements } = screen();
    Caixa.renderReceipt({ ...sale, sales_scope: 'matrix', seller_name: 'Sem vendedor vinculado',
      items: [{ product_name: 'Pneu Bridgestone', quantity: 1, unit_price: 180, line_total: 180, vehicle_type: 'car' }] });
    expect(elements.receiptContent.textContent).toContain('COMISSÃO DA VENDA');
    expect(elements.receiptContent.textContent).not.toContain('Você ganhou');
    expect(elements.receiptContent.textContent).toContain('Origem: Bot');
    const images = (el: Element): string[] => [el.src, ...el.children.flatMap(images)].filter(Boolean);
    expect(images(elements.receiptContent)).toContain('/operacao/catalog-tire-car.png');
  });

  it('descarta a resposta administrativa após troca de sessão e limpa a visão anterior', async () => {
    const { Caixa, elements, loadController } = screen(); loadController();
    let complete!: (result: unknown) => void;
    Caixa.authenticatedFetch.mockReturnValue(new Promise(resolve => { complete = resolve; }));
    const render = vi.spyOn(Caixa, 'renderSales');
    const pending = Caixa.loadSales();
    Caixa.session = 'employee-session'; Caixa.resetSales();
    complete({ ok: true, json: async () => ({ sales_scope: 'matrix', sales: [sale] }) });
    await pending;
    expect(render).not.toHaveBeenCalled(); expect(Caixa.state.salesPayload).toBeNull();
    expect(elements.salesList.textContent).toBe('');
    expect(elements.weeklySummary.classList.add).toHaveBeenCalledWith('hidden');
  });

  it('perfil continua pedindo indicadores pessoais', async () => {
    const { Caixa, loadController } = screen(); loadController();
    Caixa.authenticatedFetch.mockResolvedValue({ ok: true, json: async () => ({ summary: { sales_count: 1, revenue: 99 } }) });
    await Caixa.loadProfileSummary();
    expect(Caixa.authenticatedFetch).toHaveBeenCalledWith('/api/caixa/vendas?week=0&scope=own');
  });
});
