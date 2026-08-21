import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    FAREJADOR_ENV: 'test',
    DATABASE_URL: 'postgresql://postgres:password@example.test:6543/postgres',
    CHATWOOT_HMAC_SECRET: 'test-secret',
    ADMIN_AUTH_TOKEN: 'test-admin-token',
  });
});

import { setPartnerUnitCoverage } from '../../../src/admin/painel/queries-parceiros-rede.js';

describe('edição das cidades atendidas', () => {
  it('mantém a configuração das cidades retidas e audita a mudança', async () => {
    const statements: Array<{ sql: string; params?: unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        statements.push({ sql, params });
        if (sql.includes('SELECT unit_id,slug')) {
          return { rowCount: 1, rows: [{ unit_id: 'unit-1', slug: 'loja-1' }] };
        }
        if (sql.includes('SELECT DISTINCT municipio')) {
          return { rowCount: 2, rows: [{ municipio: 'niteroi' }, { municipio: 'rio de janeiro' }] };
        }
        return { rowCount: 1, rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client) };

    const result = await setPartnerUnitCoverage(
      'prod', '00000000-0000-4000-8000-000000000001', ['Niterói', 'Maricá'], 'owner', pool as never,
    );

    expect(result).toEqual({ updated: true, changed: true, municipios: ['Maricá', 'Niterói'] });
    expect(statements.some((entry) => entry.sql.includes('NOT (municipio=ANY($3::text[]))'))).toBe(true);
    expect(statements.some((entry) => entry.sql.includes("VALUES ($1,$2,$3,NULL,'city')")
      && entry.params?.[2] === 'marica')).toBe(true);
    expect(statements.some((entry) => entry.sql.includes("'partner_coverage_updated'"))).toBe(true);
    expect(statements.at(-1)?.sql).toBe('COMMIT');
  });

  it('é idempotente e não suja a auditoria quando nada mudou', async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('SELECT unit_id,slug')) return { rowCount: 1, rows: [{ unit_id: 'u', slug: 's' }] };
        if (sql.includes('SELECT DISTINCT municipio')) return { rowCount: 1, rows: [{ municipio: 'niteroi' }] };
        return { rowCount: 1, rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client) };
    const result = await setPartnerUnitCoverage('test', crypto.randomUUID(), ['Niterói'], 'owner', pool as never);
    expect(result.changed).toBe(false);
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO audit.events'))).toBe(false);
  });
});
