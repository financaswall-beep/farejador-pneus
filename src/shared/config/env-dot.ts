import { z } from 'zod';

export const dotEnvShape = {
  DOT_MCP_ENABLED: z.enum(['true','false']).default('false').transform(value => value === 'true'),
  DOT_EVENTS_ENABLED: z.enum(['true','false']).default('false').transform(value => value === 'true'),
  DOT_EVENTS_ENCRYPTION_KEY: z.string().default(''),
  DOT_EVENTS_WAIT_MINUTES: z.coerce.number().int().min(1).max(120).default(10),
  DOT_EVENTS_COOLDOWN_MINUTES: z.coerce.number().int().min(1).max(1440).default(10),
  DOT_EVENTS_MAX_PER_HOUR: z.coerce.number().int().min(1).max(300).default(30),
  DOT_EVENTS_QUIET_START_HOUR: z.coerce.number().int().min(0).max(23).default(22),
  DOT_EVENTS_QUIET_END_HOUR: z.coerce.number().int().min(0).max(23).default(8),
  DOT_MCP_PUBLIC_ORIGIN: z.preprocess(value => typeof value === 'string' && value.trim() === '' ? undefined : value,
    z.string().url().optional()),
  DOT_MCP_CLIENT_ID: z.string().min(3).max(120).default('farejador-dot'),
  DOT_MCP_REDIRECT_URIS: z.string().default('https://chatgpt.com/connector_platform_oauth_redirect'),
};
