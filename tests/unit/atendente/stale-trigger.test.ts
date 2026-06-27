import { describe, expect, it } from 'vitest';
import { isStaleTrigger } from '../../../src/atendente-v2/stale-trigger.js';

const T = (iso: string) => new Date(iso);

// isStaleTrigger(thisTriggerAt, lastAnsweredTriggerAt): obsoleto quando o gatilho DESTE job
// é IGUAL ou ANTERIOR à mensagem mais nova que o bot JÁ respondeu. Revisado 06-27: passou a
// olhar QUAL mensagem foi respondida (o gatilho do último turn entregue), não o RELÓGIO da
// última resposta — pra não engolir uma pergunta nova quando uma resposta anterior (saudação)
// sai atrasada, depois dela. Mantém a proteção do reenfileiramento de 60s (caso Vitor 06-16).
describe('isStaleTrigger', () => {
  it('REQUENTADO (Vitor): mesma mensagem reenfileirada, já respondida → obsoleto (não repete)', () => {
    const qualPneu = T('2026-06-15T22:43:04Z');
    expect(isStaleTrigger(qualPneu, qualPneu)).toBe(true); // o gatilho É a msg já respondida
  });

  it('REQUENTADO: gatilho mais ANTIGO que a mensagem mais nova já respondida → obsoleto', () => {
    // reenfileirou "qual pneu" (22:43:04), mas o bot já respondeu uma msg mais nova (22:43:30)
    expect(isStaleTrigger(T('2026-06-15T22:43:04Z'), T('2026-06-15T22:43:30Z'))).toBe(true);
  });

  it('BUG 06-27 (pneu engolido): pergunta NOVA, mais recente que a última respondida → RESPONDE', () => {
    // "tem pneu?" (03:06:37) chegou DEPOIS do "Olá" (03:06:20, última msg respondida).
    // A saudação até saiu atrasada (03:06:40), mas o que conta é a MENSAGEM respondida (o Olá),
    // não o relógio da resposta. Com a lógica antiga, isto era ENGOLIDO.
    expect(isStaleTrigger(T('2026-06-27T03:06:37Z'), T('2026-06-27T03:06:20Z'))).toBe(false);
  });

  it('SEM resposta entregue ainda na conversa → responde', () => {
    expect(isStaleTrigger(T('2026-06-15T22:43:04Z'), null)).toBe(false);
  });

  it('gatilho desconhecido (sem horário) → não cala por falta de dado', () => {
    expect(isStaleTrigger(null, T('2026-06-15T22:43:53Z'))).toBe(false);
    expect(isStaleTrigger(null, null)).toBe(false);
  });
});
