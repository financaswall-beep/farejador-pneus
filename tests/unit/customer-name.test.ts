import { describe, expect, it } from 'vitest';
import { isPlaceholderCustomerName, normalizeCustomerNameForOrder, safeCustomerDisplayName } from '../../src/shared/customer-name.js';

describe('qualidade do nome de cliente', () => {
  it.each(['John Doe','Jhon Doe','Jane Doe','Cliente','unknown','+5521999999999','lively-bush-319'])
  ('trata %s como placeholder e impede saudacao nominal', (name) => {
    expect(isPlaceholderCustomerName(name)).toBe(true);
    expect(safeCustomerDisplayName(name)).toEqual({ name: 'Cliente sem nome', needs_review: true });
  });

  it('preserva um nome humano real', () => {
    expect(isPlaceholderCustomerName('Maria da Silva')).toBe(false);
    expect(safeCustomerDisplayName(' Maria da Silva ')).toEqual({
      name: 'Maria da Silva', needs_review: false,
    });
  });

  it('aceita nome confirmado no pedido e recusa apelido automático', () => {
    expect(normalizeCustomerNameForOrder(' 2W Log ')).toBe('2W Log');
    expect(normalizeCustomerNameForOrder('lively-bush-319')).toBeNull();
    expect(normalizeCustomerNameForOrder('')).toBeNull();
    expect(normalizeCustomerNameForOrder(123)).toBeNull();
  });
});
