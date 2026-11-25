import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

// Exercita o controlador com a resposta da API em aberto durante a navegação.
function setup(owner = true) {
  type Listener = (event: { target: { closest: () => { dataset: { mcgAction: string } } } }) => void;
  function element() {
    const events = new Map<string, Listener>();
    return {
      id: '', dataset: {} as Record<string, string>, events, scrollTop: 0,
      appendChild: vi.fn(), prepend: vi.fn(), setAttribute: vi.fn(), replaceChildren: vi.fn(), close: vi.fn(),
      querySelector: () => ({ focus: vi.fn() }), contains: () => false,
      addEventListener: (event: string, listener: Listener) => events.set(event, listener),
      classList: { contains: () => false },
    };
  }
  const host = element(), panel = element(), row = (id: string) => ({ product_id: id, product_type: 'tire' });
  const rows = [row('primeiro'), row('segundo')];
  const detail = vi.fn(() => element()), api = vi.fn();
  const view = {
    el: vi.fn(element).mockReturnValueOnce(host), button: element, heading: element,
    key: (product: typeof rows[number]) => product.product_id, list: element, cards: vi.fn(), detail,
  };
  const caixa = {
    elements: { catalogPanel: panel }, catalogMetalView: view,
    matrixCatalog: { allowed: () => owner, api }, isPartner: () => false, canModule: () => true,
    token: () => 'sessao', sessionFingerprint: () => 'sessao', operationCatalogState: { rows },
    operationCatalogView: { closeStockSelection: vi.fn() },
    matrixCatalogMetal: {} as { open: (product: typeof rows[number]) => void; sync: (tab: string) => void },
  };
  runInNewContext(readFileSync('painel/public/caixa-catalog-metal.js', 'utf8'), {
    window: { Caixa: caixa }, document: { activeElement: null, createElement: element, body: element(),
      getElementById: () => ({ parentElement: element(), classList: { contains: () => false } }), addEventListener: vi.fn() },
  });
  caixa.matrixCatalogMetal.sync('catalog');
  const open = (i: number) => caixa.matrixCatalogMetal.open(rows[i]);
  const click = (action: string) => host.events.get('click')!({ target: { closest: () => ({ dataset: { mcgAction: action } }) } });
  return { open, click, api, detail, rows };
}
const data = { weeks: [], share: {}, basket: { orders: 0, items: [] }, discount: {} };

describe('estatísticas no Catálogo do app da Matriz', () => {
  it('só carrega ao abrir a aba e descarta a resposta do pneu anterior', async () => {
    const app = setup();
    let finish!: (value: typeof data) => void;
    app.api.mockReturnValueOnce(new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce(data);
    app.open(0);
    expect(app.api).not.toHaveBeenCalled();
    app.click('tab-stats'); app.click('tab-stats');
    expect(app.api).toHaveBeenCalledTimes(1);
    expect(app.api).toHaveBeenCalledWith('/products/primeiro/stats');
    app.open(1); app.click('tab-stats');
    await vi.waitFor(() => expect(app.detail).toHaveBeenLastCalledWith(app.rows[1], { data, error: false }));
    const renders = app.detail.mock.calls.length;
    finish(data);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(app.detail).toHaveBeenCalledTimes(renders);
  });
  it('não consulta em nome de colaborador', () => {
    const app = setup(false);
    app.open(0); app.click('tab-stats');
    expect(app.api).not.toHaveBeenCalled();
  });
  it('mantém falha distinta de base vazia e permite tentar de novo', async () => {
    const app = setup();
    app.api.mockRejectedValueOnce(new Error('indisponível')).mockResolvedValueOnce(data);
    app.open(0); app.click('tab-stats');
    await vi.waitFor(() => expect(app.detail).toHaveBeenLastCalledWith(app.rows[0], { error: true, data: null }));
    app.click('retry-stats');
    await vi.waitFor(() => expect(app.detail).toHaveBeenLastCalledWith(app.rows[0], { error: false, data }));
  });
});
