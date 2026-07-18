export const MAX_ATENDENTE_RETRY_ATTEMPTS = 4;
export const STALE_ATENDENTE_PROCESSING_MINUTES = 10;

export interface AtendenteFailure {
  retryable: boolean;
  code: string;
  kind: 'transient' | 'configuration' | 'authorization' | 'validation' | 'unknown';
  summary: string;
}

export function sanitizeOperationalError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/https?:\/\/\S+/gi, '[URL_REDACTED]')
    .replace(/[A-Za-z0-9_-]{20,}/g, '[REDACTED]')
    .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, '[EMAIL_REDACTED]')
    .replace(/\b(?:\+?55\s*)?(?:\(?\d{2}\)?\s*)?9?\d{4}[-\s]?\d{4}\b/g, '[PHONE_REDACTED]')
    .slice(0, 500);
}

export function isRetryableAtendenteError(message: string): boolean {
  const normalized = message.toLowerCase();
  if (
    normalized.includes('configuration is missing') ||
    normalized.includes('openai_api_key not set') ||
    normalized.includes('401') ||
    normalized.includes('403') ||
    normalized.includes('invalid environment variables')
  ) {
    return false;
  }
  return (
    normalized.includes('aborted') ||
    normalized.includes('timeout') ||
    normalized.includes('timed out') ||
    normalized.includes('rate limit') ||
    normalized.includes('429') ||
    normalized.includes('500') ||
    normalized.includes('502') ||
    normalized.includes('503') ||
    normalized.includes('504') ||
    normalized.includes('connection terminated') ||
    normalized.includes('econnreset') ||
    normalized.includes('fetch failed')
  );
}

export function classifyAtendenteError(error: unknown): AtendenteFailure {
  const summary = sanitizeOperationalError(error);
  const normalized = (error instanceof Error ? error.message : String(error)).toLowerCase();
  const technicalCode = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code ?? '') : '';
  if (normalized.includes('configuration is missing') || normalized.includes('openai_api_key not set')
      || normalized.includes('invalid environment variables')) {
    return { retryable: false, code: 'configuration_missing', kind: 'configuration', summary };
  }
  if (/\b401\b/.test(normalized) || /\b403\b/.test(normalized)) {
    return { retryable: false, code: 'provider_authorization', kind: 'authorization', summary };
  }
  if (/\b429\b/.test(normalized) || normalized.includes('rate limit')) {
    return { retryable: true, code: 'provider_rate_limit', kind: 'transient', summary };
  }
  if (normalized.includes('aborted') || normalized.includes('timeout') || normalized.includes('timed out')) {
    return { retryable: true, code: 'provider_timeout', kind: 'transient', summary };
  }
  if (/\b50[0-4]\b/.test(normalized) || normalized.includes('connection terminated')
      || normalized.includes('econnreset') || normalized.includes('econnrefused')
      || normalized.includes('fetch failed') || normalized.includes('connection unexpectedly')
      || /^(08|40|53|57P0)/.test(technicalCode)) {
    return { retryable: true, code: 'provider_unavailable', kind: 'transient', summary };
  }
  if (normalized.includes('validation') || normalized.includes('invalid')) {
    return { retryable: false, code: 'validation_failed', kind: 'validation', summary };
  }
  return { retryable: false, code: 'unclassified_failure', kind: 'unknown', summary };
}

export function retryBackoffSeconds(nextAttemptNumber: number): number {
  if (nextAttemptNumber <= 2) return 60;
  if (nextAttemptNumber === 3) return 5 * 60;
  return 15 * 60;
}
