import type { Pool } from 'pg';
import { beforeAll, describe, expect, it, vi } from 'vitest';

let getPersistedOrLiveMetaSnapshot:
  typeof import('../../../src/marketing/meta-sync.js').getPersistedOrLiveMetaSnapshot;

beforeAll(async () => {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    FAREJADOR_ENV: 'test',
    DATABASE_URL: 'postgresql://postgres:password@example.test:6543/postgres',
    CHATWOOT_HMAC_SECRET: 'test-secret',
    ADMIN_AUTH_TOKEN: 'test-admin-token',
    MARKETING_SCOPE_ENFORCEMENT_ENABLED: 'true',
  });
  ({ getPersistedOrLiveMetaSnapshot } = await import('../../../src/marketing/meta-sync.js'));
});

const config = {
  accessToken: 'server-only',
  adAccountId: 'act_123',
  apiVersion: 'v21.0',
};

describe('leitura Meta com enforcement de escopo', () => {
  it('resultado persistido vazio é zero legítimo e não chama a Meta ao vivo', async () => {
    const dbPool = {
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    } as unknown as Pool;
    const fetcher = vi.fn();

    const result = await getPersistedOrLiveMetaSnapshot(config, '30d', {
      dbPool,
      fetcher: fetcher as typeof fetch,
      now: new Date('2026-07-31T20:00:00Z'),
    });

    expect(result.current).toMatchObject({ spend: 0, campaigns: 0 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('banco indisponível falha fechado e não reintroduz campanha externa', async () => {
    const dbPool = {
      query: vi.fn().mockRejectedValue(new Error('database_unavailable')),
    } as unknown as Pool;
    const fetcher = vi.fn();

    await expect(getPersistedOrLiveMetaSnapshot(config, '30d', {
      dbPool,
      fetcher: fetcher as typeof fetch,
      now: new Date('2026-07-31T20:00:00Z'),
    })).rejects.toThrow('marketing_scoped_snapshot_unavailable');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
