import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';

describe('Marketing multicanal — migration aditiva', () => {
  let db: IntegrationDb;

  beforeAll(async () => {
    db = await startPostgres({ throughMigration: '0161_marketing_multichannel_messaging.sql' });
  }, 180_000);

  afterAll(async () => { if (db) await stopPostgres(db); });

  it('preserva CTWA e adiciona inbox Meta e identidade por canal', async () => {
    const columns = await db.pool.query<{ table_schema: string; table_name: string; column_name: string }>(
      `SELECT table_schema,table_name,column_name
         FROM information_schema.columns
        WHERE (table_schema,table_name,column_name) IN (
          ('core','messages','native_message_id'),
          ('marketing','ad_referrals','channel'),
          ('marketing','ad_referrals','referral_key'),
          ('marketing','ad_referrals','user_scoped_id'),
          ('marketing','ad_referrals','business_account_id')
        )
        ORDER BY table_schema,table_name,column_name`,
    );
    expect(columns.rows).toHaveLength(5);
    const tables = await db.pool.query<{ name: string | null }>(
      `SELECT to_regclass('raw.meta_messaging_events')::text AS name
       UNION ALL
       SELECT to_regclass('marketing.meta_messaging_referrals')::text`,
    );
    expect(tables.rows.map((row) => row.name)).toEqual([
      'raw.meta_messaging_events',
      'marketing.meta_messaging_referrals',
    ]);
  });

  it('mantém o payload Meta bruto imutável e permite só o estado operacional', async () => {
    const inserted = await db.pool.query<{ id: number }>(
      `INSERT INTO raw.meta_messaging_events
         (environment,payload_sha256,signature,object_type,payload)
       VALUES ('test',$1,'sha256=assinatura','page','{"object":"page"}')
       RETURNING id`,
      ['a'.repeat(64)],
    );
    const id = inserted.rows[0]!.id;
    await expect(db.pool.query(
      `UPDATE raw.meta_messaging_events SET payload='{}' WHERE id=$1`,
      [id],
    )).rejects.toThrow(/imutavel/i);
    await expect(db.pool.query(
      `UPDATE raw.meta_messaging_events SET processing_status='processed',processed_at=now()
        WHERE id=$1`,
      [id],
    )).resolves.toMatchObject({ rowCount: 1 });
  });
});
