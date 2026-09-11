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
    '3.00-10',
  ])('alcança o pedido %s sem exigir busca antes da localização', (message) => {
    const nudge = buildProductSearchNudge(message, false);
    expect(nudge).toContain(CUSTOMER_LOCATION_REQUEST);
    expect(nudge).toContain('peça somente a localização fixa ou o endereço e AGUARDE');
    expect(nudge).not.toContain('OBRIGATÓRIO: chame buscar_produto');
  });

  it.each(['Olá, bom dia', 'Rua das Flores, 50, Alcântara', 'Quero falar com um atendente', '', null])(
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
});
