import { describe, expect, it } from 'vitest';
import { commissionItemRulesOf } from '../../../src/shared/operation-team.js';

describe('regras itemizadas de comissão', () => {
  it('aceita fixo apenas para pneu e preserva percentuais por grupo', () => {
    expect(commissionItemRulesOf({
      tire: { kind: 'fixed', value: 10 },
      service: { kind: 'percent', value: 5 },
      other: { kind: 'none', value: 99 },
    })).toEqual({
      tire: { kind: 'fixed', value: 10 },
      service: { kind: 'percent', value: 5 },
      other: { kind: 'none', value: 0 },
    });
  });

  it('rejeita fixo em serviço e percentual acima de cem', () => {
    expect(commissionItemRulesOf({
      tire: { kind: 'percent', value: 101 },
      service: { kind: 'fixed', value: 10 },
      other: { kind: 'percent', value: 3 },
    })).toEqual({
      tire: { kind: 'none', value: 0 },
      service: { kind: 'none', value: 0 },
      other: { kind: 'percent', value: 3 },
    });
  });
});
