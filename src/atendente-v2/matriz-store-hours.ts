import { z } from 'zod';

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const dayHours = z.object({
  day: z.number().int().min(0).max(6),
  opens_at: clock,
  closes_at: clock,
}).strict().refine(value => value.closes_at > value.opens_at, {
  path: ['closes_at'], message: 'O fechamento deve ser depois da abertura.',
});

// Ausência de cadastro nunca herda a janela de entregas como horário da loja.
export const storeHoursSchema = z.array(dayHours).min(1).max(7).refine(
  days => new Set(days.map(value => value.day)).size === days.length,
  { message: 'Informe cada dia da semana apenas uma vez.' },
);
export type StoreHours = z.infer<typeof storeHoursSchema>;

export function matrizStoreHoursText(hours: StoreHours | null | undefined): string | null {
  if (!hours?.length) return null;
  const labels = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
  const schedule = [1, 2, 3, 4, 5, 6, 0].map(day => {
    const period = hours.find(value => value.day === day);
    return `${labels[day]}: ${period ? `${period.opens_at} às ${period.closes_at}` : 'fechado'}`;
  }).join('; ');
  return `Funcionamento da loja Matriz (atendimento presencial e retirada): ${schedule}. Horário de Brasília. Entregas seguem horário próprio. Feriados não cadastrados: confirmar antes de prometer atendimento.`;
}
