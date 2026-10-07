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
  it('permite ao modelo omitir o telefone já cadastrado no WhatsApp', () => {
    expect(STOCK_INTEREST_TOOL.function.parameters.required).not.toContain('telefone');
    expect(STOCK_INTEREST_TOOL.function.description).toContain('OMITA telefone');
  });
});
