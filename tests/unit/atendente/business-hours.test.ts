import { describe, expect, it } from 'vitest';
import { hasElapsedBusinessHours, type InboxBusinessHours } from '../../../src/atendente-v2/business-hours.js';

const weekdaySchedule: InboxBusinessHours = {
  enabled: true,
  timezone: 'America/Sao_Paulo',
  workingHours: [1, 2, 3, 4, 5].map((dayOfWeek) => ({
    dayOfWeek, closedAllDay: false, openAllDay: false,
    openHour: 9, openMinutes: 0, closeHour: 18, closeMinutes: 0,
  })),
};

describe('horas comerciais do inbox', () => {
  it('usa tempo contínuo quando o horário de funcionamento está desligado', () => {
    const config = { ...weekdaySchedule, enabled: false };
    expect(hasElapsedBusinessHours(
      new Date('2026-09-07T10:00:00Z'), new Date('2026-09-07T18:00:00Z'), 8, config,
    )).toBe(true);
  });

  it('não conta noite nem fim de semana', () => {
    // Sexta 17h-18h + segunda 9h-16h no horário de São Paulo = 8 horas.
    const start = new Date('2026-09-04T20:00:00Z');
    expect(hasElapsedBusinessHours(start, new Date('2026-09-07T18:59:00Z'), 8, weekdaySchedule))
      .toBe(false);
    expect(hasElapsedBusinessHours(start, new Date('2026-09-07T19:00:00Z'), 8, weekdaySchedule))
      .toBe(true);
  });

  it('falha fechada quando a agenda está vazia', () => {
    expect(hasElapsedBusinessHours(new Date(0), new Date(100 * 60 * 60_000), 8, {
      enabled: true, timezone: 'America/Sao_Paulo', workingHours: [],
    })).toBe(false);
  });
});
