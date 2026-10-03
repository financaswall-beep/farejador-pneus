import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const script = readFileSync(new URL('../../../painel/public/caixa-checkout-submit.js', import.meta.url), 'utf8');
function browser(storage = new Map<string, string>()) {
  const field = () => ({ textContent: '', disabled: false, classList: { add: vi.fn(), remove: vi.fn() } });
  const state: any = { cart: new Map([['p1', { product: { product_id: 'p1' }, quantity: 1 }]]),
    payment: 'pix', customerName: 'Cliente Balcão', customerPhone: '', busy: false };
  const ui = { submitError: field(), confirmButton: field() };
  const C: any = { checkoutRuntime: { state, ui, cartTotals: () => ({ valid: true, total: 20 }), renderCart: vi.fn(), submitErrorMessage: () => 'Recusada' },
    keys: { user: 'user' }, scope: () => 'matrix', slug: () => 'main', stored: () => 'operador',
    sessionFingerprint: () => 'same-session', checkoutSessionChanged: () => false,
    saleRequestBody: () => ({ payment_method: state.payment, idempotency_key: state.idempotencyKey, items: [{ product_id: 'p1', quantity: 1 }] }),
    operationPath: (_partner: string, matrix: string) => matrix,
    authenticatedFetch: vi.fn(), json: async (r: any) => r.payload,
    elements: { checkoutReviewModal: field(), receiptModal: field() }, loadCatalog: vi.fn(), loadSales: vi.fn(),
    isPartner: () => false, renderReceipt: vi.fn(), showToast: vi.fn() };
  vm.runInNewContext(script, { window: { Caixa: C, crypto: { randomUUID: () => 'fixture-key' } },
    sessionStorage: { getItem: (key: string) => storage.get(key), setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    Map, JSON, encodeURIComponent });
  return { C, state, ui, storage };
}

describe('Caixa: confirmação incerta', () => {
  it('preserva tentativa antes do envio e recupera após reload sem novo POST', async () => {
    const first = browser();
    first.C.authenticatedFetch.mockImplementation(async () => {
      expect(first.storage.size).toBe(1);
      throw new TypeError('Failed to fetch');
    });
    await first.C.confirmCheckoutSale();
    expect(first.state.pendingAttempt.body.idempotency_key).toBe('caixa-fixture-key');
    expect(first.ui.submitError.textContent).toContain('Verificar venda');
    const reloaded = browser(first.storage);
    reloaded.C.restoreCheckoutAttempt();
    reloaded.C.authenticatedFetch.mockResolvedValue({ ok: true, payload: { found: true, order_id: 'saved-order' } });
    await reloaded.C.confirmCheckoutSale();
    expect(reloaded.C.authenticatedFetch).toHaveBeenCalledTimes(1);
    expect(reloaded.C.authenticatedFetch.mock.calls[0][0]).toContain('/por-chave/caixa-fixture-key');
    expect(reloaded.state.cart.size).toBe(0);
    expect(first.storage.size).toBe(0);
  });

  it('repete corpo e chave congelados quando a consulta não encontrou a venda', async () => {
    const b = browser();
    b.C.authenticatedFetch.mockResolvedValueOnce({ ok: false, status: 500, payload: { error: 'internal_error' } });
    await b.C.confirmCheckoutSale();
    const original = b.C.authenticatedFetch.mock.calls[0][1].body;
    b.state.payment = 'dinheiro'; // mesmo mutação fora da UI não muda o payload congelado
    b.C.authenticatedFetch.mockResolvedValueOnce({ ok: true, payload: { found: false } })
      .mockResolvedValueOnce({ ok: true, payload: { order_id: 'new-order' } });
    await b.C.confirmCheckoutSale();
    expect(b.C.authenticatedFetch.mock.calls[2][1].body).toBe(original);
  });

  it('não envia quando não consegue preservar a tentativa', async () => {
    const storage = new Map();
    storage.set = () => { throw new Error('quota'); };
    const b = browser(storage);
    await b.C.confirmCheckoutSale();
    expect(b.C.authenticatedFetch).not.toHaveBeenCalled();
    expect(b.ui.submitError.textContent).toContain('não foi enviada');
  });

  it('resposta sem confirmação e conflito mantêm a recuperação obrigatória', async () => {
    for (const response of [{ ok: true, payload: {} },
      { ok: false, status: 409, payload: { error: 'walkin_idempotency_conflict' } }]) {
      const b = browser();
      b.C.authenticatedFetch.mockResolvedValue(response);
      await b.C.confirmCheckoutSale();
      expect(b.state.pendingAttempt).toBeTruthy();
      expect(b.storage.size).toBe(1);
    }
  });
});
