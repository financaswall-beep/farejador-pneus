import { z } from 'zod';

export const dotEnvShape = {
  DOT_MCP_ENABLED: z.enum(['true','false']).default('false').transform(value => value === 'true'),
  DOT_MCP_PUBLIC_ORIGIN: z.string().url().optional(),
  DOT_MCP_CLIENT_ID: z.string().min(3).max(120).default('farejador-dot'),
  DOT_MCP_REDIRECT_URIS: z.string().default('https://chatgpt.com/connector_platform_oauth_redirect'),
};
