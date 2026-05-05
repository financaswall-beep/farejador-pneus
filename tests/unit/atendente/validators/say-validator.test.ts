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
});
