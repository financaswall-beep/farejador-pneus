import { describe, expect, it } from 'vitest';
import { parseRating } from '../../../src/atendente-v2/satisfaction-rating.js';

describe('parseRating', () => {
  it.each([
    ['5', 5],
    ['4', 4],
    ['1', 1],
    ['nota 5', 5],
    ['5 estrelas', 5],
    ['5/5', 5],
    ['3 de 5', 3],
    ['  2  ', 2],
    ['5!', 5],
    ['⭐⭐⭐⭐⭐', 5],
    ['⭐⭐⭐', 3],
    ['★★★★', 4],
  ])('lê a nota de "%s" => %i', (msg, nota) => {
    expect(parseRating(msg)).toBe(nota);
  });

  it.each([
    ['0', '0 não é 1-5'],
    ['6', '6 fora da faixa'],
    ['10', 'número de dois dígitos'],
    ['quero um pneu 180/55-17', 'medida de pneu não é nota'],
    ['90/90-18', 'medida não vira nota'],
    ['obrigado!', 'agradecimento não é nota'],
    ['pode entregar amanhã 5h', 'frase com número não é nota'],
    ['', 'vazio'],
    [null, 'null'],
    [undefined, 'undefined'],
    ['⭐⭐⭐⭐⭐⭐', '6 estrelas fora da faixa'],
  ])('NÃO lê nota de "%s" (%s)', (msg) => {
    expect(parseRating(msg as string | null | undefined)).toBeNull();
  });
});
