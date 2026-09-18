import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function setup() {
  const storage = new Map<string, string>(), nodes = new Map<string, any>();
  const element = () => ({ close: vi.fn(), reset: vi.fn(), replaceChildren: vi.fn(), addEventListener: vi.fn(), hidden: false });
  const document = { getElementById: (id: string) => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); } };
  let session = 'session-a', loggedIn = true;
  const C: any = { currency: new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }),
    keys: { user: 'user', token: 'token', scope: 'scope', slug: 'slug' },
    scope: () => 'matrix', stored: () => 'maria', sessionFingerprint: () => loggedIn ? session : '',
    token: () => loggedIn ? 'secret-token' : '', canModule: () => true, authenticatedFetch: vi.fn(), json: (r: any) => r.json() };
  const window = { Caixa: C, FarejadorTime: {}, addEventListener: vi.fn() };
  vm.runInNewContext(fs.readFileSync('painel/public/caixa-purchases.js', 'utf8'), {
    window, document, Intl, AbortController, setTimeout, clearTimeout,
    sessionStorage: { getItem: (key: string) => storage.get(key) || null, setItem: (key: string, value: string) => storage.set(key, value) },
  });
  C.purchases.restore();
  return { C, P: C.purchases, storage, changeSession: () => { session = 'session-b'; }, logout: () => { loggedIn = false; C.purchases.reset(); } };
}
const response = (status: number, body: unknown) => ({ status, ok: status < 400, json: async () => body });

describe('continuidade das compras no app', () => {
  it('persiste a tentativa incerta e a retoma após restauração usando o mesmo corpo e chave', async () => {
    const { C, P, storage } = setup(); P.state.draft = { step: 3, key: 'purchase-key' };
    const body = { idempotency_key: 'purchase-key', items: [{ quantity: 3, unit_cost: 10 }] };
    C.authenticatedFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(P.send('', body)).rejects.toThrow('Failed to fetch');
    expect(P.state.pending.body).toEqual(body); expect(P.state.busy).toBe(false);
    expect([...storage.keys()]).toEqual(['farejador_purchase_v1:matrix:maria']);
    expect([...storage.values()].join()).not.toContain('secret-token');
    P.reset(); P.restore();
    expect(P.state.pending.body).toEqual(body);
    C.authenticatedFetch.mockResolvedValueOnce(response(201, { purchase_id: 'saved' }));
    await P.send('/lotes', { idempotency_key: 'different', total: 1 });
    expect(C.authenticatedFetch.mock.calls[1][0]).toBe('/api/caixa/operacao/compras');
    expect(JSON.parse(C.authenticatedFetch.mock.calls[1][1].body)).toEqual(body);
    expect(P.state.pending).toBeNull(); expect(P.state.draft).toBeNull();
  });
  it('mantém a tentativa quando o servidor devolve sucesso sem um comprovante válido', async () => {
    const { C, P } = setup();
    C.authenticatedFetch.mockResolvedValue(response(200, {}));
    await expect(P.send('', { idempotency_key: 'same' })).rejects.toThrow('invalid_response');
    expect(P.state.pending.body.idempotency_key).toBe('same');
  });
  it('libera correções somente após recusa definitiva e conserva conflitos de idempotência', async () => {
    const { C, P } = setup();
    C.authenticatedFetch.mockResolvedValueOnce(response(400, { error: 'discount_exceeds_purchase' }));
    await expect(P.send('', { idempotency_key: 'same' })).rejects.toThrow('discount_exceeds_purchase');
    expect(P.state.pending).toBeNull();
    C.authenticatedFetch.mockResolvedValueOnce(response(409, { error: 'idempotency_conflict' }));
    await expect(P.send('', { idempotency_key: 'same' })).rejects.toThrow('idempotency_conflict');
    expect(P.state.pending).not.toBeNull();
  });
  it('confirmação preserva o rascunho e as quantidades zero sem registrar nova compra', async () => {
    const { C, P } = setup(); P.state.draft = { key: 'other-draft' };
    C.authenticatedFetch.mockResolvedValue(response(200, { purchase_id: 'saved' }));
    await P.send('/confirmar', { items: [{ accepted_quantity: 0 }, { accepted_quantity: 2 }] }, { id: 'saved' });
    expect(P.state.draft).toEqual({ key: 'other-draft' }); expect(P.state.pending).toBeNull();
  });
  it('ignora duplo clique e impede resposta de outra sessão de alterar o estado atual', async () => {
    const { C, P, logout } = setup();
    let resolve!: (value: unknown) => void;
    C.authenticatedFetch.mockReturnValue(new Promise(r => { resolve = r; }));
    const write = P.send('', { idempotency_key: 'same' });
    expect(await P.send('', { idempotency_key: 'second' })).toBeNull();
    logout(); resolve(response(201, { purchase_id: 'saved' }));
    await expect(write).rejects.toThrow('invalid_session');
    expect(P.state.pending).toBeNull(); expect(P.state.draft).toBeNull();
  });
});
