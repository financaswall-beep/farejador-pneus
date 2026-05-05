import { describe, expect, it } from 'vitest';
import { parsePolicyValue } from '../../../../src/atendente/policies/policy-schemas.js';

describe('POLICY_VALUE_SCHEMAS', () => {
  it('valida desconto_maximo estruturado', () => {
    expect(parsePolicyValue('desconto_maximo', { pct: 5 })).toEqual({ pct: 5 });
  });

  it('rejeita desconto_maximo ambiguo', () => {
    expect(() => parsePolicyValue('desconto_maximo', { value: 5 })).toThrow();
  });

  it('rejeita policy key desconhecida antes do Planner consumir JSON cru', () => {
    expect(() => parsePolicyValue('politica_solteira', { qualquer: true })).toThrow(
      'unsupported_policy_key:politica_solteira',
    );
  });

  it('valida prazo_troca estruturado', () => {
    expect(parsePolicyValue('prazo_troca', { days: 7, condition: 'produto sem uso' })).toEqual({
      days: 7,
      condition: 'produto sem uso',
    });
  });
});
