import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildRestrictedConnectionString,
  startPostgres,
  stopPostgres,
  type IntegrationDb,
} from './helpers/postgres.js';

describe('pipeline Marketing — migration e isolamento', () => {
  let db: IntegrationDb;

  beforeAll(async () => {
    db = await startPostgres({ throughMigration: '0144_marketing_attribution_pipeline.sql' });
  }, 180_000);

  afterAll(async () => { if (db) await stopPostgres(db); });

  it('cria coleta, ledger e outbox com índices de idempotência', async () => {
    const tables = await db.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema='marketing' ORDER BY table_name`,
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      'ad_referrals',
      'capi_outbox',
      'meta_insights_daily',
      'meta_sync_runs',
      'order_attributions',
    ]);

    const indexes = await db.pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname='marketing' AND indexname IN (
          'order_attributions_active_order_uniq',
          'order_attributions_active_referral_uniq',
          'capi_outbox_pickup_idx'
        ) ORDER BY indexname`,
    );
    expect(indexes.rows.map((row) => row.indexname)).toEqual([
      'capi_outbox_pickup_idx',
      'order_attributions_active_order_uniq',
      'order_attributions_active_referral_uniq',
    ]);
  });

  it('impede troca de ambiente e acesso da role parceira', async () => {
    const run = await db.pool.query<{ id: string }>(
      `INSERT INTO marketing.meta_sync_runs
         (environment,trigger_type,window_since,window_until)
       VALUES ('test','manual','2026-07-20','2026-07-26') RETURNING id`,
    );
    await expect(db.pool.query(
      `UPDATE marketing.meta_sync_runs SET environment='prod' WHERE id=$1`,
      [run.rows[0]?.id],
    )).rejects.toThrow(/environment/i);

    const restricted = new Pool({
      connectionString: buildRestrictedConnectionString(db.connectionString),
    });
    try {
      await expect(restricted.query('SELECT count(*) FROM marketing.meta_sync_runs'))
        .rejects.toThrow(/permission denied/i);
    } finally {
      await restricted.end();
    }
  });
});
