import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';

let db: IntegrationDb;
let create: typeof import('../../src/admin/painel/queries-catalogo-create.js').createCatalogProduct;
let edit: typeof import('../../src/admin/painel/queries-catalogo-spec.js').updateCatalogTireSpec;
let inventory: typeof import('../../src/admin/painel/catalog-vehicle-inventory.js').getCatalogVehicleInventory;
let catalog: typeof import('../../src/admin/painel/queries-catalogo.js').getCatalogOverview;
let compatibility: typeof import('../../src/admin/painel/queries-catalogo-compatibilidade.js');

beforeAll(async () => {
  Object.assign(process.env, { NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: 'postgres://test',
    CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'test-token' });
  db = await startPostgres();
  ({ createCatalogProduct: create } = await import('../../src/admin/painel/queries-catalogo-create.js'));
  ({ updateCatalogTireSpec: edit } = await import('../../src/admin/painel/queries-catalogo-spec.js'));
  ({ getCatalogVehicleInventory: inventory } = await import('../../src/admin/painel/catalog-vehicle-inventory.js'));
  ({ getCatalogOverview: catalog } = await import('../../src/admin/painel/queries-catalogo.js'));
  compatibility = await import('../../src/admin/painel/queries-catalogo-compatibilidade.js');
}, 180_000);
afterAll(async () => { if (db) await stopPostgres(db); });

async function product(vehicleType?: 'car' | 'motorcycle', measure = '195/65-15', brand = `Marca-${randomUUID()}`) {
  return create({ measure, brand, tireCondition: 'meia_vida', vehicleType,
    productCode: `VT-${randomUUID()}`, productName: 'Pneu teste', actorLabel: 'owner:test',
    environment: 'test', loadIndex: '91', speedRating: 'h' }, db.pool);
}
async function vehicle(type: 'car' | 'motorcycle', environment = 'test') {
  return (await db.pool.query(`INSERT INTO commerce.vehicle_models(environment,vehicle_type,make,model)
    VALUES ($1,$2,'Marca teste',$3) RETURNING id`, [environment, type, randomUUID()])).rows[0]!.id as string;
}
async function spec(id: string) {
  return (await db.pool.query('SELECT * FROM commerce.tire_specs WHERE product_id=$1', [id])).rows[0]!;
}
async function fitment(productId: string, vehicleId: string, environment = 'test') {
  const tire = await spec(productId);
  return db.pool.query(`INSERT INTO commerce.vehicle_fitments
    (environment,vehicle_model_id,tire_spec_id,position,is_oem,source,confidence_level)
    VALUES ($1,$2,$3,'rear',true,'manual',1)`, [environment, vehicleId, tire.id]);
}

