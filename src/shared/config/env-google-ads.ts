import { z } from 'zod';

const optional = <T extends z.ZodTypeAny>(schema: T) => z.preprocess(
  value => typeof value === 'string' && !value.trim() ? undefined : value,
  schema.optional(),
);
const customerId = z.string().trim().transform(value => value.replaceAll('-', ''))
  .pipe(z.string().regex(/^\d{10}$/));

/** Credenciais somente no servidor. O escopo nunca é inferido pelo nome da campanha. */
export const googleAdsEnvShape = {
  GOOGLE_ADS_ENABLED: z.enum(['true', 'false']).default('false').transform(value => value === 'true'),
  GOOGLE_ADS_SERVICE_ACCOUNT_JSON: optional(z.string().min(1).max(65_536)),
  GOOGLE_ADS_CLIENT_ID: optional(z.string().trim().min(1)),
  GOOGLE_ADS_CLIENT_SECRET: optional(z.string().min(1)),
  GOOGLE_ADS_REFRESH_TOKEN: optional(z.string().min(1)),
  GOOGLE_ADS_CUSTOMER_ID: optional(customerId),
  GOOGLE_ADS_LOGIN_CUSTOMER_ID: optional(customerId),
  GOOGLE_ADS_API_VERSION: z.preprocess(value => value || undefined, z.string().regex(/^v\d+$/).default('v25')),
  // account: conta exclusiva da 2W; campaigns: somente IDs explicitamente aprovados.
  GOOGLE_ADS_SCOPE: optional(z.enum(['account', 'campaigns'])),
  GOOGLE_ADS_CAMPAIGN_IDS: optional(z.string().trim().regex(/^\d+(?:\s*,\s*\d+)*$/).max(4000)),
  GOOGLE_ADS_FINANCE_SINCE: optional(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine(value => {const d=new Date(`${value}T12:00:00Z`);return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===value;})),
  GOOGLE_ADS_CONVERSIONS_ENABLED: z.enum(['true','false']).default('false').transform(value => value === 'true'),
  GOOGLE_ADS_CONVERSION_ACTION_ID: optional(z.string().regex(/^\d+$/).max(30)),
  GOOGLE_ADS_WHATSAPP_NUMBER: optional(z.string().regex(/^55\d{10,11}$/)),
  GOOGLE_ADS_WEBSITE_URL: optional(z.string().url().refine(value => {
    const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password;
  })),
};
