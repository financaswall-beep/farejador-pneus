import { z } from 'zod';

const booleanStringSchema = z.enum(['true', 'false']).default('false')
  .transform((value) => value === 'true');

/** Configuração dormente de Marketing; segredos vivem somente no ambiente. */
export const marketingEnvShape = {
  MARKETING_META_ENABLED: booleanStringSchema,
  MARKETING_SYNC_ENABLED: booleanStringSchema,
  MARKETING_ATTRIBUTION: booleanStringSchema,
  MARKETING_CAPI_ENABLED: booleanStringSchema,
  CAPI_EXTENDED_MATCHING: booleanStringSchema,
  META_ADS_ACCOUNT_ID: z.string().regex(/^act_[0-9]+$/).optional(),
  META_ADS_ACCESS_TOKEN: z.string().min(1).optional(),
  META_GRAPH_API_VERSION: z.string().regex(/^v[0-9]+\.[0-9]+$/).default('v21.0'),
  META_CAPI_DATASET_ID: z.string().regex(/^[0-9]+$/).optional(),
  META_CAPI_ACCESS_TOKEN: z.string().min(1).optional(),
  META_CAPI_PAGE_ID: z.string().regex(/^[0-9]+$/).optional(),
  META_WHATSAPP_BUSINESS_ACCOUNT_ID: z.string().regex(/^[0-9]+$/).optional(),
  META_CAPI_TEST_EVENT_CODE: z.string().min(1).optional(),
  MARKETING_SYNC_INTERVAL_MS: z.string().transform(Number)
    .pipe(z.number().int().min(60_000)).default('86400000'),
  MARKETING_CAPI_POLL_MS: z.string().transform(Number)
    .pipe(z.number().int().min(1_000)).default('5000'),
};
