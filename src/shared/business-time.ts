const SAO_PAULO_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Sao_Paulo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function businessDateSaoPaulo(value: Date | string): string {
  const instant = typeof value === 'string' ? new Date(value) : value;
  if (!Number.isFinite(instant.getTime())) return '';
  return SAO_PAULO_DATE.format(instant);
}

export function isNotFutureBusinessDate(
  value: Date | string,
  now = new Date(),
): boolean {
  const valueDate = businessDateSaoPaulo(value);
  return valueDate !== '' && valueDate <= businessDateSaoPaulo(now);
}

export function assertNotFutureBusinessDay(
  value: string | null | undefined,
  now = new Date(),
  futureError = 'business_date_future',
): string | null | undefined {
  if (value && value > businessDateSaoPaulo(now)) throw new Error(futureError);
  return value;
}

/**
 * Datas escolhidas em <input type="date"> representam um dia comercial, não
 * uma hora prometida. Hoje vira o instante corrente; passado preserva o valor;
 * um dia realmente futuro continua proibido.
 */
export function normalizeBusinessFactInstant(
  value: string | null | undefined,
  now = new Date(),
  futureError = 'business_date_future',
): string | null | undefined {
  if (!value) return value;
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) return value;
  const valueDate = businessDateSaoPaulo(instant);
  const today = businessDateSaoPaulo(now);
  if (valueDate > today) throw new Error(futureError);
  if (valueDate === today && instant.getTime() > now.getTime()) {
    return now.toISOString();
  }
  return value;
}
