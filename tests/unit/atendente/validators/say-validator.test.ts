import { describe, expect, it } from 'vitest';
import { validateSay } from '../../../../src/atendente/validators/say-validator.js';

describe('SayValidator inicial', () => {
  it('bloqueia dinheiro citado sem resultado de tool', () => {
    expect(validateSay('Esse pneu sai por R$ 175,00', { recent_tool_results: [] })).toMatchObject({
      valid: false,
      reason: 'money_mentioned_without_tool_result',
    });
  });

  it('permite preco vindo de buscarProduto', () => {
    expect(
      validateSay('Esse pneu sai por R$ 175,00', {
        recent_tool_results: [
          {
            tool: 'buscarProduto',
            ok: true,
            output: [{ product_id: 'p1', price_amount: '175.00' }],
          },
        ],
      }),
    ).toEqual({ valid: true });
  });

  it('entende separador de milhar em valores monetarios', () => {
    expect(
      validateSay('O jogo completo fica em R$ 1.750,00', {
        recent_tool_results: [
          {
            tool: 'buscarProduto',
            ok: true,
            output: [{ product_id: 'p1', price_amount: '1750.00' }],
          },
        ],
      }),
    ).toEqual({ valid: true });
  });

  it('bloqueia preco inventado diferente do resultado da tool', () => {
    expect(
      validateSay('Esse pneu sai por R$ 180,00', {
        recent_tool_results: [
          {
            tool: 'buscarProduto',
            ok: true,
            output: [{ product_id: 'p1', price_amount: '175.00' }],
          },
        ],
      }),
    ).toMatchObject({
      valid: false,
      reason: 'money_not_supported_by_tool_result:180',
    });
  });

  it('bloqueia promessa de estoque sem verificarEstoque', () => {
    expect(
      validateSay('Temos esse pneu em estoque para pronta entrega.', {
        recent_tool_results: [
          {
            tool: 'buscarProduto',
            ok: true,
            output: [{ product_id: 'p1', total_stock_available: 3 }],
          },
        ],
      }),
    ).toMatchObject({
      valid: false,
      reason: 'stock_claim_without_verificar_estoque',
    });
  });

  it('bloqueia disponibilidade de marca sem verificarEstoque', () => {
    expect(
      validateSay('Preciso ver se temos Michelin disponível para sua moto.', {
        recent_tool_results: [],
      }),
    ).toMatchObject({
      valid: false,
      reason: 'stock_claim_without_verificar_estoque',
    });
  });

  it('permite promessa de estoque quando verificarEstoque retornou dado', () => {
    expect(
      validateSay('Temos esse pneu em estoque.', {
        recent_tool_results: [
          {
            tool: 'verificarEstoque',
            ok: true,
            output: { product_id: 'p1', disponivel: true, quantidade_total: 4 },
          },
        ],
      }),
    ).toEqual({ valid: true });
  });

  it('bloqueia promessa de prazo ou entrega sem calcularFrete', () => {
    expect(
      validateSay('Entregamos amanhã no seu bairro.', { recent_tool_results: [] }),
    ).toMatchObject({
      valid: false,
      reason: 'delivery_claim_without_calcular_frete',
    });
  });

  it('bloqueia prazo padrao sem calcularFrete', () => {
    expect(
      validateSay('O prazo padrão é para o dia seguinte após a confirmação.', {
        recent_tool_results: [],
      }),
    ).toMatchObject({
      valid: false,
      reason: 'delivery_claim_without_calcular_frete',
    });
  });

  it('bloqueia cobertura de entrega sem calcularFrete', () => {
    expect(
      validateSay('Entregamos no Rio de Janeiro, incluindo a Zona Norte.', {
        recent_tool_results: [],
      }),
    ).toMatchObject({
      valid: false,
      reason: 'delivery_claim_without_calcular_frete',
    });
  });

  it('permite prazo quando calcularFrete retornou dado', () => {
    expect(
      validateSay('O prazo de entrega é de 3 dias.', {
        recent_tool_results: [
          {
            tool: 'calcularFrete',
            ok: true,
            output: { encontrado: true, disponivel: true, valor: '12.50', prazo_dias: 3 },
          },
        ],
      }),
    ).toEqual({ valid: true });
  });

  it('bloqueia compatibilidade sem buscarCompatibilidade', () => {
    expect(
      validateSay('Esse pneu serve para sua Titan 160.', { recent_tool_results: [] }),
    ).toMatchObject({
      valid: false,
      reason: 'fitment_claim_without_buscar_compatibilidade',
    });
  });

  it('permite compatibilidade quando buscarCompatibilidade retornou produto compativel', () => {
    expect(
      validateSay('Esse pneu serve para sua Titan 160.', {
        recent_tool_results: [
          {
            tool: 'buscarCompatibilidade',
            ok: true,
            output: [
              {
                vehicle_model_id: 'v1',
                produtos: [{ product_id: 'p1', tire_size: '90/90-18', position: 'rear' }],
              },
            ],
          },
        ],
      }),
    ).toEqual({ valid: true });
  });

  it('bloqueia fallback seguro misturado com resposta util', () => {
    expect(
      validateSay(
        'Perfeito, já anotei a medida 140/70-17. Desculpe, não consigo confirmar essa informação agora. Um atendente poderá te ajudar em breve.',
        { recent_tool_results: [] },
      ),
    ).toMatchObject({
      valid: false,
      reason: 'mixed_safe_fallback_with_other_content',
    });
  });

  it('permite fallback seguro sozinho', () => {
    expect(
      validateSay('Desculpe, não consigo confirmar essa informação agora. Um atendente poderá te ajudar em breve.', {
        recent_tool_results: [],
      }),
    ).toEqual({ valid: true });
  });

  it.each([
    ['parcelamento', 'Parcelamos em até 4x sem juros.'],
    ['troca', 'Você pode trocar em até 7 dias após a compra.'],
    ['devolucao', 'Aceitamos devolução em até 7 dias.'],
    ['garantia', 'A garantia cobre o serviço de montagem.'],
    ['forma_pagamento', 'Aceitamos Pix e cartão.'],
    ['horario', 'Atendemos de segunda a sábado, das 8h às 17h.'],
  ])('bloqueia claim de politica sem buscarPoliticaComercial: %s', (_category, say) => {
    expect(validateSay(say, { recent_tool_results: [] })).toMatchObject({
      valid: false,
      reason: 'policy_claim_without_tool_result',
    });
  });

  it.each([
    ['parcelamento', 'Parcelamos em até 4x sem juros.'],
    ['troca', 'Você pode trocar em até 7 dias após a compra.'],
    ['devolucao', 'Aceitamos devolução em até 7 dias.'],
    ['garantia', 'A garantia cobre o serviço de montagem.'],
    ['forma_pagamento', 'Aceitamos Pix e cartão.'],
    ['horario', 'Atendemos de segunda a sábado, das 8h às 17h.'],
  ])('permite claim de politica com buscarPoliticaComercial: %s', (_category, say) => {
    expect(
      validateSay(say, {
        recent_tool_results: [policyToolResult()],
      }),
    ).toEqual({ valid: true });
  });

  it.each([
    'Vou verificar a garantia com a loja antes de te confirmar.',
    'Preciso confirmar se aceita parcelamento em mais vezes.',
    'Você perguntou sobre troca; vou anotar pra te responder certinho.',
  ])('permite meta-fala de politica sem tool: %s', (say) => {
    expect(validateSay(say, { recent_tool_results: [] })).toEqual({ valid: true });
  });

  it('bloqueia claim de politica quando buscarPoliticaComercial retornou vazio', () => {
    expect(
      validateSay('Parcelamos em até 4x sem juros.', {
        recent_tool_results: [{ tool: 'buscarPoliticaComercial', ok: true, output: [] }],
      }),
    ).toMatchObject({
      valid: false,
      reason: 'policy_claim_without_tool_result',
    });
  });

  it('bloqueia parcelamento diferente da politica retornada', () => {
    expect(
      validateSay('Parcelamos em até 6x sem juros.', {
        recent_tool_results: [policyToolResult()],
      }),
    ).toMatchObject({
      valid: false,
      reason: 'policy_claim_mismatches_tool_result',
    });
  });

  it('bloqueia forma de pagamento diferente da politica retornada', () => {
    expect(
      validateSay('Aceitamos boleto para pagamento.', {
        recent_tool_results: [policyToolResult()],
      }),
    ).toMatchObject({
      valid: false,
      reason: 'policy_claim_mismatches_tool_result',
    });
  });

  it('nao bloqueia dado observado de pagamento do cliente', () => {
    expect(validateSay('Perfeito, anotei pagamento no pix.', { recent_tool_results: [] })).toEqual({ valid: true });
  });
});

function policyToolResult() {
  return {
    tool: 'buscarPoliticaComercial' as const,
    ok: true,
    output: [
      {
        policy_key: 'parcelamento_maximo',
        policy_value: { installments: 4 },
        policy_version: '1.0',
      },
      {
        policy_key: 'formas_pagamento_aceitas',
        policy_value: ['pix', 'cartao_credito', 'cartao_debito'],
        policy_version: '1.0',
      },
      {
        policy_key: 'garantia_descricao',
        policy_value: 'Garantia cobre o serviço de montagem realizado na loja.',
        policy_version: '1.0',
      },
      {
        policy_key: 'prazo_troca',
        policy_value: { days: 7, condition: 'produto sem uso' },
        policy_version: '1.0',
      },
      {
        policy_key: 'horario_funcionamento',
        policy_value: 'Atendemos de segunda a sábado, das 8h às 17h.',
        policy_version: '1.0',
      },
    ],
  };
}
