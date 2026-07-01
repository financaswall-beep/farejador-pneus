import { describe, expect, it } from 'vitest';
import {
  customerChoseDelivery,
  buildDeliveryQuoteFirstNudge,
  DELIVERY_QUOTE_FIRST_NUDGE,
} from '../../../src/atendente-v2/delivery-nudge.js';

describe('customerChoseDelivery', () => {
  it('reconhece o cliente escolhendo ENTREGA (falas reais)', () => {
    expect(customerChoseDelivery('Prefiro que vc entregue então')).toBe(true); // conversa #696
    expect(customerChoseDelivery('pode entregar')).toBe(true);
    expect(customerChoseDelivery('é pra entrega')).toBe(true);
    expect(customerChoseDelivery('quero entrega mesmo')).toBe(true);
  });

  it('NÃO dispara quando o cliente escolhe RETIRADA (evita empurrão errado)', () => {
    expect(customerChoseDelivery('Cara é pra retirar')).toBe(false);
    expect(customerChoseDelivery('prefiro buscar aí')).toBe(false);
    expect(customerChoseDelivery('eu passo aí e pego')).toBe(false);
    // menciona entrega MAS opta por retirada → a palavra de retirada manda
    expect(customerChoseDelivery('não quero entrega não, vou retirar')).toBe(false);
  });

  it('NÃO dispara em mensagem sem escolha de entrega (prompt byte a byte → caching)', () => {
    expect(customerChoseDelivery('Serve sim amigo')).toBe(false);
    expect(customerChoseDelivery('quanto é o 90/90-18?')).toBe(false);
    expect(customerChoseDelivery(null)).toBe(false);
    expect(customerChoseDelivery('')).toBe(false);
  });
});

describe('buildDeliveryQuoteFirstNudge', () => {
  it('anexa o empurrão quando o cliente escolheu entrega E há pino', () => {
    expect(buildDeliveryQuoteFirstNudge('Prefiro que vc entregue então', true)).toBe(DELIVERY_QUOTE_FIRST_NUDGE);
  });

  it('NÃO anexa sem pino (o frete pelo pino depende da coordenada)', () => {
    expect(buildDeliveryQuoteFirstNudge('pode entregar', false)).toBe('');
  });

  it('NÃO anexa quando o cliente não escolheu entrega', () => {
    expect(buildDeliveryQuoteFirstNudge('Serve sim amigo', true)).toBe('');
  });

  it('o texto ataca o furo #696: cotar pelo pino primeiro, endereço só no fechamento', () => {
    expect(DELIVERY_QUOTE_FIRST_NUDGE).toMatch(/calcular_frete/);
    expect(DELIVERY_QUOTE_FIRST_NUDGE).toMatch(/SEM passar "bairro"/);
    expect(DELIVERY_QUOTE_FIRST_NUDGE).toMatch(/FECHAMENTO/);
    expect(DELIVERY_QUOTE_FIRST_NUDGE).toMatch(/NUNCA como condição/);
  });
});
