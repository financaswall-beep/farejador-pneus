import { z } from 'zod';

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const weeklyStoreHoursSchema = z.array(z.object({
  day: z.number().int().min(0).max(6), opens_at: clock, closes_at: clock,
}).strict().refine(day => day.closes_at > day.opens_at, {
  path: ['closes_at'], message: 'O fechamento deve ser depois da abertura.',
})).max(7).refine(days => new Set(days.map(day => day.day)).size === days.length, {
  message: 'Informe cada dia da semana apenas uma vez.',
});
export type WeeklyStoreHours = z.infer<typeof weeklyStoreHoursSchema>;
export const STORE_DAY_LABELS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];

export function readWeeklyStoreHours(value: unknown): WeeklyStoreHours | null {
  const parsed = weeklyStoreHoursSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function weeklyStoreHoursText(hours: WeeklyStoreHours): string {
  return [1, 2, 3, 4, 5, 6, 0].map(day => {
    const period = hours.find(row => row.day === day);
    return `${STORE_DAY_LABELS[day]}: ${period ? `${period.opens_at} às ${period.closes_at}` : 'fechado'}`;
  }).join('; ');
}

export function storeHoursForCustomer(raw: unknown, legacy: string | null, now = new Date()): string | null {
  const hours = readWeeklyStoreHours(raw);
  return hours === null ? legacy : `${weeklyStoreHoursText(hours)}. ${weeklyStoreHoursStatus(hours, now).text} Horário de Brasília.`;
}

export function storeClock(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', weekday: 'short',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const value = (type: string) => parts.find(part => part.type === type)?.value ?? '';
  return { day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(value('weekday')),
    time: `${value('hour')}:${value('minute')}` };
}

export function weeklyStoreHoursStatus(hours: WeeklyStoreHours | null, now = new Date()) {
  if (hours === null) return { state: 'unknown' as const, text: 'Horário por dia ainda não definido.',
    next_opening: null, closes_at: null, time_zone: 'America/Sao_Paulo' };
  const current = storeClock(now);
  const today = hours.find(day => day.day === current.day);
  if (today && current.time >= today.opens_at && current.time < today.closes_at) {
    return { state: 'open' as const, text: `Aberta até ${today.closes_at}.`, next_opening: null,
      closes_at: today.closes_at, time_zone: 'America/Sao_Paulo' };
  }
  for (let offset = 0; offset <= 7; offset += 1) {
    const day = (current.day + offset) % 7;
    const next = hours.find(row => row.day === day);
    if (!next || (offset === 0 && current.time >= next.opens_at)) continue;
    const label = offset === 0 ? 'hoje' : offset === 1 ? 'amanhã' : STORE_DAY_LABELS[day];
    return { state: 'closed' as const, text: `Fechada agora. Abre ${label} às ${next.opens_at}.`,
      next_opening: { day, days_ahead: offset, opens_at: next.opens_at }, closes_at: null,
      time_zone: 'America/Sao_Paulo' };
  }
  return { state: 'closed' as const, text: 'Fechada em todos os dias da semana.',
    next_opening: null, closes_at: null, time_zone: 'America/Sao_Paulo' };
}
