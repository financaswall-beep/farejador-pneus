import { beforeAll, describe, expect, it } from 'vitest';

const baseEnv = {
  NODE_ENV: 'test',
  FAREJADOR_ENV: 'prod',
  DATABASE_URL: 'postgresql://postgres:password@example.test:6543/postgres',
  CHATWOOT_HMAC_SECRET: 'test-secret',
  ADMIN_AUTH_TOKEN: 'test-admin-token',
};

let parseEnv: typeof import('../../../src/shared/config/env.js').parseEnv;

beforeAll(async () => {
  Object.assign(process.env, baseEnv);
  ({ parseEnv } = await import('../../../src/shared/config/env.js'));
});

describe('environment security validation', () => {
  it('rejects short production secrets', () => {
    expect(() => parseEnv({
      ...baseEnv,
      NODE_ENV: 'production',
      ADMIN_AUTH_TOKEN: 'short',
      CHATWOOT_HMAC_SECRET: 'also-short',
    })).toThrow(/ADMIN_AUTH_TOKEN.*24 bytes[\s\S]*CHATWOOT_HMAC_SECRET.*24 bytes/);
  });

  it('accepts a strong 24-byte production secret (192 bits)', () => {
    const parsed = parseEnv({
      ...baseEnv,
      NODE_ENV: 'production',
      ADMIN_AUTH_TOKEN: 'a'.repeat(24),
      CHATWOOT_HMAC_SECRET: 'x'.repeat(24), // 24 chars = piso mínimo (192 bits)
    });

    expect(parsed.CHATWOOT_HMAC_SECRET).toHaveLength(24);
  });

  it('caps the webhook replay window at 15 minutes', () => {
    expect(() => parseEnv({ ...baseEnv, CHATWOOT_WEBHOOK_MAX_AGE_SECONDS: '901' }))
      .toThrow(/CHATWOOT_WEBHOOK_MAX_AGE_SECONDS/);
  });

  it('parses an explicit trusted proxy policy', () => {
    expect(parseEnv({ ...baseEnv, TRUST_PROXY: 'loopback, linklocal, uniquelocal' }).TRUST_PROXY)
      .toBe('loopback, linklocal, uniquelocal');
    expect(parseEnv({ ...baseEnv, TRUST_PROXY: 'false' }).TRUST_PROXY).toBe(false);
  });

  it('allows disabling the emergency admin bearer after owner bootstrap', () => {
    expect(parseEnv({ ...baseEnv, ADMIN_BEARER_FALLBACK_ENABLED: 'false' }).ADMIN_BEARER_FALLBACK_ENABLED)
      .toBe(false);
  });
});
