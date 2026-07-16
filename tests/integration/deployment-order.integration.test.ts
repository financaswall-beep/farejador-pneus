import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import {
  applyMigrationFile,
  buildRestrictedConnectionString,
  startPostgres,
  stopPostgres,
  type IntegrationDb,
} from './helpers/postgres.js';
import { createPartnerFixture } from './helpers/partner-fixtures.js';

describe('deploy seguro: hotfix RLS antes da Folha', () => {
  let db: IntegrationDb;

  beforeAll(async () => {
    db = await startPostgres({ throughMigration: '0132_matriz_admin_login.sql' });
  }, 180_000);

  afterAll(async () => { if (db) await stopPostgres(db); });

  it('aplica 0134 sem depender da 0133 e fecha a view para outra loja', async () => {
    const before = await db.pool.query(
      `SELECT to_regclass('network.matriz_collaborator_compensation') AS payroll_table`,
    );
    expect(before.rows[0].payroll_table).toBeNull();

    await applyMigrationFile(db.pool, '0134_audit_security_hotfix.sql');

    const a = await createPartnerFixture(db.pool, { slugSuffix: 'deploy-a' });
    const b = await createPartnerFixture(db.pool, { slugSuffix: 'deploy-b' });
    await db.pool.query(
      `INSERT INTO commerce.partner_orders
         (environment,unit_id,customer_name,total_amount,status,idempotency_key)
       VALUES ('test',$1,'Cliente protegido',100,'confirmed','deploy-hotfix-rls')`,
      [b.unitId],
    );

    const restricted = new Pool({ connectionString: buildRestrictedConnectionString(db.connectionString) });
    const client = await restricted.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.partner_unit_id',$1,true)", [a.partnerUnitId]);
      const visible = await client.query(
        `SELECT count(*)::int AS count FROM commerce.partner_orders_full WHERE unit_id=$1`,
        [b.unitId],
      );
      expect(visible.rows[0].count).toBe(0);
      await client.query('ROLLBACK');
    } finally {
      client.release();
      await restricted.end();
    }
  });

  it('depois aceita 0133 + 0135 antes do codigo da tela', async () => {
    await applyMigrationFile(db.pool, '0133_matriz_collaborator_management.sql');
    await applyMigrationFile(db.pool, '0135_payroll_history_and_integrity.sql');
    const ready = await db.pool.query(
      `SELECT to_regclass('finance.matriz_payroll_items') IS NOT NULL AS items,
              EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_schema='network'
                         AND table_name='matriz_collaborator_compensation'
                         AND column_name='id') AS history`,
    );
    expect(ready.rows[0]).toEqual({ items: true, history: true });
  });
});
