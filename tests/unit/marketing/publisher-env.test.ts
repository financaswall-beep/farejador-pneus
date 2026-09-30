import { it, expect } from 'vitest';
import { z } from 'zod';
import { publisherEnvShape } from '../../../src/shared/config/env-publisher.js';

const schema = z.object(publisherEnvShape);
it('deploy com Storage ainda vazio inicia com envios desligados', () => {
  const value = schema.parse({ SUPABASE_STORAGE_URL: '', SUPABASE_STORAGE_SERVICE_KEY: ' ' });
  expect(value).toMatchObject({ MARKETING_PUBLISHER_ENABLED: false, MARKETING_PUBLISHER_SEND_ENABLED: false });
  expect(value.SUPABASE_STORAGE_URL).toBeUndefined();
  expect(value.SUPABASE_STORAGE_SERVICE_KEY).toBeUndefined();
});
it('configuração de Storage recusa URL com credenciais ou caminho', () => {
  for (const url of ['https://user:password@storage.example/', 'https://storage.example/private', 'http://storage.example/']) {
    expect(schema.safeParse({ SUPABASE_STORAGE_URL: url }).success).toBe(false);
  }
});
