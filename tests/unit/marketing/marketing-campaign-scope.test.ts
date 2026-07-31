import type { Pool, PoolClient } from 'pg';
import { beforeAll, describe, expect, it, vi } from 'vitest';

let setCampaignScope:
  typeof import('../../../src/marketing/campaign-scope.js').setCampaignScope;

beforeAll(async () => {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    FAREJADOR_ENV: 'test',
    DATABASE_URL: 'postgresql://postgres:password@example.test:6543/postgres',
    CHATWOOT_HMAC_SECRET: 'test-secret',
    ADMIN_AUTH_TOKEN: 'test-admin-token',
    MATRIZ_CENTRAL_LEDGER: 'false',
    MARKETING_SCOPE_ENFORCEMENT_ENABLED: 'false',
  });
  ({ setCampaignScope } = await import('../../../src/marketing/campaign-scope.js'));
});

function scopeRow(scope: 'pending' | 'matrix' | 'external') {
  return {
    id: 'd71e3134-94f2-46fc-9398-581a1060c116',
    environment: 'test' as const,
    ad_account_id: 'act_123',
    campaign_id: 'camp-1',
    campaign_name: 'Campanha real',
    scope,
    classification_reason: scope === 'pending' ? null : 'Campanha própria',
    classified_by: scope === 'pending' ? null : 'Wallace',
    classified_at: scope === 'pending' ? null : '2026-07-31T20:00:00Z',
    updated_at: '2026-07-31T20:00:00Z',
  };
}

describe('classificação manual de campanha', () => {
  it('grava escopo e auditoria na mesma transação', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT campaign_name')) {
        return { rows: [{ campaign_name: 'Campanha real' }], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO marketing.campaign_scopes')) {
        return { rows: [scopeRow('pending')], rowCount: 1 };
      }
      if (sql.includes('FROM marketing.campaign_scopes') && sql.includes('FOR UPDATE')) {
        return { rows: [scopeRow('pending')], rowCount: 1 };
      }
      if (sql.includes('UPDATE marketing.campaign_scopes')) {
        return { rows: [scopeRow('matrix')], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    const client = { query, release: vi.fn() } as unknown as PoolClient;
    const dbPool = { connect: vi.fn().mockResolvedValue(client) } as unknown as Pool;

    const result = await setCampaignScope({
      adAccountId: 'act_123',
      campaignId: 'camp-1',
      scope: 'matrix',
      reason: 'Campanha própria',
      actor: 'Wallace',
      idempotencyKey: 'request-1',
    }, dbPool);

    expect(result).toMatchObject({ previous_scope: 'pending', changed: true });
    const calls = query.mock.calls.map(([sql]) => String(sql));
    expect(calls[0]).toBe('BEGIN');
    expect(calls.some((sql) => sql.includes('INSERT INTO audit.events'))).toBe(true);
    expect(calls.at(-1)).toBe('COMMIT');
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('recusa campanha que não existe e desfaz a transação', async () => {
    const query = vi.fn(async (sql: string) => (
      sql.includes('SELECT campaign_name')
        ? { rows: [], rowCount: 0 }
        : { rows: [], rowCount: 0 }
    ));
    const client = { query, release: vi.fn() } as unknown as PoolClient;
    const dbPool = { connect: vi.fn().mockResolvedValue(client) } as unknown as Pool;

    await expect(setCampaignScope({
      adAccountId: 'act_123',
      campaignId: 'missing',
      scope: 'external',
      reason: 'Operação externa',
      actor: 'Wallace',
      idempotencyKey: 'request-2',
    }, dbPool)).rejects.toThrow('marketing_campaign_not_found');
    expect(query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
    expect(client.release).toHaveBeenCalledOnce();
  });
});
