import { afterEach, describe, expect, it, vi } from 'vitest';
import { operationCommissionBounds } from '../../../src/shared/operation-commissions.js';

describe('calendário da comissão na Operação da Loja', () => {
  afterEach(() => vi.useRealTimers());

  it('usa domingo a sábado no atalho semanal e mês civil no mensal', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-15T15:00:00Z'));

    expect(operationCommissionBounds('7d')).toEqual({
      start: '2026-08-09', end: '2026-08-16', competence: '2026-08-01',
    });
    expect(operationCommissionBounds('30d')).toEqual({
      start: '2026-08-01', end: '2026-08-16', competence: '2026-08-01',
    });
  });
});
