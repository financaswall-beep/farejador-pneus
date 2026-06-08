import { describe, expect, it } from 'vitest';
import { extractRecentProductIds } from '../../../src/atendente-v2/conversation-products.js';
import type { ChatMessage } from '../../../src/atendente-v2/types.js';

// Helpers pra montar `actions` de um turn (igual ao que vai pra agent.turns.actions).
function buscarProduto(id: string, ...more: string[]): ChatMessage[] {
  return [
    { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'buscar_produto', arguments: '{"medida_pneu":"90/90-18"}' } }] },
    { role: 'tool', tool_call_id: 't1', content: JSON.stringify({ encontrado: true, produtos: [id, ...more].map((p) => ({ product_id: p })) }) },
  ];
}
function calcularFrete(...ids: string[]): ChatMessage[] {
  return [
    { role: 'assistant', content: null, tool_calls: [{ id: 'f1', type: 'function', function: { name: 'calcular_frete', arguments: JSON.stringify({ bairro: 'X', produtos: ids.map((id) => ({ product_id: id })) }) } }] },
  ];
}

describe('extractRecentProductIds', () => {
  it('pega o product_id do último buscar_produto', () => {
    expect(extractRecentProductIds([buscarProduto('803a')])).toEqual(['803a']);
  });

  it('busca com vários resultados → só o TOP (o pneu em discussão)', () => {
    expect(extractRecentProductIds([buscarProduto('TOP', 'B', 'C')])).toEqual(['TOP']);
  });

  it('produto ESCOLHIDO (calcular_frete) — multi item preservado', () => {
    expect(extractRecentProductIds([calcularFrete('A', 'B')])).toEqual(['A', 'B']);
  });

  it('turn mais RECENTE vence (newest-first)', () => {
    expect(extractRecentProductIds([buscarProduto('NOVO'), buscarProduto('VELHO')])).toEqual(['NOVO']);
  });

  it('buscar_compatibilidade → top produto do veículo', () => {
    const compat: ChatMessage[] = [
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'buscar_compatibilidade', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: JSON.stringify({ encontrado: true, veiculos: [{ produtos: [{ product_id: 'COMPAT' }] }] }) },
    ];
    expect(extractRecentProductIds([compat])).toEqual(['COMPAT']);
  });

  it('nada de produto → vazio', () => {
    expect(extractRecentProductIds([])).toEqual([]);
    expect(extractRecentProductIds([[{ role: 'assistant', content: 'oi, tudo bem?' }]])).toEqual([]);
  });

  it('localizacao_loja anterior com product_ids também conta', () => {
    const loc: ChatMessage[] = [
      { role: 'assistant', content: null, tool_calls: [{ id: 'l1', type: 'function', function: { name: 'localizacao_loja', arguments: JSON.stringify({ bairro: 'Cachambi', product_ids: ['PREV'] }) } }] },
    ];
    expect(extractRecentProductIds([loc])).toEqual(['PREV']);
  });
});
