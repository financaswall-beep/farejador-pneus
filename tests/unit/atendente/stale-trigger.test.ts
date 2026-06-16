import { describe, expect, it } from 'vitest';
import { isStaleTrigger } from '../../../src/atendente-v2/stale-trigger.js';

const T = (iso: string) => new Date(iso);

describe('isStaleTrigger', () => {
  it('REQUENTADO: já respondemos DEPOIS do gatilho → obsoleto (o bug do Vitor)', () => {
    // gatilho "Olá" 19:43:04, mas a conversa já tinha resposta nossa 19:43:53
    expect(isStaleTrigger(T('2026-06-15T22:43:04Z'), T('2026-06-15T22:43:53Z'))).toBe(true);
  });

  it('NOVO: última resposta foi ANTES do gatilho → responde (não cala mensagem legítima)', () => {
    // bot respondeu 19:43:16, cliente mandou algo novo 19:43:40
    expect(isStaleTrigger(T('2026-06-15T22:43:40Z'), T('2026-06-15T22:43:16Z'))).toBe(false);
  });

  it('SEM resposta ainda na conversa → responde', () => {
    expect(isStaleTrigger(T('2026-06-15T22:43:04Z'), null)).toBe(false);
  });

  it('gatilho desconhecido (sem horário) → não cala por falta de dado', () => {
    expect(isStaleTrigger(null, T('2026-06-15T22:43:53Z'))).toBe(false);
    expect(isStaleTrigger(null, null)).toBe(false);
  });

  it('empate exato (mesmo horário) → NÃO é obsoleto (precisa ser estritamente depois)', () => {
    const t = T('2026-06-15T22:43:04Z');
    expect(isStaleTrigger(t, T(t.toISOString()))).toBe(false);
  });
});
