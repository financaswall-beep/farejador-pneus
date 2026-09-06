import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres';

const require = createRequire(import.meta.url);
const { planResearchImport, loadCatalog, insertPendingResearch }
  = require('../../scripts/catalog-fitment-research.cjs');
const { correctionTargets, removeIncorrectFitments }
  = require('../../scripts/correct-catalog-fitment-errors.cjs');
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
      expect(displayed.find((r: any) => r.discovery_id === radial.id)).toMatchObject({
        status: 'pending', active_reference: { scope: 'manufacturer_measure', product_fitment_confirmed: false },
      });
      for (const product of products) {
        const historical = await getCatalogFitmentDiscoveries(product.product_id, 'test', db.pool);
        expect(historical.every((r: any) => r.active_reference !== null)).toBe(true);
      }
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

  it('catálogo e ferramenta do bot consultam aplicações sem aprovar SKU ou alterar estoque', async () => {
    const { getCatalogCompatibility } = await import('../../src/admin/painel/queries-catalogo-compatibilidade.js');
    const { executeTool } = await import('../../src/atendente-v2/tools.js');
    const client = await db.pool.connect();
    try {
      const before = await untouchedState();
      const products = await loadCatalog(client, 'test');
      const wheel = products.find((p: any) => p.tire_size === '90/90-10');
      const catalog = await getCatalogCompatibility(wheel.product_id, 'test', db.pool);
      expect(catalog.applications.some(a => a.model === 'Burgman 125i' && a.position === 'front')).toBe(true);
      expect(catalog.applications.some(a => a.model === 'Lindy 125' && a.position === 'rear')).toBe(false);
      const result = JSON.parse(await executeTool(client, 'test', randomUUID(), 'buscar_compatibilidade', {
        moto_modelo: 'CB 300F', moto_ano: 2026, posicao_pneu: 'rear',
      }));
      expect(result).toMatchObject({ encontrado: true, produto_confirmado: false, estoque_consultado: false });
      expect(result.aplicacoes[0]).toMatchObject({ tire_size: '150/60R17', position: 'rear' });
      const noSql = { query: async () => { throw new Error('A referência não depende de aprovação no banco'); } } as any;
      const direct = JSON.parse(await executeTool(noSql, 'test', randomUUID(), 'buscar_compatibilidade', {
        moto_modelo: 'Fazer 250', moto_ano: 2025, posicao_pneu: 'rear', condicao_pneu: 'novo',
      }));
      expect(direct).toMatchObject({ encontrado: true, requer_aprovacao_manual_da_referencia: false,
        consultas_de_produto: [{ medida_pneu: '140/70-17', condicao_pneu: 'novo' }] });
      const lookup = JSON.parse(await executeTool(client, 'test', randomUUID(), 'buscar_produto',
        direct.consultas_de_produto[0]));
      expect(lookup.encontrado).toBe(true);
      expect(lookup.produtos).toHaveLength(2);
      expect(lookup.produtos.every((p: any) => p.tire_size === '140/70-17' && p.tire_condition === 'novo')).toBe(true);
      expect(lookup.precisa_localizacao).toBe(true);
      expect(await untouchedState()).toEqual(before);
    } finally { client.release(); }
  });

  it('corrige só os vínculos conhecidos, preserva auditoria e permite rollback integral', async () => {
    const client = await db.pool.connect();
    try {
      const before = await untouchedState();
      await client.query('BEGIN');
      const products = await loadCatalog(client, 'test');
      for (const [make, model, size, position] of [
        ['Suzuki', 'Burgman 125i', '90/90-10', 'rear'],
        ['Haojue', 'Lindy 125', '90/90-10', 'rear'],
        ['Honda', 'CB 300F Twister', '140/70-17', 'both'],
        ['Honda', 'Modelo de controle', '140/70-17', 'rear'],
      ]) {
        const vehicleId = randomUUID();
        await client.query(`INSERT INTO commerce.vehicle_models(id,environment,vehicle_type,make,model)
          VALUES ($1,'test','motorcycle',$2,$3)`, [vehicleId, make, model]);
        const spec = products.find((p: any) => p.tire_size === size);
        await client.query(`INSERT INTO commerce.vehicle_fitments
          (environment,vehicle_model_id,tire_spec_id,position,is_oem,source)
          VALUES ('test',$1,$2,$3,false,'manual')`, [vehicleId, spec.tire_spec_id, position]);
      }
      const targets = await correctionTargets(client, 'test');
      expect(targets).toHaveLength(3);
      expect(await removeIncorrectFitments(client, 'test', targets)).toBe(3);
      expect(await correctionTargets(client, 'test')).toHaveLength(0);
      expect((await client.query(`SELECT count(*)::int total FROM commerce.vehicle_fitments`)).rows[0].total).toBe(1);
      const audit = await client.query(`SELECT payload_before FROM audit.events
        WHERE event_type='catalog_incorrect_fitment_removed' AND environment='test'`);
      expect(audit.rows).toHaveLength(3);
      expect(audit.rows.every(r => r.payload_before.fitment.id)).toBe(true);
      await expect(removeIncorrectFitments(client, 'prod', targets)).rejects.toThrow('invalid_correction_target');
      await client.query('ROLLBACK');
      expect(await untouchedState()).toEqual(before);
    } finally { await client.query('ROLLBACK'); client.release(); }
  });
});
