import { z } from 'zod';
import { publisherEnvShape } from './env-publisher.js';
import { googleAdsEnvShape } from './env-google-ads.js';

const booleanStringSchema = z.enum(['true', 'false']).default('false')
  .transform((value) => value === 'true');
const emptyToUndefined = (value: unknown) =>
  typeof value === 'string' && !value.trim() ? undefined : value;

/** Configuração dormente de Marketing; segredos vivem somente no ambiente. */
export const marketingEnvShape = {
  ...publisherEnvShape,
  ...googleAdsEnvShape,
  META_COMMENTS_ENABLED: booleanStringSchema,
  META_COMMENTS_PUBLISH_ENABLED: booleanStringSchema,
  ORGANIC_ATTRIBUTION_ENABLED: booleanStringSchema,
  ORGANIC_INSTAGRAM_PRIVATE_ENABLED: booleanStringSchema,
  ORGANIC_FACEBOOK_PRIVATE_ENABLED: booleanStringSchema,
  META_COMMENTS_PAGE_ID: z.string().regex(/^[0-9]+$/).optional(),
  META_COMMENTS_INSTAGRAM_ID: z.string().regex(/^[0-9]+$/).optional(),
  META_COMMENTS_APP_ID: z.preprocess(emptyToUndefined, z.string().regex(/^[0-9]+$/).optional()),
  META_COMMENTS_PAGE_ACCESS_TOKEN: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  MARKETING_META_ENABLED: booleanStringSchema,
  MARKETING_SYNC_ENABLED: booleanStringSchema,
  MARKETING_SCOPE_ENFORCEMENT_ENABLED: booleanStringSchema,
  MARKETING_ATTRIBUTION: booleanStringSchema,
  MARKETING_CAPI_ENABLED: booleanStringSchema,
  MARKETING_CAPI_WHATSAPP_ENABLED: booleanStringSchema,
  MARKETING_CAPI_MESSENGER_ENABLED: booleanStringSchema,
  MARKETING_CAPI_INSTAGRAM_ENABLED: booleanStringSchema,
  META_MESSAGING_WEBHOOK_ENABLED: booleanStringSchema,
  CAPI_EXTENDED_MATCHING: booleanStringSchema,
  META_ADS_ACCOUNT_ID: z.string().regex(/^act_[0-9]+$/).optional(),
  META_ADS_ACCESS_TOKEN: z.string().min(1).optional(),
  META_GRAPH_API_VERSION: z.preprocess(emptyToUndefined, z.string().regex(/^v[0-9]+\.[0-9]+$/).default('v21.0')),
  META_CAPI_DATASET_ID: z.string().regex(/^[0-9]+$/).optional(),
  META_CAPI_ACCESS_TOKEN: z.string().min(1).optional(),
  META_CAPI_WHATSAPP_DATASET_ID: z.string().regex(/^[0-9]+$/).optional(),
  META_CAPI_WHATSAPP_ACCESS_TOKEN: z.string().min(1).optional(),
  META_CAPI_PAGE_ID: z.string().regex(/^[0-9]+$/).optional(),
  META_WHATSAPP_BUSINESS_ACCOUNT_ID: z.string().regex(/^[0-9]+$/).optional(),
  META_CAPI_TEST_EVENT_CODE: z.string().min(1).optional(),
  META_MESSAGING_WEBHOOK_VERIFY_TOKEN: z.string().min(1).optional(),
  META_APP_SECRET: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  MARKETING_SYNC_INTERVAL_MS: z.string().transform(Number)
    .pipe(z.number().int().min(60_000)).default('86400000'),
  MARKETING_CAPI_POLL_MS: z.string().transform(Number)
    .pipe(z.number().int().min(1_000)).default('5000'),
};
