import { describe, expect, it } from 'vitest';
import {
  buildProductSearchNudge,
  CUSTOMER_LOCATION_REQUEST,
} from '../../../src/atendente-v2/product-search-nudge.js';

describe('orientação de localização antes da busca de pneu', () => {
  it.each([
    'entao to precisando de um pneuzinho traseiro da twister tem',
    'tem pneus pra nmax?',
    '90/90-12',
    '130/70R13',
    '130 70 13',
    '90 90 12',
    'quero pneu 130 - 70 - 13',
    '140/70 ZR17',
    '3.00-10',
  ])('alcança o pedido %s sem exigir busca antes da localização', (message) => {
    const nudge = buildProductSearchNudge(message, false);
    expect(nudge).toContain(CUSTOMER_LOCATION_REQUEST);
    expect(nudge).toContain('peça somente a localização fixa ou o endereço e AGUARDE');
    expect(nudge).not.toContain('OBRIGATÓRIO: chame buscar_produto');
  });

  it.each(['Olá, bom dia', 'Rua das Flores, 50, Alcântara', 'Quero falar com um atendente',
    '11/09/2026', '11 09 26', '+55 21 99999-9999', '130 70', '', null])(
    'não força busca nem abertura na mensagem %s', (message) => {
      expect(buildProductSearchNudge(message, false)).toBe('');
    },
  );

  it('com pino recebido, retira o pedido de localização e mantém a consulta pela medida', () => {
    const nudge = buildProductSearchNudge('tem 130/70-13?', true);
    expect(nudge).not.toContain(CUSTOMER_LOCATION_REQUEST);
    expect(nudge).toContain('NÃO peça a localização novamente');
    expect(nudge).toContain('use buscar_produto com essa medida');
  });

  it('considera o endereço digitado junto do produto ou já presente no histórico', () => {
    const nudge = buildProductSearchNudge('quero 90/90-12, sou de Alcântara', false);
    expect(nudge).toContain('Confira a mensagem atual e o histórico');
    expect(nudge).toContain('Se o endereço/bairro/região JÁ foi informado, aproveite-o');
  });

  it('medida com espaços segue a busca direta mesmo com nome de moto na mensagem', () => {
    const nudge = buildProductSearchNudge('quero 130 70 13 pra NMAX', true);
    expect(nudge).toContain('use buscar_produto com essa medida');
    expect(nudge).toContain('não pergunte modelo da moto, ano, dianteiro/traseiro nem peça foto');
    expect(nudge).not.toContain('quando houver somente o modelo da moto');
    expect(nudge).not.toContain(CUSTOMER_LOCATION_REQUEST);
  });
});
