import { afterAll, beforeAll, expect, it } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';

let db: IntegrationDb;
let check: typeof import('../../src/operation/daily-ledger-health.js').checkDailyLedgerHealth;
beforeAll(async () => {
  db = await startPostgres();
  Object.assign(process.env, { NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: db.connectionString,
    CHATWOOT_HMAC_SECRET: 'test', ADMIN_AUTH_TOKEN: 'test', MATRIZ_CENTRAL_LEDGER: 'true' });
  check = (await import('../../src/operation/daily-ledger-health.js')).checkDailyLedgerHealth;
}, 240_000);
afterAll(async () => { if (db) await stopPostgres(db); });

it('usa o reconciliador real, uma vez por dia e ambiente, sem reparar dinheiro', async () => {
  const before = await db.pool.query('SELECT count(*) FROM finance.matriz_ledger_transactions');
  const today = new Date('2026-10-02T12:00:00Z');
  expect(await check('test', db.pool, today)).toBe(true);
  expect(await check('test', db.pool, today)).toBe(false);
  expect((await db.pool.query('SELECT count(*) FROM finance.matriz_ledger_transactions')).rows).toEqual(before.rows);
  const row = (await db.pool.query('SELECT environment,status FROM ops.matriz_ledger_health_checks')).rows;
  expect(row).toHaveLength(1);
  expect(row[0].environment).toBe('test');
  expect(['red','yellow','green']).toContain(row[0].status);
});

it('avisa quando a leitura falha e tenta novamente depois de uma hora', async () => {
  const broken = async () => { throw new Error('unavailable'); };
  expect(await check('prod', db.pool, new Date('2026-10-02T12:00:00Z'), broken)).toBe(true);
  expect((await db.pool.query("SELECT status FROM ops.matriz_ledger_health_checks WHERE environment='prod'")).rows[0].status).toBe('error');
  expect(await check('prod', db.pool, new Date('2026-10-02T12:30:00Z'), broken)).toBe(false);
  expect(await check('prod', db.pool, new Date('2026-10-02T13:01:00Z'))).toBe(true);
  expect((await db.pool.query("SELECT status FROM ops.matriz_ledger_health_checks WHERE environment='prod'")).rows[0].status).not.toBe('error');
});

it('duas réplicas não executam a conferência ao mesmo tempo', async () => {
  let calls = 0;
  const { getMatrizLedgerIntegrationHealth } = await import('../../src/admin/painel/matriz-ledger-integration-health.js');
  const reader: typeof getMatrizLedgerIntegrationHealth = async (...args) => {
    calls++;
    await new Promise(resolve => setTimeout(resolve, 80));
    return getMatrizLedgerIntegrationHealth(...args);
  };
  const results = await Promise.all([check('test', db.pool, new Date('2026-10-03T12:00:00Z'), reader),
    check('test', db.pool, new Date('2026-10-03T12:00:00Z'), reader)]);
  expect(results.filter(Boolean)).toHaveLength(1);
  expect(calls).toBe(1);
});
