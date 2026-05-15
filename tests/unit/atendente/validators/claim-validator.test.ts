import { describe, expect, it } from 'vitest';
import { validateClaims } from '../../../../src/atendente/validators/claim-validator.js';
import type { GeneratorClaim } from '../../../../src/atendente/generator/schemas.js';
import type { ToolResultForValidation } from '../../../../src/atendente/validators/tool-results.js';

const PRODUCT_UUID = '11111111-2222-4333-8444-555555555555';
const OTHER_UUID = '22222222-3333-4444-8555-666666666666';

function buscarProdutoResult(products: Array<{ product_id?: string; price_amount?: number | string | null }>): ToolResultForValidation {
  return { tool: 'buscarProduto', ok: true, output: products };
}

function verificarEstoqueResult(stock: { product_id?: string; disponivel?: boolean; quantidade_total?: number }): ToolResultForValidation {
  return { tool: 'verificarEstoque', ok: true, output: stock };
}

function buscarCompatibilidadeResult(fitments: Array<{ produtos: unknown[] }>): ToolResultForValidation {
  return { tool: 'buscarCompatibilidade', ok: true, output: fitments };
}

function calcularFreteResult(frete: { disponivel?: boolean; valor?: number | string | null }): ToolResultForValidation {
  return { tool: 'calcularFrete', ok: true, output: frete };
}

