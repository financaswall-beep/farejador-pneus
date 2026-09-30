import { z } from 'zod';
const emptyToUndefined = (value: unknown) => typeof value === 'string' && !value.trim() ? undefined : value;

const flag = z.enum(['true', 'false']).default('false').transform(v => v === 'true');
export const publisherEnvShape = {
  MARKETING_PUBLISHER_ENABLED: flag,
  MARKETING_PUBLISHER_SEND_ENABLED: flag,
  SUPABASE_STORAGE_URL: z.preprocess(emptyToUndefined, z.string().url().refine(v => {
    const u = new URL(v);
    return u.protocol === 'https:' && !u.username && !u.password && u.pathname === '/' && !u.search && !u.hash;
  }).optional()),
  SUPABASE_STORAGE_SERVICE_KEY: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  MARKETING_PUBLICATIONS_BUCKET: z.string().regex(/^[a-z0-9-]{3,60}$/).default('farejador-publications'),
  // Limites operacionais da biblioteca, independentes da franquia contratada no Supabase.
  MARKETING_MEDIA_MAX_MB: z.coerce.number().int().min(10).max(500).default(500),
  MARKETING_LIBRARY_MAX_MB: z.coerce.number().int().min(500).max(100000).default(20000),
};
