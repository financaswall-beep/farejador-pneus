import pino from 'pino';
import type { LoggerOptions } from 'pino';
import { currentRequestId } from './request-context.js';

const logLevel = ['trace', 'debug', 'info', 'warn', 'error'].includes(process.env.LOG_LEVEL ?? '')
  ? process.env.LOG_LEVEL
  : 'info';

export const loggerOptions: LoggerOptions = {
  level: logLevel,
  mixin() {
    const requestId = currentRequestId();
    return {
      service: 'farejador',
      environment: process.env.FAREJADOR_ENV ?? 'unknown',
      ...(process.env.APP_COMMIT_SHA ? { commit: process.env.APP_COMMIT_SHA } : {}),
      ...(requestId ? { request_id: requestId } : {}),
    };
  },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-partner-token"]',
      'req.headers["x-chatwoot-signature"]',
      'req.query.token',
      'req.query.ticket',
      '*.session_token',
      'chatwoot_signature',
      '*.chatwoot_signature',
      '*.phone_number',
      '*.phone_e164',
      '*.email',
      '*.hmac_secret',
    ],
    censor: '[REDACTED]',
  },
};

export const logger = pino(loggerOptions);
