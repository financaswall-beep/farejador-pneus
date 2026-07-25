import { z } from 'zod';

const booleanStringSchema = z.enum(['true', 'false']).default('false')
  .transform((value) => value === 'true');

/** Configuração dormente de Marketing; segredos vivem somente no ambiente. */
export const marketingEnvShape = {
  MARKETING_META_ENABLED: booleanStringSchema,
  MARKETING_ATTRIBUTION: booleanStringSchema,
  META_ADS_ACCOUNT_ID: z.string().regex(/^act_[0-9]+$/).optional(),
  META_ADS_ACCESS_TOKEN: z.string().min(1).optional(),
  META_GRAPH_API_VERSION: z.string().regex(/^v[0-9]+\.[0-9]+$/).default('v21.0'),
};
