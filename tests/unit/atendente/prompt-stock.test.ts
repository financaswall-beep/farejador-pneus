import { describe, expect, it } from 'vitest';
import { SYSTEM_PROMPT } from '../../../src/atendente-v2/prompt.js';

describe('oferta simples por pneu', () => {
  it('substitui o catálogo de marcas e a escassez por uma oferta sem quantidades', () => {
    expect(SYSTEM_PROMPT).toContain('offer ONE actual product per requested tire');
    expect(SYSTEM_PROMPT).toContain('Do not volunteer brands, product marketing names or stock counts');
    expect(SYSTEM_PROMPT).not.toContain('SCARCITY HOOK');
    expect(SYSTEM_PROMPT).not.toContain('Maggion — R$ 89,00 — 1 unidade');
    expect(SYSTEM_PROMPT).not.toContain('Size with 2+ brand options');
    expect(SYSTEM_PROMPT).toContain('Mention quantity only if the customer asks or their requested quantity cannot be fulfilled');
  });

  it('prioriza estoque elegível sem inventar qualidade ou ignorar a escolha do cliente', () => {
    expect(SYSTEM_PROMPT).toContain('Prefer the highest available stock for that eligible option');
    expect(SYSTEM_PROMPT).toContain('Never let stock volume override an explicit customer preference');
    expect(SYSTEM_PROMPT).toContain('more stock does not mean a less worn or better tire');
    expect(SYSTEM_PROMPT).toContain('"Vê aí o melhor", "escolhe pra mim", "qualquer marca" delegates the choice');
    expect(SYSTEM_PROMPT).toContain('exact returned price');
  });

  it('revela a marca sob demanda e mantém o mesmo produto para foto, frete e pedido', () => {
    expect(SYSTEM_PROMPT).toContain('Mention a brand only when the customer asks');
    expect(SYSTEM_PROMPT).toContain('answer just the offered product\'s returned brand');
    expect(SYSTEM_PROMPT).toContain('search the SAME measure, condition and location with marca set to that request');
    expect(SYSTEM_PROMPT).toContain('Use its exact product_id for pedir_foto, localizacao_loja, calcular_frete and criar_pedido');
    expect(SYSTEM_PROMPT).toContain('Do not ask them to choose a brand first');
    expect(SYSTEM_PROMPT).toContain('Checking another brand is not permission to silently replace the accepted item');
  });

  it('mantém a distinção entre falta de uma marca, da medida e da loja perto', () => {
    expect(SYSTEM_PROMPT).toContain('it does not mean the entire measure is unavailable');
    expect(SYSTEM_PROMPT).toContain('A missing count or tool error is not zero');
    expect(SYSTEM_PROMPT).toContain('sem_estoque_loja_perto=true');
    expect(SYSTEM_PROMPT).toContain('NOT a confirmed nearby store');
    expect(SYSTEM_PROMPT).toContain('do NOT offer stock or price');
  });
});
