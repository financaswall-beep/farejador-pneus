import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';

let db: IntegrationDb;

beforeAll(async () => { db = await startPostgres(); });
afterAll(async () => { if (db) await stopPostgres(db); });

describe('datas factuais do sistema inteiro', () => {
  it('instala as 11 barreiras da migration 0186', async () => {
    const result = await db.pool.query<{ count: string }>(`
      SELECT count(*)::text
        FROM pg_trigger
       WHERE tgname LIKE '%business_time_guard'
          OR tgname LIKE '%business_dates_guard'
          OR tgname LIKE '%business_timestamps_guard'
    `);
    expect(Number(result.rows[0].count)).toBe(11);
  });

  it('permite vencimento futuro e bloqueia ocorrência futura', async () => {
    await expect(db.pool.query(`
      INSERT INTO commerce.matriz_expenses
        (environment,category,amount,payment_status,due_date,occurred_at,
         document_date,competence_month)
      VALUES ('test','outros',100,'pending',
        (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date + 30,
        clock_timestamp(),
        (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date,
        date_trunc('month',clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date)
    `)).resolves.toMatchObject({ rowCount: 1 });

    await expect(db.pool.query(`
      INSERT INTO commerce.matriz_expenses
        (environment,category,amount,payment_status,occurred_at)
      VALUES ('test','outros',100,'paid',clock_timestamp() + interval '1 day')
    `)).rejects.toMatchObject({ code: '23514', message: 'occurred_at_future' });
  });

  it('bloqueia documento futuro sem bloquear a conta futura', async () => {
    await expect(db.pool.query(`
      INSERT INTO commerce.matriz_expenses
        (environment,category,amount,payment_status,due_date,document_date)
      VALUES ('test','outros',100,'pending',
        (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date + 60,
        (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date + 1)
    `)).rejects.toMatchObject({ code: '23514', message: 'document_date_future' });
  });
});
