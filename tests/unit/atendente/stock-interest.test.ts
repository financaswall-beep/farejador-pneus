import { describe,expect,it } from 'vitest';
import { contextualRestockConsent,STOCK_INTEREST_TOOL } from '../../../src/atendente-v2/stock-interest.js';

const offer = 'O 180/55-17 meia-vida tá em falta agora. Quer que eu te avise pelo WhatsApp quando chegar?';
describe('aceite contextual da lista de espera', () => {
  it.each(['Pode ser de boa','Pode ser, por favor!','Sim 👍','Quero sim','Pode me avisar no WhatsApp'])('aceita %s após uma oferta real', text => {
    expect(contextualRestockConsent(text,offer)).toBe(true);
  });
  it.each(['Não quero','Pode ser de boa, mas não precisa me avisar','Pode ser amanhã?','Quanto custa?','Pode ser sem WhatsApp'])('não interpreta %s como autorização', text => {
    expect(contextualRestockConsent(text,offer)).toBe(false);
  });
  it('uma aceitação da compra não autoriza aviso de reposição', () => {
    expect(contextualRestockConsent('Pode ser de boa','Quer fechar esse pneu?')).toBe(false);
    expect(contextualRestockConsent('Pode ser de boa','Quer que eu te avise?')).toBe(false);
  });
  it.each([
    'Quer levar o traseiro? Se o dianteiro chegar, posso te avisar pelo WhatsApp.',
    'Posso te avisar pelo WhatsApp quando chegar o dianteiro. Quer levar o traseiro?',
    'Quer levar o traseiro ou quer que eu avise pelo WhatsApp quando chegar o dianteiro?',
    'Quer levar o traseiro e receber um aviso pelo WhatsApp quando o dianteiro chegar?',
    'Quer levar o traseiro? Quer que eu te avise pelo WhatsApp quando o dianteiro chegar?',
  ])('um sim não escolhe o aviso numa oferta mista: %s', mixedOffer => {
    expect(contextualRestockConsent('sim', mixedOffer)).toBe(false);
    expect(contextualRestockConsent('Pode me avisar pelo WhatsApp', mixedOffer)).toBe(true);
  });
  it('aceita uma pergunta curta que confirma somente a proposta de aviso', () => {
    expect(contextualRestockConsent('pode ser', 'Posso te avisar pelo WhatsApp quando chegar. Tudo bem?')).toBe(true);
    expect(contextualRestockConsent('sim', 'Quer que eu te avise pelo WhatsApp quando chegar')).toBe(true);
    expect(contextualRestockConsent('sim', 'O traseiro está disponível. Quando chegar o dianteiro te aviso pelo WhatsApp.')).toBe(false);
  });
  it('permite ao modelo omitir o telefone já cadastrado no WhatsApp', () => {
    expect(STOCK_INTEREST_TOOL.function.parameters.required).not.toContain('telefone');
    expect(STOCK_INTEREST_TOOL.function.description).toContain('OMITA telefone');
  });
});
