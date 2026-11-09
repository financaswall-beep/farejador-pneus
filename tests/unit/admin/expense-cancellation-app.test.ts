import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

class Element {
  children: Element[] = [];
  listeners: Record<string, (event: unknown) => Promise<void>> = {};
  value = ''; disabled = false; hidden = false; textContent = '';
  append(...items: Element[]) { this.children.push(...items); }
  appendChild(item: Element) { this.children.push(item); return item; }
  setAttribute() {}
  addEventListener(type: string, callback: (event: unknown) => Promise<void>) { this.listeners[type] = callback; }
  reportValidity() { return true; }
}
function setup(storage = new Map<string, string>()) {
  const fetch = vi.fn(); const load = vi.fn();
  const C: any = { scope: () => 'matriz', keys: { user: 'user' }, stored: () => 'owner',
    sessionFingerprint: () => 'same-session', authenticatedFetch: fetch, json: (r: any) => r.body,
    financeMatrix: { load }, currency: new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }) };
  const sandbox = { window: { Caixa: C }, document: { querySelectorAll: () => [], createElement: () => new Element() },
    sessionStorage: { getItem: (key: string) => storage.get(key),
      setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    crypto: { randomUUID: () => 'stable-cancellation-key' } };
  vm.runInNewContext(readFileSync('painel/public/caixa-finance-view.js', 'utf8'), sandbox);
  const body = new Element(); C.financeView.cancellation(body, { source_id: 'expense-id' });
  const form = body.children[0]!; const reason = form.children[1]!; const button = form.children[3]!;
  const submit = () => form.listeners.submit!({ preventDefault() {} });
  return { fetch, load, reason, button, submit, storage, error: form.children[4]! };
}
describe('cancelamento pelo app preserva a tentativa', () => {
  it('impede duplo envio e permite conferir novamente uma resposta perdida após reabrir', async () => {
    const s = setup(); s.reason.value = 'Duplicado';
    let reject!: (error: Error) => void;
    s.fetch.mockImplementationOnce(() => new Promise((_, r) => { reject = r; }));
    const pending = s.submit(); await s.submit();
    expect(s.fetch).toHaveBeenCalledOnce();
    reject(Error('network_error')); await pending;
    const reopened = setup(s.storage); reopened.reason.value = 'Motivo editado';
    reopened.fetch.mockResolvedValue({ ok: true, body: { cancelled: true } });
    await reopened.submit();
    expect(reopened.fetch.mock.calls[0]).toEqual(s.fetch.mock.calls[0]);
    expect(reopened.load).toHaveBeenCalledOnce(); expect(reopened.button.hidden).toBe(true);
    expect(s.storage.size).toBe(0);
  });
  it('explica um vínculo bloqueado, libera o motivo e não atualiza como se tivesse cancelado', async () => {
    const s = setup(); s.reason.value = 'Duplicado';
    s.fetch.mockResolvedValue({ ok: false, status: 409, body: { error: 'expense_cancellation_linked' } });
    await s.submit();
    expect(s.error.textContent).toContain('folha ou de rotas');
    expect(s.reason.disabled).toBe(false); expect(s.load).not.toHaveBeenCalled();
    expect(s.storage.size).toBe(0);
  });
});
