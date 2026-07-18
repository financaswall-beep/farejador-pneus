import { beforeAll, describe, expect, it } from 'vitest';

const baseEnv = {
  NODE_ENV: 'test',
  FAREJADOR_ENV: 'prod',
  DATABASE_URL: 'postgresql://postgres:password@example.test:6543/postgres',
  PARTNER_DATABASE_URL: 'postgresql://farejador_partner_app.projectref:password@example.test:6543/postgres',
  APP_COMMIT_SHA: 'a'.repeat(40),
  CHATWOOT_HMAC_SECRET: 'test-secret',
  ADMIN_AUTH_TOKEN: 'test-admin-token',
  ADMIN_BEARER_FALLBACK_ENABLED: 'false',
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

  it('fails closed when the restricted partner database URL is missing in production', () => {
    const { PARTNER_DATABASE_URL: _missing, ...withoutPartnerUrl } = baseEnv;
    expect(() => parseEnv({
      ...withoutPartnerUrl,
      NODE_ENV: 'production',
      ADMIN_AUTH_TOKEN: 'a'.repeat(24),
      CHATWOOT_HMAC_SECRET: 'x'.repeat(24),
    })).toThrow(/PARTNER_DATABASE_URL.*required in production/);
  });

  it('rejects an admin or unexpected role in PARTNER_DATABASE_URL in production', () => {
    expect(() => parseEnv({
      ...baseEnv,
      NODE_ENV: 'production',
      PARTNER_DATABASE_URL: 'postgresql://postgres:password@example.test:6543/postgres',
      ADMIN_AUTH_TOKEN: 'a'.repeat(24),
      CHATWOOT_HMAC_SECRET: 'x'.repeat(24),
    })).toThrow(/PARTNER_DATABASE_URL.*restricted farejador_partner_app role/);
  });

  it('rejects the emergency bearer in production after owner bootstrap', () => {
    expect(() => parseEnv({
      ...baseEnv,
      NODE_ENV: 'production',
      ADMIN_BEARER_FALLBACK_ENABLED: 'true',
      ADMIN_AUTH_TOKEN: 'a'.repeat(24),
      CHATWOOT_HMAC_SECRET: 'x'.repeat(24),
    })).toThrow(/ADMIN_BEARER_FALLBACK_ENABLED.*false in production/);
  });

  it('requires an exact deployed commit SHA in production', () => {
    expect(() => parseEnv({
      ...baseEnv,
      NODE_ENV: 'production',
      APP_COMMIT_SHA: 'unknown',
      ADMIN_AUTH_TOKEN: 'a'.repeat(24),
      CHATWOOT_HMAC_SECRET: 'x'.repeat(24),
    })).toThrow(/APP_COMMIT_SHA.*40-character deployed commit SHA/);
  });

  it('uses Coolify SOURCE_COMMIT for a Dockerfile deployment', () => {
    const { APP_COMMIT_SHA: _missing, ...withoutExplicitCommit } = baseEnv;
    const parsed = parseEnv({
      ...withoutExplicitCommit,
      NODE_ENV: 'production',
      SOURCE_COMMIT: 'b'.repeat(40),
      ADMIN_AUTH_TOKEN: 'a'.repeat(24),
      CHATWOOT_HMAC_SECRET: 'x'.repeat(24),
    });

    expect(parsed.APP_COMMIT_SHA).toBe('b'.repeat(40));
  });

  it('caps the webhook replay window at 15 minutes', () => {
    expect(() => parseEnv({ ...baseEnv, CHATWOOT_WEBHOOK_MAX_AGE_SECONDS: '901' }))
      .toThrow(/CHATWOOT_WEBHOOK_MAX_AGE_SECONDS/);
  });

  it('fails closed when BOT_OUTBOX is enabled without Chatwoot sender config', () => {
    expect(() => parseEnv({
      ...baseEnv, NODE_ENV: 'production', BOT_OUTBOX: 'true',
      ADMIN_AUTH_TOKEN: 'a'.repeat(24), CHATWOOT_HMAC_SECRET: 'x'.repeat(24),
    })).toThrow(/CHATWOOT_API_BASE_URL.*bot sender[\s\S]*CHATWOOT_API_TOKEN.*bot sender/);
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

  it('keeps customer identity and privacy dormant by default', () => {
    const parsed = parseEnv(baseEnv);
    expect(parsed.MATRIZ_CUSTOMER_IDENTITY).toBe(false);
    expect(parsed.MATRIZ_CUSTOMER_PRIVACY).toBe(false);
  });
});
