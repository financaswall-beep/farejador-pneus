import { z } from 'zod';

export const aiEnvShape = {
  OPENAI_API_KEY: z.preprocess(
    value => typeof value === 'string' && value.trim() === '' ? undefined : value,
    z.string().min(1).optional(),
  ),
  OPENAI_MODEL: z.string().min(1).default('gpt-4o-mini'),
  BOT_AUDIO_ENABLED: z.enum(['true', 'false']).default('false').transform(value => value === 'true'),
  BOT_AUDIO_MODEL: z.enum(['gpt-4o-mini-transcribe', 'gpt-4o-transcribe']).default('gpt-4o-mini-transcribe'),
  BOT_AUDIO_ALLOWED_HOSTS: z.string().default('').transform(value =>
    value.split(',').map(host => host.trim().toLowerCase()).filter(Boolean)),
  // Câmbio de referência para estimativas, não cotação ao vivo nem fatura do cartão.
  OPENAI_USD_BRL: z.coerce.number().positive().max(100).default(5.5),
  OPENAI_TIMEOUT_MS: z.string().transform(Number).pipe(z.number().int().min(1000)).default('30000'),
};
