import pino from 'pino';
import type { LoggerOptions } from 'pino';
import { currentRequestId } from './request-context.js';

const logLevel = ['trace', 'debug', 'info', 'warn', 'error'].includes(process.env.LOG_LEVEL ?? '')
  ? process.env.LOG_LEVEL
  : 'info';

export const loggerOptions: LoggerOptions = {
  level: logLevel,
  serializers: {
    req(request) {
      const url = String(request.url ?? '');
      const oauthUrl=url.startsWith('/admin/dot/') || /^\/admin\/login\?/.test(url);
      return { method:request.method, url:oauthUrl?url.split('?')[0]:url,
        hostname:request.hostname,remoteAddress:request.ip };
    },
  },
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
      '*.access_token',
      '*.refresh_token',
      '*.code_verifier',
      '*.client_secret',
      '*.request_token',
      'access_token',
      'refresh_token',
      'code_verifier',
      'client_secret',
      'request_token',
      'code',
    ],
    censor: '[REDACTED]',
  },
};

export const logger = pino(loggerOptions);
