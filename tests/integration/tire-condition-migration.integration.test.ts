import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyMigrationFile, startPostgres, stopPostgres, type IntegrationDb,
} from './helpers/postgres.js';
import { createPartnerFixture } from './helpers/partner-fixtures.js';

describe('0156 - migração segura das condições de pneu', () => {
  let db: IntegrationDb;
  let unitId: string;
  let usedId: string;
  let remoldId: string;
  let newId: string;
  let reviewId: string;
  let oldProductId: string;

  beforeAll(async () => {
    db = await startPostgres({ throughMigration: '0155_wholesale_stock_multi_brand.sql' });
    const fixture = await createPartnerFixture(db.pool, {
      slugSuffix: `condition-migration-${randomUUID().slice(0, 6)}`,
      initialStockQty: 5,
    });
    unitId = fixture.unitId;
    usedId = fixture.stockId;
    await db.pool.query(
      `UPDATE commerce.partner_stock_levels SET tire_condition='Usado' WHERE id=$1`,
      [usedId],
    );

    const product = await db.pool.query<{ id: string }>(
      `INSERT INTO commerce.products
         (environment,product_code,product_name,product_type,brand)
       VALUES ('test',$1,'Pneu legado recapado','tire','Pirelli')
       RETURNING id`,
      [`LEGACY-CONDITION-${randomUUID()}`],
    );
    oldProductId = product.rows[0]!.id;
    await db.pool.query(
      `INSERT INTO commerce.tire_specs(environment,product_id,tire_size)
       VALUES ('test',$1,'100/90-18')`,
      [oldProductId],
    );

    const rows = await db.pool.query<{ id: string; item_name: string }>(
      `INSERT INTO commerce.partner_stock_levels (
         environment,unit_id,product_id,item_name,tire_size,brand,tire_condition,
         quantity_on_hand,average_cost,sale_price,is_tracked,stock_status,updated_by
       ) VALUES
         ('test',$1,$2,'Pneu recapado legado','100/90-18','Pirelli','Recapado',
          4,70,145,true,'in_stock','fixture'),
         ('test',$1,NULL,'Pneu novo legado','110/90-18','Pirelli','Novo',
          3,120,220,true,'in_stock','fixture'),
         ('test',$1,NULL,'Pneu a revisar','120/90-18','Pirelli',NULL,
          2,90,160,true,'in_stock','fixture')
       RETURNING id,item_name`,
      [unitId, oldProductId],
    );
    remoldId = rows.rows.find((row) => row.item_name === 'Pneu recapado legado')!.id;
    newId = rows.rows.find((row) => row.item_name === 'Pneu novo legado')!.id;
    reviewId = rows.rows.find((row) => row.item_name === 'Pneu a revisar')!.id;

    await applyMigrationFile(db.pool, '0156_tire_condition_variants.sql');
  }, 180_000);

  afterAll(async () => { if (db) await stopPostgres(db); });

  it('mapeia somente valores conhecidos e mantém o não informado para revisão', async () => {
    const rows = await db.pool.query<{ id: string; tire_condition: string | null }>(
      `SELECT id,tire_condition FROM commerce.partner_stock_levels
        WHERE id=ANY($1::uuid[]) ORDER BY id`,
      [[usedId, remoldId, newId, reviewId]],
    );
    const byId = new Map(rows.rows.map((row) => [row.id, row.tire_condition]));
    expect(byId.get(usedId)).toBe('meia_vida');
    expect(byId.get(remoldId)).toBe('remold');
    expect(byId.get(newId)).toBe('novo');
    expect(byId.get(reviewId)).toBeNull();
  });

  it('desvincula produto legado com condição conflitante e deixa auditoria', async () => {
    const row = await db.pool.query<{ product_id: string | null }>(
      `SELECT product_id FROM commerce.partner_stock_levels WHERE id=$1`,
      [remoldId],
    );
    expect(row.rows[0]?.product_id).toBeNull();
    const audit = await db.pool.query<{ event_type: string }>(
      `SELECT event_type FROM audit.events
        WHERE entity_id=$1 AND event_type='partner_stock_catalog_condition_unlinked'`,
      [remoldId],
    );
    expect(audit.rows).toHaveLength(1);
  });

  it('bloqueia novo cadastro e nova venda enquanto a condição estiver pendente', async () => {
    await expect(db.pool.query(
      `INSERT INTO commerce.partner_stock_levels (
         environment,unit_id,item_name,tire_size,brand,tire_condition,
         quantity_on_hand,is_tracked,stock_status,updated_by
       ) VALUES ('test',$1,'Novo sem condição','130/90-18','Pirelli',NULL,
                 1,true,'in_stock','fixture')`,
      [unitId],
    )).rejects.toThrow(/tire_condition_required/);

    await expect(db.pool.query(
      `SELECT commerce.register_partner_local_order(
         'test',$1,'Cliente revisão',NULL,$2::jsonb,'pix','pickup',NULL,
         'fixture',$3,'porta'
       )`,
      [
        unitId,
        JSON.stringify([{ partner_stock_id: reviewId, quantity: 1, unit_price: 160 }]),
        `review-sale-${randomUUID()}`,
      ],
    )).rejects.toThrow(/partner_stock_condition_review_required/);
  });
});
