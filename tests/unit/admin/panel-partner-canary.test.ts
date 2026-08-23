import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const withPartnerContext = vi.hoisted(() => vi.fn());

vi.hoisted(() => {
  Object.assign(process.env, {
    NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: 'postgres://test:test@example.test/db',
    CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'test-admin-token',
  });
});

vi.mock('../../../src/parceiro/db.js', () => ({ withPartnerContext }));

import {
  getPartnerPanelCanaryHealth,
  setPartnerUnitModernPanel,
} from '../../../src/admin/painel/queries-parceiros-rede.js';
import { recordPartnerPanelCanaryEvent } from '../../../src/parceiro/panel-canary.js';

const source = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const context = {
  environment: 'test' as const,
  partnerId: '11111111-1111-4111-8111-111111111111',
  partnerUnitId: '22222222-2222-4222-8222-222222222222',
  unitId: '33333333-3333-4333-8333-333333333333',
  slug: 'loja-a', partnerName: 'Parceiro A', unitName: 'Loja A',
  role: 'owner' as const, tokenId: '44444444-4444-4444-8444-444444444444',
};

describe('canário do painel moderno por unidade', () => {
  beforeEach(() => vi.clearAllMocks());

  it('nasce desligado, isola INSERT por RLS e não possui campos de negócio/PII', () => {
    const migration = source('db/migrations/0203_partner_modern_panel_canary.sql');
    const table = migration.slice(
      migration.indexOf('CREATE TABLE IF NOT EXISTS ops.partner_panel_canary_events'),
      migration.indexOf('COMMENT ON TABLE ops.partner_panel_canary_events'),
    );
    expect(migration).toContain('modern_panel_enabled BOOLEAN NOT NULL DEFAULT false');
    expect(migration).toContain('FOR INSERT');
    expect(migration).toContain('partner_unit_id=network.current_partner_unit()');
    expect(migration).toContain('GRANT INSERT ON ops.partner_panel_canary_events');
    expect(migration).not.toContain('GRANT SELECT ON ops.partner_panel_canary_events');
    expect(table).not.toMatch(/customer_id|order_id|phone|amount|payload|jsonb/i);
  });

  it('troca a flag com lock, auditoria e repetição idempotente', async () => {
    const statements: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql);
        if (sql.includes('SELECT modern_panel_enabled,slug')) {
          return { rowCount: 1, rows: [{ modern_panel_enabled: false, slug: 'loja-a' }] };
        }
        return { rowCount: 1, rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client) };
    const changed = await setPartnerUnitModernPanel(
      'test', context.partnerUnitId, true, 'owner', pool as never,
    );
    expect(changed).toMatchObject({ updated: true, changed: true, modern_panel_enabled: true });
    expect(statements.some((sql) => sql.includes('FOR UPDATE'))).toBe(true);
    expect(statements.some((sql) => sql.includes("'partner_modern_panel_updated'"))).toBe(true);

    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT modern_panel_enabled,slug')) {
        return { rowCount: 1, rows: [{ modern_panel_enabled: true, slug: 'loja-a' }] };
      }
      return { rowCount: 1, rows: [] };
    });
    const same = await setPartnerUnitModernPanel(
      'test', context.partnerUnitId, true, 'owner', pool as never,
    );
    expect(same.changed).toBe(false);
  });

  it('registra saúde somente se a própria unidade ainda estiver no canário', async () => {
    const query = vi.fn(async () => ({ rowCount: 1, rows: [] }));
    withPartnerContext.mockImplementation(async (_id: string, callback: Function) => callback({ query }));
    const recorded = await recordPartnerPanelCanaryEvent(context, {
      page: 'retiradas', eventType: 'write', operation: 'confirm_pickup',
      outcome: 'success', statusCode: 200, durationMs: 31, errorCode: null,
    });
    expect(recorded).toBe(true);
    expect(withPartnerContext).toHaveBeenCalledWith(context.partnerUnitId, expect.any(Function));
    expect(String(query.mock.calls[0]?.[0])).toContain('pu.modern_panel_enabled=true');
    expect(query.mock.calls[0]?.[1]).toEqual(expect.arrayContaining([
      context.partnerUnitId, context.environment, 'retiradas', 'confirm_pickup',
    ]));
  });

  it('expõe ao dono apenas o agregado técnico das últimas 24 horas', async () => {
    const row = {
      modern_panel_enabled: true, total_events_24h: 8, error_events_24h: 1,
      last_event_at: '2026-08-23T18:00:00Z', last_error_at: null, p95_duration_ms: 42,
    };
    const pool = { query: vi.fn(async () => ({ rows: [row] })) };
    expect(await getPartnerPanelCanaryHealth('test', context.partnerUnitId, pool as never)).toEqual(row);
    const sql = String(pool.query.mock.calls[0]?.[0]);
    expect(sql).toContain("now() - interval '24 hours'");
    expect(sql).toContain('percentile_disc(0.95)');
  });

  it('mantém liga/desliga owner-only e rollback para o painel legado', () => {
    const adminRoute = source('src/admin/painel/route-parceiros.ts');
    const partnerRoute = source('src/parceiro/route.ts');
    const api = source('painel/public/app.partner-api.js');
    const adminUi = source('painel/public/app.rede.canario.js');
    expect(adminRoute).toContain("'/admin/api/partners/:partnerUnitId/modern-panel', { preHandler: requireAdminOwner }");
    expect(adminRoute).toContain("'/admin/api/partners/:partnerUnitId/modern-panel/telemetry', { preHandler: requireAdminOwner }");
    expect(partnerRoute).toContain('modern_panel_enabled: modernPanelEnabled');
    expect(api).toContain("if (me.modern_panel_enabled !== true)");
    expect(api).toContain('location.replace(`/parceiro/${encodeURIComponent(slug)}/`)');
    expect(adminUi).toContain("this.adminUser?.role !== 'owner'");
  });
});
