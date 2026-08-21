import { describe, expect, it } from 'vitest';
import { isPlaceholderCustomerName, safeCustomerDisplayName } from '../../src/shared/customer-name.js';

describe('qualidade do nome de cliente', () => {
  it.each(['John Doe','Jhon Doe','Jane Doe','Cliente','unknown','+5521999999999'])
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
});