describe('categoria do pneu — migração e contratos reais', () => {
  it('mantém os cadastros existentes desconhecidos; R, aro e condição não classificam', async () => {
    const unknown = await product(undefined, '130/70R13');
    const car = await product('car', '130/70-13');
    expect(unknown.vehicle_type).toBeNull();
    expect(car.vehicle_type).toBe('car');
    expect((await spec(unknown.product_id)).vehicle_type).toBeNull();
    expect((await spec(car.product_id)).vehicle_type).toBe('car');
    const seeded = await db.pool.query('SELECT vehicle_type FROM commerce.catalog_measure_registrations WHERE environment=$1', ['prod']);
    expect(seeded.rows.length).toBeGreaterThan(0);
    expect(seeded.rows.every(r => r.vehicle_type === null)).toBe(true);
    await expect(db.pool.query('UPDATE commerce.tire_specs SET vehicle_type=$1 WHERE product_id=$2',
      ['truck', car.product_id])).rejects.toMatchObject({ code: '23514' });
  });

  it('classifica com auditoria sem mudar reservas, saldo, custo ou dinheiro; edição antiga preserva categoria', async () => {
    const p = await product(undefined, '185/65-15', 'Teste classificação');
    await db.pool.query(`INSERT INTO commerce.wholesale_stock
      (environment,measure,brand,tire_condition,quantity_on_hand,quantity_reserved,unit_cost)
      VALUES ('test','185/65-15',$1,'meia_vida',20,3,48.5)`, [p.brand]);
    const before = await db.pool.query('SELECT * FROM commerce.wholesale_stock WHERE environment=$1', ['test']);
    const money = await db.pool.query('SELECT count(*)::int n FROM finance.matriz_ledger_transactions');
    const result = await edit({ productId: p.product_id, vehicleType: 'car', reason: 'Conferido na ficha',
      actorLabel: 'owner:test', environment: 'test' }, db.pool);
    expect(result.spec).toMatchObject({ vehicle_type: 'car', load_index: '91', speed_rating: 'H' });
    await edit({ productId: p.product_id, treadPattern: 'Touring', reason: 'Formulário antigo',
      actorLabel: 'owner:test', environment: 'test' }, db.pool);
    expect((await spec(p.product_id)).vehicle_type).toBe('car');
    expect((await db.pool.query('SELECT * FROM commerce.wholesale_stock WHERE environment=$1', ['test'])).rows).toEqual(before.rows);
    expect((await db.pool.query('SELECT count(*)::int n FROM finance.matriz_ledger_transactions')).rows).toEqual(money.rows);
    const audit = await db.pool.query(`SELECT actor_label,payload_before,payload_after FROM audit.events
      WHERE entity_id=$1 AND event_type='catalog_tire_spec_changed' ORDER BY created_at`, [result.spec.id]);
    expect(audit.rows[0]).toMatchObject({ actor_label: 'owner:test', payload_before: { vehicle_type: null },
      payload_after: { vehicle_type: 'car', reason: 'Conferido na ficha' } });
    const report = await inventory('test', db.pool);
    expect(report.rows.find(r => r.product_id === p.product_id)).toMatchObject({ vehicle_type: 'car', quantity_reserved: '3' });
    expect(report.stock_totals).toMatchObject({ quantity_on_hand: '20', quantity_reserved: '3' });
    expect(Number(report.stock_totals.known_stock_cost)).toBe(970);
  });

  it('não libera dois SKUs carro/moto na mesma chave operacional antiga', async () => {
    const brand = `Exclusiva-${randomUUID()}`;
    await product('motorcycle', '140/70-17', brand);
    await expect(product('car', '140/70R17', brand)).rejects.toThrow('catalog_variant_already_exists');
  });

  it('recusa compatibilidade entre categorias e ambientes inclusive por SQL direto', async () => {
    const p = await product('car');
    const motorcycle = await vehicle('motorcycle');
    const car = await vehicle('car');
    await expect(fitment(p.product_id, motorcycle)).rejects.toThrow('catalog_compatibility_vehicle_type_mismatch');
    await fitment(p.product_id, car);
    await expect(fitment(p.product_id, await vehicle('car', 'prod'))).rejects.toThrow(/env_match|catalog_fitment_environment_mismatch/);
    await expect(edit({ productId: p.product_id, vehicleType: 'motorcycle', reason: 'Troca indevida',
      actorLabel: 'owner:test', environment: 'test' }, db.pool)).rejects.toThrow('catalog_spec_vehicle_type_conflicts_with_fitments');
    await expect(db.pool.query('UPDATE commerce.vehicle_models SET vehicle_type=$1 WHERE id=$2',
      ['motorcycle', car])).rejects.toThrow('catalog_vehicle_type_conflicts_with_fitments');
    expect((await spec(p.product_id)).vehicle_type).toBe('car');
  });

  it('conserva fitments legados de moto e exige classificação para homologar carro', async () => {
    const p = await product();
    await fitment(p.product_id, await vehicle('motorcycle'));
    await expect(fitment(p.product_id, await vehicle('car'))).rejects.toThrow('catalog_compatibility_vehicle_type_mismatch');
    await expect(edit({ productId: p.product_id, vehicleType: 'car', reason: 'Revisão',
      actorLabel: 'owner:test', environment: 'test' }, db.pool)).rejects.toThrow('catalog_spec_vehicle_type_conflicts_with_fitments');
  });

  it('não copia aplicações de moto para carro nem homologa outro SKU de carro pela medida', async () => {
    const m = await product('motorcycle', '150/70-17');
    await fitment(m.product_id, await vehicle('motorcycle'));
    const first = await product('car', '150/70-17');
    const second = await product('car', '150/70-17');
    const car = await vehicle('car');
    const result = await compatibility.addCatalogCompatibility({ productId: first.product_id, vehicleModelId: car,
      position: 'rear', isOem: true, source: 'manual', confidenceLevel: 1, reason: 'Homologação específica',
      actorLabel: 'owner:test', environment: 'test' }, db.pool);
    expect(result.fitments_created).toBe(1);
    const third = await product('car', '150/70-17');
    const rows = await db.pool.query(`SELECT ts.product_id FROM commerce.vehicle_fitments vf JOIN commerce.tire_specs ts
      ON ts.id=vf.tire_spec_id AND ts.environment=vf.environment WHERE ts.product_id=ANY($1::uuid[])`,
    [[first.product_id, second.product_id, third.product_id]]);
    expect(rows.rows).toEqual([{ product_id: first.product_id }]);
  });

  it('filtra catálogo e contadores pela mesma categoria; all preserva o conjunto completo', async () => {
    const all = await catalog('test', db.pool);
    const cars = await catalog('test', db.pool, 'car');
    const motos = await catalog('test', db.pool, 'motorcycle');
    const unknown = await catalog('test', db.pool, 'unknown');
    expect(cars.rows.length).toBeGreaterThan(0);
    expect(cars.rows.every((r: any) => r.vehicle_type === 'car')).toBe(true);
    expect(cars.summary.products).toBe(cars.rows.length);
    expect(cars.rows.length + motos.rows.length + unknown.rows.length).toBe(all.rows.length);
    const inv = await inventory('prod', db.pool);
    expect(inv.rows.some(r => cars.rows.some((c: any) => c.product_id === r.product_id))).toBe(false);
  });

  it('não concede novas permissões de escrita para parceiros', async () => {
    const functions = await db.pool.query(`SELECT has_function_privilege('farejador_partner_app',p.oid,'EXECUTE') allowed
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='commerce'
        AND p.proname IN ('guard_fitment_vehicle_type','guard_tire_vehicle_reclassification','guard_vehicle_model_reclassification')`);
    expect(functions.rows).toHaveLength(3);
    expect(functions.rows.every(r => r.allowed === false)).toBe(true);
  });
});
