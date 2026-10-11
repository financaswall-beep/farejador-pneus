import { describe, expect, it } from 'vitest';
import { readWeeklyStoreHours, weeklyStoreHoursSchema, weeklyStoreHoursStatus, weeklyStoreHoursText } from '../../../src/shared/weekly-store-hours.js';

const monday = [{ day: 1, opens_at: '08:00', closes_at: '18:00' }];
describe('horário semanal preciso da loja', () => {
  it.each(['2026-10-05T11:00:00Z','2026-10-05T20:59:59Z'])('considera aberta dentro da janela (%s)', date => {
    expect(weeklyStoreHoursStatus(monday, new Date(date)).state).toBe('open');
  });
  it('fecha exatamente às 18h e encontra a próxima segunda sem usar fuso do servidor', () => {
    expect(weeklyStoreHoursStatus(monday, new Date('2026-10-05T21:00:00Z'))).toMatchObject({ state: 'closed',
      next_opening: { day: 1, days_ahead: 7, opens_at: '08:00' } });
  });
  it('antes de abrir informa hoje; domingo informa amanhã', () => {
    expect(weeklyStoreHoursStatus(monday, new Date('2026-10-05T10:59:00Z')).text).toContain('hoje às 08:00');
    expect(weeklyStoreHoursStatus(monday, new Date('2026-10-04T21:00:00Z')).text).toContain('amanhã às 08:00');
  });
  it('domingo à noite em Brasília não vira segunda pela data UTC', () => {
    expect(weeklyStoreHoursStatus(monday, new Date('2026-10-05T01:00:00Z')).next_opening?.days_ahead).toBe(1);
  });
  it('distingue cadastro ausente de fechamento explícito da semana', () => {
    expect(weeklyStoreHoursStatus(null).state).toBe('unknown');
    expect(weeklyStoreHoursStatus([]).text).toBe('Fechada em todos os dias da semana.');
    expect(readWeeklyStoreHours('Segunda a sexta')).toBeNull();
    expect(readWeeklyStoreHours([])).toEqual([]);
  });
  it.each([
    [{ day: 1, opens_at: '18:00', closes_at: '08:00' }],
    [{ day: 1, opens_at: '08:00', closes_at: '08:00' }],
    [{ day: 7, opens_at: '08:00', closes_at: '18:00' }],
    [{ day: 1, opens_at: '8:00', closes_at: '18:00' }],
    [{ day: 1, opens_at: '08:00', closes_at: '24:00' }],
    [{ ...monday[0], pause: '12:00' }], [...monday, ...monday],
  ])('recusa cadastro inválido %j', hours => expect(weeklyStoreHoursSchema.safeParse(hours).success).toBe(false));
  it('mantém um texto legível para clientes do painel anterior', () => {
    expect(weeklyStoreHoursText(monday)).toContain('segunda-feira: 08:00 às 18:00');
    expect(weeklyStoreHoursText(monday)).toContain('domingo: fechado');
  });
});
