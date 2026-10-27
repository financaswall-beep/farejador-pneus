import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function setup() {
  const elements = new Map<string, any>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, {
      textContent: 'Texto original', value: '', dataset: {}, disabled: false,
      querySelectorAll: () => [], addEventListener: vi.fn(), replaceChildren: vi.fn(),
      classList: { add: vi.fn(), toggle: vi.fn() },
    });
    return elements.get(id);
  };
  const controls = [{ disabled: false }, { disabled: true }];
  let fingerprint = 'owner-A', owner = true;
  const C: any = {
    sessionFingerprint: () => fingerprint, token: () => 'fixture', canModule: () => owner,
    isPartner: () => false, showToast: vi.fn(), createSvg: vi.fn(),
    authenticatedFetch: vi.fn().mockResolvedValue({ ok: true }), json: async () => ({ saved: true }),
    teamState: { payload: { private: true }, memberId: 'person-A', request: { abort: vi.fn() } },
    closeNewMember: vi.fn(),
  };
  const document = {
    getElementById: element, querySelector: element, addEventListener: vi.fn(),
    querySelectorAll: (selector: string) => selector.startsWith('.team-page:not') ? controls : [],
  };
  runInNewContext(readFileSync('painel/public/caixa-team-clean.js', 'utf8'), {
    window: { Caixa: C, addEventListener: vi.fn() }, document,
  });
  return { C, elements, controls, changeOwner: () => { fingerprint = 'owner-B'; }, revoke: () => { owner = false; } };
}

describe('requisições da equipe vinculadas à sessão', () => {
  it('descarta uma resposta privada quando a conta muda durante a consulta', async () => {
    const { C, changeOwner } = setup();
    let finish!: (response: unknown) => void;
    C.authenticatedFetch.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const result = C.teamClean.request('/api/caixa/equipe/person-A/remuneracao');
    changeOwner(); finish({ ok: true });
    await expect(result).rejects.toThrow('invalid_session');
  });

  it('impede consultas sem autorização e descarta a resposta após revogação', async () => {
    const { C, revoke } = setup();
    let finish!: (response: unknown) => void;
    C.authenticatedFetch.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const result = C.teamClean.request('/api/caixa/equipe');
    revoke(); finish({ ok: true });
    await expect(result).rejects.toThrow('invalid_session');
    await expect(C.teamClean.request('/api/caixa/equipe')).rejects.toThrow('invalid_session');
    expect(C.authenticatedFetch).toHaveBeenCalledTimes(1);
  });

  it('evita gravações concorrentes e restaura os controles após falha de rede', async () => {
    const { C, controls } = setup();
    let fail!: (error: Error) => void;
    C.authenticatedFetch.mockImplementation(() => new Promise((_, reject) => { fail = reject; }));
    const result = C.teamClean.request('/api/caixa/equipe/person-A/comissao', { method: 'PUT' });
    expect(controls.every(control => control.disabled)).toBe(true);
    expect(C.teamClean.blockNavigation()).toBe(true);
    await expect(C.teamClean.request('/api/caixa/equipe', { method: 'POST' })).rejects.toThrow('team_busy');
    fail(new Error('offline'));
    await expect(result).rejects.toThrow('offline');
    expect(controls.map(control => control.disabled)).toEqual([false, true]);
    expect(C.teamClean.busy()).toBe(false);
    expect(C.teamClean.blockNavigation()).toBe(false);
  });

  it('invalida o cache e respostas pendentes mesmo ao reconectar a mesma conta', async () => {
    const { C, elements } = setup();
    let finish!: (response: unknown) => void;
    C.authenticatedFetch.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const key = C.teamClean.sessionKey();
    const result = C.teamClean.request('/api/caixa/equipe/person-A/permissoes');
    C.teamClean.reset(); finish({ ok: true });
    await expect(result).rejects.toThrow('invalid_session');
    expect(C.teamClean.sessionKey()).not.toBe(key);
    expect(C.teamState.payload).toBeNull();
    expect(C.teamState.memberId).toBe('');
    expect(elements.get('team-list').replaceChildren).toHaveBeenCalledOnce();
    expect(C.closeNewMember).toHaveBeenCalledOnce();
  });
});
