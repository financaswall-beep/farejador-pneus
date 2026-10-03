/** Vencimentos futuros não envelhecem; as datas históricas dos fatos continuam explícitas. */
export function futureDueDate(days = 30): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(Date.now() + days * 86_400_000));
}
