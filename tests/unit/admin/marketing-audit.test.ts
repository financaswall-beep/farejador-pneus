import type { Pool } from 'pg';
import { beforeAll, describe, expect, it, vi } from 'vitest';

let recordMarketingAudit:
  typeof import('../../../src/admin/painel/marketing-audit.js').recordMarketingAudit;

beforeAll(async () => {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    FAREJADOR_ENV: 'test',
    DATABASE_URL: 'postgresql://postgres:password@example.test:6543/postgres',
    CHATWOOT_HMAC_SECRET: 'test-secret',
    ADMIN_AUTH_TOKEN: 'test-admin-token',
  });
  ({ recordMarketingAudit } = await import('../../../src/admin/painel/marketing-audit.js'));
});

describe('Marketing — auditoria manual', () => {
  it('registra apenas metadados operacionais no domínio marketing', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    const dbPool = { query } as unknown as Pool;

    await expect(recordMarketingAudit({
      eventType: 'marketing_capi_test',
      actorLabel: 'Administrador',
      entityTable: 'marketing.capi_test',
      idempotencyKey: 'request-1',
      payload: { status: 'succeeded', events_received: 1 },
    }, dbPool)).resolves.toBe(true);

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toContain('INSERT INTO audit.events');
    expect(query.mock.calls[0]?.[0]).toContain("'marketing'");
    expect(query.mock.calls[0]?.[1]).toEqual([
      'test',
      'marketing.capi_test',
      null,
      'marketing_capi_test',
      'Administrador',
      'request-1',
      JSON.stringify({ status: 'succeeded', events_received: 1 }),
    ]);
    expect(JSON.stringify(query.mock.calls[0])).not.toMatch(
      /access_token|ctwa_clid|phone_e164/i,
    );
  });

  it('não derruba a ação principal quando a auditoria falha', async () => {
    const dbPool = {
      query: vi.fn().mockRejectedValue(new Error('audit_unavailable')),
    } as unknown as Pool;

    await expect(recordMarketingAudit({
      eventType: 'marketing_sync_manual',
      actorLabel: 'Administrador',
      entityTable: 'marketing.meta_sync_runs',
      payload: { status: 'failed' },
    }, dbPool)).resolves.toBe(false);
  });
});
