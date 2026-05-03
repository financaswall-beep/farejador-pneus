import { describe, expect, it } from 'vitest';
import { inferDeterministicFacts } from '../../../src/organizadora/deterministic-facts.js';
import type { MessageForPrompt } from '../../../src/shared/repositories/core-reader.repository.js';

function msg(content: string, id: string = crypto.randomUUID()): MessageForPrompt {
  return {
    id,
    sender_type: 'contact',
    message_type: 'incoming',
    content,
    sent_at: new Date('2026-05-03T12:00:00Z'),
  };
}

describe('inferDeterministicFacts', () => {
  it('extrai forma_pagamento literal quando a LLM nao extraiu', () => {
    const facts = inferDeterministicFacts([msg('se entregar eu fecho no pix')], []);

    expect(facts).toContainEqual(
      expect.objectContaining({
        fact_key: 'forma_pagamento',
        fact_value: 'pix',
        evidence_text: 'pix',
        truth_type: 'observed',
        confidence_level: 1,
      }),
    );
  });

  it('nao duplica forma_pagamento quando a LLM ja extraiu', () => {
    const facts = inferDeterministicFacts(
      [msg('quero pagar em dinheiro')],
      [{ fact_key: 'forma_pagamento', fact_value: 'dinheiro' }],
    );

    expect(facts.some((fact) => fact.fact_key === 'forma_pagamento')).toBe(false);
  });

  it('complementa quando a LLM extraiu a mesma chave com valor invalido', () => {
    expect(inferDeterministicFacts(
      [msg('posso retirar na loja?')],
      [{ fact_key: 'modalidade_entrega', fact_value: 'retirar na loja' }],
    )).toContainEqual(expect.objectContaining({
      fact_key: 'modalidade_entrega',
      fact_value: 'retirada',
    }));

    expect(inferDeterministicFacts(
      [msg('da pra pagar metade pix metade cartao?')],
      [{ fact_key: 'forma_pagamento', fact_value: 'metade pix metade cartao' }],
    )).toContainEqual(expect.objectContaining({
      fact_key: 'forma_pagamento',
      fact_value: 'indefinido',
    }));
  });

  it('marca pagamento misto como indefinido', () => {
    const facts = inferDeterministicFacts([msg('da pra pagar metade pix metade cartao?')], []);

    expect(facts).toContainEqual(expect.objectContaining({
      fact_key: 'forma_pagamento',
      fact_value: 'indefinido',
      evidence_text: 'da pra pagar metade pix metade cartao?',
    }));
  });

  it('extrai modalidade entrega e retirada por literais seguros', () => {
    expect(inferDeterministicFacts([msg('quanto fica o frete?')], [])).toContainEqual(
      expect.objectContaining({ fact_key: 'modalidade_entrega', fact_value: 'entrega', evidence_text: 'frete' }),
    );

    expect(inferDeterministicFacts([msg('posso retirar na loja?')], [])).toContainEqual(
      expect.objectContaining({ fact_key: 'modalidade_entrega', fact_value: 'retirada', evidence_text: 'retirar' }),
    );
  });

  it('nao trata motoboy ou delivery como modalidade de entrega', () => {
    const facts = inferDeterministicFacts(
      [
        msg('sou motoboy'),
        msg('trabalho de delivery'),
      ],
      [],
    );

    expect(facts.some((fact) => fact.fact_key === 'modalidade_entrega')).toBe(false);
  });

  it('usa apenas mensagens de cliente', () => {
    const attendantMessage = {
      ...msg('pode pagar no pix'),
      sender_type: 'agent',
    };

    expect(inferDeterministicFacts([attendantMessage], [])).toEqual([]);
  });
});
