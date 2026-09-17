import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client, type PoolClient } from 'pg';
import { repairVehicleApplicationTypes } from './vehicle-application-type-repair.js';

async function main() {
  const args = process.argv.slice(2);
  if (args.some(a => !/^--(?:measure=.+|port=\d+|commit)$/.test(a))) throw new Error('invalid_argument');
  const measure = args.find(a => a.startsWith('--measure='))?.slice(10);
  const environment = process.env.FAREJADOR_ENV;
  if (!measure || !['prod', 'test'].includes(environment ?? '')) throw new Error('explicit_environment_and_measure_required');
  const commit = args.includes('--commit');
  if (commit && environment === 'prod' && process.env.ALLOW_PROD_CATALOG_REPAIR !== 'vehicle-application-type') {
    throw new Error('explicit_catalog_repair_authorization_required');
  }
  const url = new URL(process.env.DATABASE_URL ?? '');
  const port = args.find(a => a.startsWith('--port='))?.slice(7);
  if (port) url.port = port;
  const db = new Client({ connectionString: url.href, ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000, application_name: 'catalog_application_type_repair' });
  try {
    await db.connect(); await db.query(commit ? 'BEGIN' : 'BEGIN READ ONLY');
    await db.query("SET LOCAL lock_timeout='5s'"); await db.query("SET LOCAL statement_timeout='10s'");
    const result = await repairVehicleApplicationTypes(db as unknown as PoolClient, environment as 'prod' | 'test', measure, commit);
    const dir = resolve('artifacts/catalog-application-repair'); mkdirSync(dir, { recursive: true });
    const report = resolve(dir, `${Date.now()}-${commit ? 'commit' : 'dry-run'}.json`);
    writeFileSync(report, JSON.stringify({ ...result, state: 'prepared' }, null, 2), { flag: 'wx' });
    await db.query(commit ? 'COMMIT' : 'ROLLBACK');
    writeFileSync(report, JSON.stringify({ ...result, state: commit ? 'committed' : 'read-only' }, null, 2));
    console.log(JSON.stringify({ ...result, report }));
  } catch (error) { await db.query('ROLLBACK').catch(() => {}); throw error; }
  finally { await db.end(); }
}
main().catch(error => { console.error(JSON.stringify({ error: error.code ?? error.message })); process.exitCode = 1; });
