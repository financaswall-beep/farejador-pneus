import { describe, expect, it } from 'vitest';
import { customerWantsPhoto, PHOTO_NUDGE } from '../../../src/atendente-v2/photo-nudge.js';

describe('customerWantsPhoto', () => {
  it('dispara no pedido real do teste ao vivo (cliente pede foto do pneu)', () => {
    expect(
      customerWantsPhoto('Antes de fechar, dá pra você me mandar uma foto real desse pneu 90/90-18?'),
    ).toBe(true);
  });

  it.each([
    'manda uma foto?',
    'tem foto do pneu?',
    'me manda uma imagem',
    'tem imagens dele?',
    'VOCÊ TEM FOTO?',
    'dá pra ver o pneu antes?',
    'tem como ver ele antes de comprar?',
    'mostra o pneu pra mim',
  ])('dispara em pedido de ver/foto: "%s"', (msg) => {
    expect(customerWantsPhoto(msg)).toBe(true);
  });

  it.each([
    'não quero foto não',
    'sem foto, pode mandar o pix',
    'não precisa de foto',
    'qual o preço?',
    'quero retirar na loja',
    'pode ser entrega amanhã',
    'vou ver com minha esposa e te falo',
    '',
    '   ',
  ])('NÃO dispara em negação/assunto-outro: "%s"', (msg) => {
    expect(customerWantsPhoto(msg)).toBe(false);
  });

  it('null/undefined não disparam', () => {
    expect(customerWantsPhoto(null)).toBe(false);
    expect(customerWantsPhoto(undefined)).toBe(false);
  });

  it('negação no começo não cega um pedido real depois ("não quero a X, quero ver a foto")', () => {
    expect(customerWantsPhoto('não quero a 90/90, quero ver a foto')).toBe(true);
  });

  describe('rede de segurança do turno seguinte (follow-up)', () => {
    it('dispara quando o bot ACABOU de falar de foto e o cliente cobra o envio', () => {
      expect(customerWantsPhoto('Pode mandar to esperando', 'Já pedi pro pessoal separar a foto pra você')).toBe(true);
    });

    it('dispara em "pode pedir sim" logo após o bot oferecer a foto', () => {
      expect(customerWantsPhoto('pode pedir sim', 'Consigo pedir sim, vou chamar pra te mandar a foto, beleza?')).toBe(true);
    });

    it('NÃO dispara se a cobrança vier sem o bot ter falado de foto', () => {
      expect(customerWantsPhoto('pode mandar', 'Qual a cor da sua moto?')).toBe(false);
    });
  });

  it('a ordem injetada proíbe nominalmente a confabulação observada', () => {
    expect(PHOTO_NUDGE).toContain('pedir_foto');
    expect(PHOTO_NUDGE).toContain('já pedi');
    expect(PHOTO_NUDGE).toMatch(/PROIBIDO|proibido/);
  });
});
