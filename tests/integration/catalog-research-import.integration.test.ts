import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres';

const require = createRequire(import.meta.url);
const { planResearchImport, loadCatalog, insertPendingResearch }
  = require('../../scripts/catalog-fitment-research.cjs');
let db: IntegrationDb;
let applications: any[];
let getCatalogFitmentDiscoveries: Function;

beforeAll(async () => {
  db = await startPostgres();
  Object.assign(process.env, { NODE_ENV: 'test', FAREJADOR_ENV: 'test',
    DATABASE_URL: db.connectionString, CHATWOOT_HMAC_SECRET: 'test-secret',
    ADMIN_AUTH_TOKEN: 'admin-test-token' });
  ({ applications } = await import('../../scripts/data/catalog-fitment-research-20260906.mjs'));
  const { createCatalogProduct } = await import('../../src/admin/painel/queries-catalogo-create.js');
  ({ getCatalogFitmentDiscoveries } = await import('../../src/admin/painel/queries-catalogo-discoveries.js'));
  for (const [measure, brand] of [['140/70-17', 'Pirelli'], ['140/70-17', 'Technic'],
    ['90/90-10', 'Pirelli'], ['120/70-15', 'Pirelli']]) {
    await createCatalogProduct({ measure, brand, tireCondition: 'novo',
      productCode: `RES-${randomUUID().slice(0, 8)}`, productName: `Pneu ${brand} ${measure}`,
      actorLabel: 'Teste de importação', environment: 'test' }, db.pool);
  }
}, 180_000);

afterAll(async () => { if (db) await stopPostgres(db); });

async function untouchedState() {
  const result = await db.pool.query(`SELECT
    (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM commerce.products p) products,
    (SELECT jsonb_agg(to_jsonb(ts) ORDER BY ts.id) FROM commerce.tire_specs ts) specs,
    (SELECT count(*)::int FROM commerce.vehicle_fitments) fitments,
    (SELECT count(*)::int FROM commerce.wholesale_stock) stock,
    (SELECT count(*)::int FROM commerce.orders) orders,
    (SELECT count(*)::int FROM finance.matriz_ledger_entries) ledger`);
  return result.rows[0];
}

describe('importação de pesquisa de compatibilidades, sem homologação automática', () => {
  it('dry-run desfaz veículos, candidatas e auditoria', async () => {
    const client = await db.pool.connect();
    try {
      const before = await untouchedState();
      const countsBefore = (await client.query(`SELECT
        (SELECT count(*) FROM commerce.vehicle_models) vehicles,
        (SELECT count(*) FROM audit.events) audit`)).rows[0];
      const plan = planResearchImport(applications, await loadCatalog(client, 'test'));
      await client.query('BEGIN');
      const result = await insertPendingResearch(client, 'test', plan);
      expect(result.discoveries_created.length).toBeGreaterThan(0);
      await client.query('ROLLBACK');
      expect((await client.query('SELECT * FROM commerce.fitment_discoveries')).rows).toHaveLength(0);
      expect((await client.query(`SELECT
        (SELECT count(*) FROM commerce.vehicle_models) vehicles,
        (SELECT count(*) FROM audit.events) audit`)).rows[0]).toEqual(countsBefore);
      expect(await untouchedState()).toEqual(before);
    } finally { client.release(); }
  });

  it('importa pendentes visíveis no painel, sem alterar SKU nem liberar o bot', async () => {
    const client = await db.pool.connect();
    try {
      const before = await untouchedState();
      const products = await loadCatalog(client, 'test');
      const plan = planResearchImport(applications, products);
      await client.query('BEGIN');
      const result = await insertPendingResearch(client, 'test', plan);
      await client.query('COMMIT');
      expect(result.discoveries_created).toHaveLength(plan.candidates.length);
      expect(await untouchedState()).toEqual(before);
      const rows = (await client.query(`SELECT d.*,v.model,v.year_start,v.year_end
        FROM commerce.fitment_discoveries d JOIN commerce.vehicle_models v ON v.id=d.vehicle_model_id`)).rows;
      expect(rows.every(r => r.environment === 'test' && r.status === 'pending'
        && r.reviewed_by === null && r.promoted_to_fitment_id === null)).toBe(true);
      expect(rows.some(r => r.model === 'Classic 350')).toBe(false);
      expect(rows.some(r => r.model === 'CB 300F Twister ABS / CBS')).toBe(false);
      expect(rows.find(r => r.model === 'Burgman 125i')).toMatchObject({ position: 'front', year_start: null });
      expect(rows.find(r => r.model === 'CB 250F Twister ABS / CBS')).toMatchObject({ year_start: 2019, year_end: 2019 });
      const radial = rows.find(r => r.model === 'CB 250F Twister ABS / CBS');
      expect(radial.evidence_summary).toContain('140/70R17');
      const displayed = await getCatalogFitmentDiscoveries(products.find((p: any) => p.tire_size === '140/70-17').product_id, 'test', db.pool);
      expect(displayed.some((r: any) => r.discovery_id === radial.id)).toBe(true);
      const audit = await client.query(`SELECT count(*)::int total FROM audit.events
        WHERE event_type='catalog_fitment_candidate_created'
          AND payload_after->>'batch'=$1`, [plan.batch]);
      expect(audit.rows[0].total).toBe(plan.candidates.length);
    } finally { client.release(); }
  });

  it('reexecução não duplica nem reabre rejeição humana; ambiente prod vazio não recebe teste', async () => {
    const client = await db.pool.connect();
    try {
      const candidate = (await client.query('SELECT id FROM commerce.fitment_discoveries LIMIT 1')).rows[0];
      await client.query(`UPDATE commerce.fitment_discoveries SET status='rejected',
        reviewed_by='Revisor teste',reviewed_at=now(),notes='Não aprovar' WHERE id=$1`, [candidate.id]);
      const plan = planResearchImport(applications, await loadCatalog(client, 'test'));
      await client.query('BEGIN');
      const again = await insertPendingResearch(client, 'test', plan);
      await client.query('COMMIT');
      expect(again.discoveries_created).toHaveLength(0);
      expect(again.vehicles_created).toHaveLength(0);
      expect(again.already_imported).toHaveLength(plan.candidates.length);
      expect((await client.query('SELECT status,notes FROM commerce.fitment_discoveries WHERE id=$1', [candidate.id])).rows[0])
        .toEqual({ status: 'rejected', notes: 'Não aprovar' });
      expect(await loadCatalog(client, 'prod')).toHaveLength(0);
      expect((await client.query("SELECT id FROM commerce.fitment_discoveries WHERE environment='prod'")).rows).toHaveLength(0);
    } finally { client.release(); }
  });
});
