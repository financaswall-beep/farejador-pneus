import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  startPostgres, stopPostgres, type IntegrationDb,
} from './helpers/postgres.js';

describe('continuidade do schema em PostgreSQL limpo', () => {
  let db: IntegrationDb;

  beforeAll(async () => { db = await startPostgres(); }, 120_000);
  afterAll(async () => { await stopPostgres(db); }, 30_000);

  it('materializa o marcador e valida as constraints', async () => {
    const state = await db.pool.query(
      'SELECT version,migration_name FROM ops.application_schema_state WHERE singleton=true',
    );
    expect(state.rows[0]).toEqual({
      version: 215,
      migration_name: '0215_partial_payment_reconciliation_health.sql',
    });

    const ledger = await db.pool.query(`
      SELECT count(*)::int row_count,
             count(DISTINCT migration_file)::int file_count,
             max(migration_order)::int latest_order
        FROM ops.applied_migrations
    `);
    expect(ledger.rows[0]).toEqual({
      row_count: 216,
      file_count: 216,
      latest_order: 215,
    });

    const constraints = await db.pool.query<{ conname: string; convalidated: boolean }>(`
      SELECT conname,convalidated FROM pg_constraint
       WHERE conname IN (
         'order_items_discount_within_line_check',
         'wholesale_orders_payment_dates_check',
         'commission_entries_partner_order_fk'
       ) ORDER BY conname
    `);
    expect(constraints.rows).toHaveLength(3);
    expect(constraints.rows.every((item) => item.convalidated)).toBe(true);
  });

  it('expõe retenção segura mesmo sem pg_cron real no banco descartável', async () => {
    const result = await db.pool.query<{ result: Record<string, number> }>(
      'SELECT ops.perform_operational_retention() result',
    );
    expect(result.rows[0]?.result).toMatchObject({
      partner_sessions: 0,
      matriz_staff_sessions: 0,
      cron_job_runs: 0,
      meta_sync_runs: 0,
      resolved_dead_letters: 0,
    });
  });

  it('mantém partições do mês atual e dos próximos dois meses', async () => {
    const result = await db.pool.query<{ missing: string }>(`
      WITH months AS (
        SELECT to_char(date_trunc('month',now())+(n||' months')::interval,'YYYY_MM') suffix
          FROM generate_series(0,2) n
      )
      SELECT count(*)::text missing FROM months
       WHERE to_regclass('raw.raw_events_'||suffix) IS NULL
          OR to_regclass('core.messages_'||suffix) IS NULL
    `);
    expect(result.rows[0]?.missing).toBe('0');
  });
});
