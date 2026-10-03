const TRANSIENT = new Set(['40001', '40P01', '57014', '53300', '57P01', '57P02', '57P03',
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN']);

export function normalizationFailure(error: unknown, attempts: number) {
  const e = error as { code?: unknown; message?: unknown; cause?: unknown } | null;
  const code = typeof e?.code === 'string' ? e.code : 'NORMALIZATION_ERROR';
  const message = typeof e?.message === 'string' ? e.message : '';
  const transient = TRANSIENT.has(code) || code.startsWith('08')
    || /connection terminated|connection timeout|query read timeout/i.test(message);
  return { code, retry: transient && attempts < 5,
    delaySeconds: Math.min(300, 5 * (2 ** Math.max(0, attempts - 1))) };
}
