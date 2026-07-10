import pino from 'pino';
import type { LoggerOptions } from 'pino';

const logLevel = ['trace', 'debug', 'info', 'warn', 'error'].includes(process.env.LOG_LEVEL ?? '')
  ? process.env.LOG_LEVEL
  : 'info';

export const loggerOptions: LoggerOptions = {
  level: logLevel,
  redact: {
    paths: [
      'req.headers.authorization',
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