describe('ClaimValidator — Etapa 2', () => {
  it('passa quando nao ha claims (turn sem afirmacao comercial)', () => {
    expect(validateClaims([], [])).toEqual({ valid: true });
    expect(validateClaims([], [buscarProdutoResult([{ product_id: PRODUCT_UUID, price_amount: 79 }])])).toEqual({
      valid: true,
    });
  });

  // --- price ---
  describe('price claim', () => {
    it('valida quando buscarProduto tem produto com preco correspondente', () => {
      const claim: GeneratorClaim = { type: 'price', amount: 79 };
      const result = validateClaims([claim], [
        buscarProdutoResult([{ product_id: PRODUCT_UUID, price_amount: 79 }]),
      ]);
      expect(result).toEqual({ valid: true });
    });

    it('valida preco com price_amount string ("79.00" do DB)', () => {
      const claim: GeneratorClaim = { type: 'price', amount: 79 };
      const result = validateClaims([claim], [
        buscarProdutoResult([{ product_id: PRODUCT_UUID, price_amount: '79.00' }]),
      ]);
      expect(result).toEqual({ valid: true });
    });

    it('bloqueia quando buscarProduto nao rodou', () => {
      const claim: GeneratorClaim = { type: 'price', amount: 79 };
      const result = validateClaims([claim], []);
      expect(result).toMatchObject({ valid: false, reason: expect.stringContaining('no_buscarProduto_tool_result') });
    });

    it('bloqueia quando amount nao bate com nenhum produto (proibe soma 79+79=158)', () => {
      const claim: GeneratorClaim = { type: 'price', amount: 158 };
      const result = validateClaims([claim], [
        buscarProdutoResult([{ product_id: PRODUCT_UUID, price_amount: 79 }]),
      ]);
      expect(result).toMatchObject({ valid: false, reason: expect.stringContaining('amount_158_not_in_results') });
    });

    it('com product_id informado, restringe checagem a esse produto', () => {
      const claim: GeneratorClaim = { type: 'price', amount: 99, product_id: OTHER_UUID };
      // produto OTHER_UUID nao tem preco 99
      const result = validateClaims([claim], [
        buscarProdutoResult([
          { product_id: PRODUCT_UUID, price_amount: 99 }, // mesmo preco mas product_id errado
          { product_id: OTHER_UUID, price_amount: 79 },   // preco errado mas product_id certo
        ]),
      ]);
      expect(result).toMatchObject({ valid: false, reason: expect.stringContaining('amount_99_not_in_results') });
    });

    it('com product_id que nao existe em resultados', () => {
      const claim: GeneratorClaim = { type: 'price', amount: 79, product_id: OTHER_UUID };
      const result = validateClaims([claim], [
        buscarProdutoResult([{ product_id: PRODUCT_UUID, price_amount: 79 }]),
      ]);
      expect(result).toMatchObject({
        valid: false,
        reason: expect.stringContaining(`product_id_not_in_results:${OTHER_UUID}`),
      });
    });
  });

  // --- stock_availability ---
  describe('stock_availability claim', () => {
    it('valida quando verificarEstoque retornou disponivel=true', () => {
      const claim: GeneratorClaim = { type: 'stock_availability' };
      const result = validateClaims([claim], [
        verificarEstoqueResult({ product_id: PRODUCT_UUID, disponivel: true, quantidade_total: 5 }),
      ]);
      expect(result).toEqual({ valid: true });
    });

    it('valida quando quantidade_total > 0 mesmo sem disponivel explicito', () => {
      const claim: GeneratorClaim = { type: 'stock_availability' };
      const result = validateClaims([claim], [
        verificarEstoqueResult({ product_id: PRODUCT_UUID, quantidade_total: 3 }),
      ]);
      expect(result).toEqual({ valid: true });
    });

    it('bloqueia quando verificarEstoque nao rodou (mesmo com buscarProduto OK)', () => {
      const claim: GeneratorClaim = { type: 'stock_availability' };
      const result = validateClaims([claim], [
        buscarProdutoResult([{ product_id: PRODUCT_UUID, price_amount: 79 }]),
      ]);
      expect(result).toMatchObject({
        valid: false,
        reason: expect.stringContaining('no_verificarEstoque_tool_result'),
      });
    });

    it('bloqueia quando verificarEstoque retornou disponivel=false', () => {
      const claim: GeneratorClaim = { type: 'stock_availability' };
      const result = validateClaims([claim], [
        verificarEstoqueResult({ product_id: PRODUCT_UUID, disponivel: false, quantidade_total: 0 }),
      ]);
      expect(result).toMatchObject({
        valid: false,
        reason: expect.stringContaining('not_available'),
      });
    });
  });

  // --- fitment ---
  describe('fitment claim', () => {
    it('valida quando buscarCompatibilidade tem fitment com produtos', () => {
      const claim: GeneratorClaim = { type: 'fitment' };
      const result = validateClaims([claim], [
        buscarCompatibilidadeResult([{ produtos: [{ product_id: PRODUCT_UUID, tire_size: '90/90-18' }] }]),
      ]);
      expect(result).toEqual({ valid: true });
    });

    it('bloqueia quando buscarCompatibilidade nao rodou', () => {
      const claim: GeneratorClaim = { type: 'fitment' };
      const result = validateClaims([claim], []);
      expect(result).toMatchObject({
        valid: false,
        reason: expect.stringContaining('no_buscarCompatibilidade_tool_result'),
      });
    });

    it('bloqueia quando fitment tem produtos vazio', () => {
      const claim: GeneratorClaim = { type: 'fitment' };
      const result = validateClaims([claim], [
        buscarCompatibilidadeResult([{ produtos: [] }]),
      ]);
      expect(result).toMatchObject({
        valid: false,
        reason: expect.stringContaining('no_compatible_products'),
      });
    });

    it('com product_id especifico, exige que esse produto apareca em algum fitment', () => {
      const claim: GeneratorClaim = { type: 'fitment', product_id: OTHER_UUID };
      const result = validateClaims([claim], [
        buscarCompatibilidadeResult([{ produtos: [{ product_id: PRODUCT_UUID }] }]),
      ]);
      expect(result).toMatchObject({
        valid: false,
        reason: expect.stringContaining(`product_id_not_in_results:${OTHER_UUID}`),
      });
    });
  });

  // --- delivery_fee ---
  describe('delivery_fee claim', () => {
    it('valida quando calcularFrete retornou disponivel sem amount especifico', () => {
      const claim: GeneratorClaim = { type: 'delivery_fee' };
      const result = validateClaims([claim], [
        calcularFreteResult({ disponivel: true, valor: 15 }),
      ]);
      expect(result).toEqual({ valid: true });
    });

    it('valida amount casando valor do frete (string ou number)', () => {
      const claim: GeneratorClaim = { type: 'delivery_fee', amount: 15 };
      const result = validateClaims([claim], [
        calcularFreteResult({ disponivel: true, valor: '15.00' }),
      ]);
      expect(result).toEqual({ valid: true });
    });

    it('bloqueia quando calcularFrete nao rodou', () => {
      const claim: GeneratorClaim = { type: 'delivery_fee', amount: 15 };
      const result = validateClaims([claim], []);
      expect(result).toMatchObject({
        valid: false,
        reason: expect.stringContaining('no_calcularFrete_tool_result'),
      });
    });

    it('bloqueia quando amount nao casa', () => {
      const claim: GeneratorClaim = { type: 'delivery_fee', amount: 25 };
      const result = validateClaims([claim], [
        calcularFreteResult({ disponivel: true, valor: 15 }),
      ]);
      expect(result).toMatchObject({
        valid: false,
        reason: expect.stringContaining('amount_25_not_in_results'),
      });
    });

    it('sem amount, bloqueia quando frete indisponivel', () => {
      const claim: GeneratorClaim = { type: 'delivery_fee' };
      const result = validateClaims([claim], [
        calcularFreteResult({ disponivel: false, valor: null }),
      ]);
      expect(result).toMatchObject({
        valid: false,
        reason: expect.stringContaining('no_available_freight'),
      });
    });
  });

  // --- multiple claims ---
  describe('multiple claims', () => {
    it('valida cada claim — passa se todos batem', () => {
      const claims: GeneratorClaim[] = [
        { type: 'price', amount: 79 },
        { type: 'stock_availability' },
        { type: 'fitment' },
      ];
      const result = validateClaims(claims, [
        buscarProdutoResult([{ product_id: PRODUCT_UUID, price_amount: 79 }]),
        verificarEstoqueResult({ product_id: PRODUCT_UUID, disponivel: true, quantidade_total: 3 }),
        buscarCompatibilidadeResult([{ produtos: [{ product_id: PRODUCT_UUID }] }]),
      ]);
      expect(result).toEqual({ valid: true });
    });

    it('bloqueia no primeiro claim invalido', () => {
      const claims: GeneratorClaim[] = [
        { type: 'price', amount: 79 }, // valido
        { type: 'stock_availability' }, // sem evidencia
      ];
      const result = validateClaims(claims, [
        buscarProdutoResult([{ product_id: PRODUCT_UUID, price_amount: 79 }]),
      ]);
      expect(result).toMatchObject({
        valid: false,
        reason: expect.stringContaining('stock_availability'),
      });
    });
  });

  // --- ok=false tool_results ---
  it('ignora tool_results com ok=false (falha de tool nao serve de evidencia)', () => {
    const claim: GeneratorClaim = { type: 'price', amount: 79 };
    const result = validateClaims([claim], [
      { tool: 'buscarProduto', ok: false, output: null },
    ]);
    expect(result).toMatchObject({
      valid: false,
      reason: expect.stringContaining('no_buscarProduto_tool_result'),
    });
  });
});
