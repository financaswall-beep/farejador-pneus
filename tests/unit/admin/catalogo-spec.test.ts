import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

let updateCatalogTireSpec:
  typeof import('../../../src/admin/painel/queries-catalogo-spec.js').updateCatalogTireSpec;

beforeAll(async () => {
  Object.assign(process.env, {
    NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: 'postgres://test',
    CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'emergency-token',
  });
  ({ updateCatalogTireSpec } = await import('../../../src/admin/painel/queries-catalogo-spec.js'));
});

function fakePool(query: ReturnType<typeof vi.fn>) {
  const release = vi.fn();
  return {
    pool: { connect: vi.fn().mockResolvedValue({ query, release }) } as unknown as Pool,
    release,
  };
}

describe('ficha técnica do catálogo', () => {
  it('atualiza posição e índices com auditoria, sem mexer em estoque', async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (['BEGIN', 'COMMIT'].includes(sql)) return { rows: [] };
      if (sql.includes('SELECT ts.id')) return { rows: [{
        id: 'spec-1', tread_pattern: null, load_index: null,
        speed_rating: null, position: null,
      }] };
      if (sql.includes('UPDATE commerce.tire_specs')) return { rows: [{
        id: 'spec-1', tread_pattern: 'City Extra', load_index: '63',
        speed_rating: 'P', position: 'rear',
      }] };
      if (sql.includes('INSERT INTO audit.events')) {
        expect(String(params?.[4])).toContain('Conferência física');
        return { rows: [] };
      }
      throw new Error(`consulta inesperada: ${sql}`);
    });
    const { pool, release } = fakePool(query);
    await expect(updateCatalogTireSpec({
      productId: 'produto-1', treadPattern: ' City   Extra ', loadIndex: '63',
      speedRating: 'p', position: 'rear', reason: 'Conferência física',
      actorLabel: 'Dono', environment: 'test',
    }, pool)).resolves.toEqual({ changed: true, spec: {
      id: 'spec-1', tread_pattern: 'City Extra', load_index: '63',
      speed_rating: 'P', position: 'rear',
    } });
    const sql = query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).not.toContain('wholesale_stock');
    expect(sql).not.toContain('commerce.orders');
    expect(sql).toContain('catalog_tire_spec_changed');
    expect(release).toHaveBeenCalledOnce();
  });

  it('não grava nem audita quando os dados já são iguais', async () => {
    const query = vi.fn(async (sql: string) => {
      if (['BEGIN', 'COMMIT'].includes(sql)) return { rows: [] };
      if (sql.includes('SELECT ts.id')) return { rows: [{
        id: 'spec-1', tread_pattern: 'City Extra', load_index: '63',
        speed_rating: 'P', position: 'rear',
      }] };
      throw new Error(`consulta inesperada: ${sql}`);
    });
    const { pool } = fakePool(query);
    await expect(updateCatalogTireSpec({
      productId: 'produto-1', treadPattern: 'City Extra', loadIndex: '63',
      speedRating: 'P', position: 'rear', reason: 'Conferido novamente',
      actorLabel: 'Dono', environment: 'test',
    }, pool)).resolves.toMatchObject({ changed: false });
    expect(query.mock.calls.some(([sql]) => String(sql).startsWith('UPDATE'))).toBe(false);
  });
});
