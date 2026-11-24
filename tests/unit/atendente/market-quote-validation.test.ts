import { describe, expect, it } from 'vitest';
import { matchesSentMarketQuote } from '../../../src/atendente-v2/market-quote-validation.js';

const bridgestone = { product_id: 'bridgestone', brand: 'Bridgestone', price_amount: '390.00', tread_pattern: 'Dueler H/T' };
const michelin = { product_id: 'michelin', brand: 'Michelin', price_amount: '390.00', tread_pattern: 'Primacy 4' };
const quote = { product_id: 'bridgestone', preco_unitario: 390, quantidade: 4, modelo: 'Dueler H/T' };

describe('confirmação de cotação efetivamente enviada', () => {
  it.each(['Sai a R$ 390,00 cada.', 'O pneu sai por **R$ 390**.', 'São 390 reais cada.', 'Sai por R$ 390.00.'])
    ('lê o preço unitário em %s', text => {
      expect(matchesSentMarketQuote(text, 'bridgestone', [bridgestone])).toBe(true);
    });

  it('lê o total inequívoco do conjunto', () => {
    expect(matchesSentMarketQuote('O jogo fica R$ 1.560,00.', 'bridgestone', [bridgestone], quote)).toBe(true);
    expect(matchesSentMarketQuote('O jogo fica R$ 1.560.', 'bridgestone', [bridgestone], quote)).toBe(true);
    expect(matchesSentMarketQuote('Consigo o jogo a R$ 1.559,99.', 'bridgestone', [bridgestone], quote)).toBe(false);
    expect(matchesSentMarketQuote('O jogo fica R$ 390,00.', 'bridgestone', [bridgestone], quote)).toBe(false);
    expect(matchesSentMarketQuote('O jogo fica R$ 390,00 por unidade.', 'bridgestone', [bridgestone], quote)).toBe(true);
    expect(matchesSentMarketQuote('Fica R$ 1.560,00 cada pneu.', 'bridgestone', [bridgestone], quote)).toBe(false);
  });

  it('exige indicação inequívoca de marca ou modelo se o mesmo valor aparecer em outros itens', () => {
    const candidates = [bridgestone, michelin];
    expect(matchesSentMarketQuote('Sai a R$ 390,00 cada.', 'bridgestone', candidates)).toBe(false);
    expect(matchesSentMarketQuote('Bridgestone R$ 390,00.', 'bridgestone', candidates)).toBe(true);
    expect(matchesSentMarketQuote('Michelin R$ 390,00.', 'bridgestone', candidates)).toBe(false);
    expect(matchesSentMarketQuote('Michelin R$ 390,00.', 'michelin', candidates)).toBe(true);
    expect(matchesSentMarketQuote('Dueler H/T R$ 390,00.', 'bridgestone', candidates)).toBe(true);
    const sameBrand = { ...bridgestone, product_id: 'alenza', tread_pattern: 'Alenza' };
    expect(matchesSentMarketQuote('Bridgestone R$ 390,00.', 'bridgestone', [bridgestone, sameBrand])).toBe(false);
    expect(matchesSentMarketQuote('Bridgestone Dueler H/T R$ 390,00.', 'bridgestone', [bridgestone, sameBrand])).toBe(true);
    expect(matchesSentMarketQuote('Dueler R$ 390,00.', 'bridgestone', [bridgestone, sameBrand])).toBe(false);
  });

  it.each(['Tenho essa medida. Quer fotos?', 'O frete é R$ 390,00.', 'Não posso fazer por R$ 390,00.',
    'A instalação custa R$ 390,00.', 'O desconto é de R$ 390,00.', 'O mesmo pneu novo online custa R$ 390,00.',
    'Prefere gastar até R$ 390,00? Qual seu orçamento?', 'O pneu sai por R$ 390,99.', 'O pneu sai por R$ 390,0.'])
    ('recusa texto sem cotação firme daquele produto em %s', text => {
      expect(matchesSentMarketQuote(text, 'bridgestone', [bridgestone])).toBe(false);
    });
});
