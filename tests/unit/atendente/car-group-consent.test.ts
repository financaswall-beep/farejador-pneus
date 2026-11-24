import { describe, expect, it } from 'vitest';
import { acceptedCarGroup } from '../../../src/atendente-v2/car-group-consent.js';

const pairOffer = 'Tenho um parzinho conferido. Quer levar o parzinho?';
const customer = (texto: string) => ({ cliente: true, texto });
const bot = (texto: string) => ({ cliente: false, texto });

describe('aceite do par na conversa', () => {
  it.each(['Sim', 'Quero o parzinho', 'Vou levar esse parzinho', 'Fico com o par'])(
    'aceita uma escolha afirmativa: %s', reply => {
      expect(acceptedCarGroup(pairOffer, 2, [customer(reply)])).toBe(true);
    });

  it.each(['Não vou levar o par', 'Não aceito o par', 'Não pode fechar o parzinho', 'Não, obrigado',
    'Prefiro não', 'Nunca quero esse par', 'Talvez eu leve o par', 'Acho que quero o par',
    'Quero o par dependendo do preço', 'Aceito o par se fizer um desconto',
    'Quero ver o desenho do parzinho', 'Manda uma foto do par', 'Quero saber o preço do par'])(
    'não interpreta como compra: %s', reply => {
      expect(acceptedCarGroup(pairOffer, 2, [customer(reply)])).toBe(false);
    });

  it('invalida o sim anterior quando o cliente desiste ou prefere decidir depois', () => {
    for (const refusal of ['Não aceito o par', 'Não vou levar o parzinho', 'Prefiro não', 'Não, obrigado',
      'Quero o par se fizer um desconto', 'Vou pensar']) {
      expect(acceptedCarGroup(pairOffer, 2, [customer('Sim'), customer(refusal)])).toBe(false);
    }
    expect(acceptedCarGroup(pairOffer, 2, [customer('Sim'), customer('Não tenho complemento no endereço')])).toBe(true);
  });

  it('um sim para foto, localização ou escolha entre duas opções não autoriza compra', () => {
    for (const question of ['Quer ver uma foto do parzinho?', 'Posso mandar a localização?',
      'Quer levar o parzinho ou um avulso?']) {
      expect(acceptedCarGroup(pairOffer, 2, [bot(question), customer('Sim')])).toBe(false);
    }
    expect(acceptedCarGroup('Tenho o jogo de quatro pneus.', 4, [customer('Quero o parzinho')])).toBe(false);
  });
});
