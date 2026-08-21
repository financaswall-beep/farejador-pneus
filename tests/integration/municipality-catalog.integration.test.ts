import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres';

let db: IntegrationDb;

beforeAll(async () => {
  db = await startPostgres();
}, 180_000);

afterAll(async () => {
  if (db) await stopPostgres(db);
});

describe('migration 0195 — catálogo de municípios', () => {
  it('instala 92 cidades e o gatilho protegido', async () => {
    const catalog = await db.pool.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE state_code='RJ' AND active)::int AS validos
         FROM network.municipality_catalog`,
    );
    expect(catalog.rows[0]).toEqual({ total: 92, validos: 92 });

    const guard = await db.pool.query(
      `SELECT p.prosecdef,
              array_to_string(p.proconfig,',') AS config,
              has_function_privilege('farejador_partner_app',p.oid,'EXECUTE') AS partner_execute
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='network' AND p.proname='guard_supported_municipality'`,
    );
    expect(guard.rows).toHaveLength(1);
    expect(guard.rows[0].prosecdef).toBe(true);
    expect(guard.rows[0].config).toContain('search_path=pg_catalog, network');
    expect(guard.rows[0].partner_execute).toBe(false);
  });

  it('recusa erro de digitação em produção e preserva fixtures sintéticas de teste', async () => {
    const prodUnitId = randomUUID();
    const testUnitId = randomUUID();
    await db.pool.query(
      `INSERT INTO core.units (id,environment,slug,name,is_active)
       VALUES ($1,'prod',$2,'Unidade Prod',true),($3,'test',$4,'Unidade Teste',true)`,
      [prodUnitId, `prod-${prodUnitId}`, testUnitId, `test-${testUnitId}`],
    );

    await db.pool.query(
      `INSERT INTO network.unit_coverage (environment,unit_id,municipio)
       VALUES ('prod',$1,'niteroi')`,
      [prodUnitId],
    );
    await expect(db.pool.query(
      `INSERT INTO network.unit_coverage (environment,unit_id,municipio)
       VALUES ('prod',$1,'niteroii')`,
      [prodUnitId],
    )).rejects.toMatchObject({ code: '23514' });
    await expect(db.pool.query(
      `INSERT INTO network.unit_coverage (environment,unit_id,municipio)
       VALUES ('test',$1,'cidade-sintetica')`,
      [testUnitId],
    )).resolves.toMatchObject({ rowCount: 1 });
  });
});
