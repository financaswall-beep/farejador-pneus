const SAO_PAULO_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Sao_Paulo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function businessDate(value: Date): string {
  return SAO_PAULO_DATE.format(value);
}

export function normalizeSameDayFutureInstant(
  value: string | null | undefined,
  now = new Date(),
): string | null | undefined {
  if (!value) return value;
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) return value;
  if (instant.getTime() > now.getTime() && businessDate(instant) === businessDate(now)) {
    return now.toISOString();
  }
  return value;
}
