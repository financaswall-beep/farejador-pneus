import { describe, expect, it } from 'vitest';
import { performanceMoney, teamPerformanceBounds } from '../../../src/shared/operation-performance.js';

describe('período comum do desempenho operacional', () => {
  const now = new Date('2026-08-26T15:00:00.000Z');

  it('fecha intervalos no dia local de São Paulo sem misturar o dia seguinte', () => {
    expect(teamPerformanceBounds('7d', now)).toEqual({ start: '2026-08-20', end: '2026-08-27' });
    expect(teamPerformanceBounds('30d', now)).toEqual({ start: '2026-07-28', end: '2026-08-27' });
    expect(teamPerformanceBounds('month', now)).toEqual({ start: '2026-08-01', end: '2026-08-27' });
  });

  it('arredonda valores monetários somente na fronteira de apresentação', () => {
    expect(performanceMoney('12.345')).toBe(12.35);
    expect(performanceMoney(null)).toBe(0);
  });
});
