import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function load() {
  const nodes = new Map<string, any>();
  function element(id: string): any {
    if (!nodes.has(id)) {
      const classes = new Set<string>();
      const item: any = { textContent: '', dataset: {}, inert: false, open: false, style: {},
        appendChild: vi.fn(), addEventListener: vi.fn(), close: vi.fn(), focus: vi.fn(),
        classList: { contains: (v: string) => classes.has(v), add: (v: string) => classes.add(v),
          toggle: (v: string, value: boolean) => value ? classes.add(v) : classes.delete(v) } };
      item.closest = () => item;
      nodes.set(id, item);
    }
    return nodes.get(id);
  }
  const month = element('mf-month'), status = { parentElement: element('status') };
  const out = element('direction-out'), incoming = element('direction-in');
  out.dataset.maDirection = 'out'; incoming.dataset.maDirection = 'in';
  const C: any = { token: () => 'session', isPartner: () => false, elements: { app: element('app') },
    showToast: vi.fn(), financePayment: { busy: vi.fn(() => false) },
    financeView: { number: (value: any) => {
      if (value == null || value === '' || !Number.isFinite(Number(value))) throw Error('invalid');
      return Number(value);
    }, money: (value: number | string) => Number(value).toFixed(2), amount: (target: string | any, value: string) => {
      const item = typeof target === 'string' ? element(target) : target;
      item.dataset.mfMoney = value; item.textContent = value;
    } } };
  const window: any = { Caixa: C, FarejadorTime: { dateKey: () => '2026-10-27' } };
  const document = { getElementById: element, addEventListener: vi.fn(), querySelector: () => status,
    querySelectorAll: () => [out, incoming] };
  vm.runInNewContext(readFileSync('painel/public/caixa-finance-clean.js', 'utf8'), { window, document, Date });
  return { clean: C.financeClean, C, element, month, out, incoming };
}
const agenda = (items: any[]) => ({ period: '2026-09', agenda: { a_pagar: { total: '99.00', itens: items } } });
const row = (nome: string, valor: string, due_date = '2026-10-27') => ({ nome, valor, due_date });

describe('apresentação limpa do Financeiro', () => {
  it('mostra o vencimento civil atual mesmo num resumo de outro mês e soma em centavos', () => {
    const { clean, element } = load();
    clean.summary(agenda([row('Internet', '0.10'), row('Combustível', '0.20'), row('Aluguel', '98.70', '2026-11-05')]));
    expect(element('mfc-today-amount').dataset.mfMoney).toBe('0.30');
    expect(element('mfc-today-count').textContent).toBe('2 contas');
    expect(element('mfc-today-names').textContent).toBe('Internet e Combustível');
    expect(element('mfc-today-open').dataset.today).toBe('true');
  });
  it('distingue ausência de vencimentos de indisponibilidade da agenda ou de seus valores', () => {
    const { clean, element } = load();
    clean.summary(agenda([]));
    expect(element('mfc-today-amount').dataset.mfMoney).toBe('0.00');
    expect(element('mfc-today-names').textContent).toBe('Nenhuma conta vence hoje.');
    for (const payload of [{}, { agenda: null }, agenda([row('Inválida', '')]), agenda([row('Inválida', 'NaN')])]) {
      clean.summary(payload);
      expect(element('mfc-today-amount').dataset.mfMoney).toBe('—');
      expect(element('mfc-today-count').textContent).toBe('Indisponível');
      expect(element('mfc-today-open').dataset.today).toBe('false');
    }
  });
  it('usa o total publicado nas contas abertas e o subtotal da seleção apenas quando filtrada', () => {
    const { clean, element, out, incoming } = load();
    const payload = { agenda: { a_pagar: { total: '110.00', itens: [row('A', '10.00'), row('B', '100.00')] },
      a_receber: { total: '30.00', itens: [row('C', '30.00')] } } };
    const state = { status: 'open', direction: 'out', category: 'all', search: '', today: false };
    clean.accounts(payload, state, payload.agenda.a_pagar.itens);
    expect(element('mfc-accounts-total').dataset.mfMoney).toBe('110.00');
    expect(out.textContent).toBe('A pagar · 2'); expect(incoming.textContent).toBe('A receber · 1');
    clean.accounts(payload, { ...state, today: true }, [payload.agenda.a_pagar.itens[0]]);
    expect(element('mfc-accounts-total').dataset.mfMoney).toBe('10.00');
    expect(element('mfc-accounts-label').textContent).toBe('Total da seleção');
    clean.accounts(payload, { ...state, status: 'settled' }, null, { summary: { outgoing: '17.50' } });
    expect(element('mfc-accounts-total').dataset.mfMoney).toBe('17.50');
    expect(element('mfc-accounts-label').textContent).toBe('Pagamentos do mês');
  });
  it('impede navegação enquanto há uma confirmação em envio, sem bloquear outros módulos ou sessão encerrada', () => {
    const { clean, C, element } = load();
    C.financePayment.busy.mockReturnValue(true);
    expect(clean.blockNavigation()).toBe(false);
    element('app').classList.add('is-matrix-finance-clean');
    expect(clean.blockNavigation()).toBe(true); expect(C.showToast).toHaveBeenCalledOnce();
    C.token = () => '';
    expect(clean.blockNavigation()).toBe(false);
  });
});
