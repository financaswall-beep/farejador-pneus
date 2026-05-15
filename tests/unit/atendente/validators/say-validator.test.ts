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

  it('bloqueia claim positivo de marca sem buscarProduto', () => {
    expect(
      validateSay('Tem Pirelli sim para eu verificar, mas me confirma o ano da sua Biz 125.', {
        recent_tool_results: [],
      }),
    ).toMatchObject({
      valid: false,
      reason: 'brand_claim_without_buscar_produto',
    });
  });

  it('permite claim de marca quando buscarProduto retornou a marca', () => {
    expect(
      validateSay('Tem Pirelli sim, mas preciso confirmar o produto certinho antes de passar valor.', {
        recent_tool_results: [
          {
            tool: 'buscarProduto',
            ok: true,
            output: [{ product_id: 'p1', brand: 'Pirelli', product_name: 'Pneu Pirelli 110/90-17' }],
          },
        ],
      }),
    ).toEqual({ valid: true });
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

  it('nao bloqueia prazo de troca como claim de entrega', () => {
    // "prazo de troca em até 7 dias" nao e uma promessa de entrega
    expect(
      validateSay('O prazo de troca é de até 7 dias conforme nossa política.', {
        recent_tool_results: [policyToolResult()],
      }),
    ).toEqual({ valid: true });
  });

  it('nao bloqueia prazo de troca sem calcularFrete', () => {
    // a regra delivery_claim so deve disparar para promessas de entrega logistica
    expect(
      validateSay('Você tem até 7 dias para trocar o produto.', {
        recent_tool_results: [policyToolResult()],
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

  // Fitment hedge: frases negativas/cautelosas sobre compatibilidade NAO devem
  // disparar fitment_claim_without_buscar_compatibilidade (falsos positivos
  // observados em catalog15-rerun-20260515033950: 6/45 turns bloqueados).
  it.each([
    'Nao consigo confirmar se serve na sua Suzuki sem o ano.',
    'Ainda nao consigo confirmar a compatibilidade com seguranca.',
    'Nao tenho como garantir que serve nessa moto.',
    'Vou verificar se serve antes de afirmar.',
    'Preciso confirmar se serve para a sua moto.',
    'Talvez sirva, mas precisa confirmar.',
    'Me manda o ano da sua moto para eu confirmar se serve.',
    'Antes de garantir que serve, preciso de mais informacoes.',
  ])('permite frase com hedge de compatibilidade sem buscarCompatibilidade: %s', (sentence) => {
    expect(
      validateSay(sentence, { recent_tool_results: [] }),
    ).toEqual({ valid: true });
  });

  it('bloqueia mesmo com hedge se houver frase afirmativa separada sem evidencia', () => {
    // Duas frases: a primeira tem hedge, a segunda afirma sem evidencia.
    // O validator deve bloquear pela segunda frase.
    expect(
      validateSay(
        'Nao tenho certeza se serve. Mas esse pneu serve para sua Honda.',
        { recent_tool_results: [] },
      ),
    ).toMatchObject({
      valid: false,
      reason: 'fitment_claim_without_buscar_compatibilidade',
    });
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

  it('bloqueia fallback seguro quando skill e pedir_dados_faltantes', () => {
    expect(
      validateSay('Desculpe, não consigo confirmar essa informação agora. Um atendente poderá te ajudar em breve.', {
        recent_tool_results: [],
        selected_skill: 'pedir_dados_faltantes',
      }),
    ).toMatchObject({
      valid: false,
      reason: 'safe_fallback_not_allowed_for_pedir_dados_faltantes',
    });
  });

  it('permite resposta util em pedir_dados_faltantes', () => {
    expect(
      validateSay('Me passa a medida do pneu traseiro, ex.: 110/90-17.', {
        recent_tool_results: [],
        selected_skill: 'pedir_dados_faltantes',
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

  it('bloqueia desconto sem politica comercial', () => {
    expect(
      validateSay('Consigo te dar 5% de desconto.', {
        recent_tool_results: [],
      }),
    ).toMatchObject({
      valid: false,
      reason: 'policy_claim_without_tool_result',
    });
  });

  it('permite desconto dentro da politica retornada', () => {
    expect(
      validateSay('Consigo te dar 5% de desconto.', {
        recent_tool_results: [discountPolicyToolResult(5)],
      }),
    ).toEqual({ valid: true });
  });

  it('bloqueia desconto acima da politica retornada', () => {
    expect(
      validateSay('Consigo te dar 10% de desconto.', {
        recent_tool_results: [discountPolicyToolResult(5)],
      }),
    ).toMatchObject({
      valid: false,
      reason: 'policy_claim_mismatches_tool_result',
    });
  });

  it('bloqueia brinde sem politica promocional', () => {
    expect(
      validateSay('Levando 2 pneus ganha uma camara de brinde.', {
        recent_tool_results: [discountPolicyToolResult(5)],
      }),
    ).toMatchObject({
      valid: false,
      reason: 'policy_claim_without_tool_result',
    });
  });

  it('permite brinde quando existe politica promocional', () => {
    expect(
      validateSay('Levando 2 pneus ganha uma camara de brinde.', {
        recent_tool_results: [promotionPolicyToolResult()],
      }),
    ).toEqual({ valid: true });
  });

  it('bloqueia oferta custom sem politica comercial', () => {
    expect(
      validateSay('Se levar 2, faco por R$ 200.', {
        recent_tool_results: [],
      }),
    ).toMatchObject({
      valid: false,
      reason: 'policy_claim_without_tool_result',
    });
  });

  it('permite meta-fala de desconto sem politica comercial', () => {
    expect(
      validateSay('Preciso confirmar desconto com a loja antes de te passar.', {
        recent_tool_results: [],
      }),
    ).toEqual({ valid: true });
  });

  it('nao bloqueia dado observado de pagamento do cliente', () => {
    expect(validateSay('Perfeito, anotei pagamento no pix.', { recent_tool_results: [] })).toEqual({ valid: true });
  });

  it('permite valor monetario de politica_montagem quando buscarPoliticaComercial retornou dado', () => {
    // Generator echa "montagem gratuita acima de R$180, caso contrario R$15"
    // Os valores R$180 e R$15 estao no texto da politica retornada — deve ser permitido
    expect(
      validateSay(
        'A montagem é grátis para compras acima de R$180. Para valores menores, custa R$15.',
        {
          recent_tool_results: [
            {
              tool: 'buscarPoliticaComercial' as const,
              ok: true,
              output: [
                {
                  policy_key: 'politica_montagem',
                  policy_value:
                    'A montagem é grátis pra quem compra pneu acima de R$180 aqui com a gente. Se o valor for menor do que isso, cobra só R$15 pela montagem.',
                  policy_version: '1.0',
                },
              ],
            },
          ],
        },
      ),
    ).toEqual({ valid: true });
  });

  it('bloqueia valor monetario sem nenhuma tool result', () => {
    expect(
      validateSay('A montagem custa R$15.', { recent_tool_results: [] }),
    ).toMatchObject({ valid: false, reason: 'money_mentioned_without_tool_result' });
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

function discountPolicyToolResult(pct: number) {
  return {
    tool: 'buscarPoliticaComercial' as const,
    ok: true,
    output: [
      {
        policy_key: 'desconto_maximo',
        policy_value: { pct },
        policy_version: '1.0',
      },
    ],
  };
}

function promotionPolicyToolResult() {
  return {
    tool: 'buscarPoliticaComercial' as const,
    ok: true,
    output: [
      {
        policy_key: 'brinde_promocao',
        policy_value: 'Levando 2 pneus, ganha uma camara de brinde enquanto durar o estoque.',
        policy_version: '1.0',
      },
    ],
  };
}
