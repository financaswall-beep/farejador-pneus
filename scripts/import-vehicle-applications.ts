import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { Client, type PoolClient } from 'pg';
import { APPLICATION_BATCH, buildApplicationImport, importVehicleApplications } from './vehicle-application-import.js';

const require = createRequire(import.meta.url);
const { recordApplicationMigration } = require('./migration-ledger.cjs');
const { auditMigrationManifest } = require('./check-migrations.cjs');
const migration = '0225_vehicle_measure_applications.sql';
const root = resolve(import.meta.dirname, '..');

async function main() {
  const args = process.argv.slice(2);
  if (!args.includes('--prod') || args.some(a=>!['--prod','--commit'].includes(a))) throw new Error('explicit_prod_flag_required');
  const target = new URL(process.env.DATABASE_URL ?? '');
  if (target.hostname !== 'aws-0-sa-east-1.pooler.supabase.com'
    || decodeURIComponent(target.username) !== 'postgres.beisgivepyfhgcujsqan') throw new Error('unexpected_database');
  if (!auditMigrationManifest(root).ok) throw new Error('invalid_migration_manifest');
  const commit = args.includes('--commit');
  const client = new Client({connectionString:process.env.DATABASE_URL,
    ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15_000});
  await client.connect();
  const sql = readFileSync(resolve(root,'db/migrations',migration),'utf8');
  const checksum = createHash('sha256').update(sql).digest('hex');
  const dir = resolve(root,'.codex-tmp/backups');
  mkdirSync(dir,{recursive:true});
  const stamp = new Date().toISOString().replace(/[:.]/g,'-');
  const snapshotPath = resolve(dir,`${APPLICATION_BATCH}-${stamp}-before.json`);
  const reportPath = resolve(dir,`${APPLICATION_BATCH}-${stamp}-report.json`);
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query("SET LOCAL statement_timeout='20s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('vehicle_measure_application_import'))");
    const exists = (await client.query("SELECT to_regclass('commerce.vehicle_measure_applications') IS NOT NULL AS ready")).rows[0].ready;
    const previous = exists ? (await client.query("SELECT * FROM commerce.vehicle_measure_applications WHERE environment='prod'")).rows : [];
    const snapshot = JSON.stringify({batch:APPLICATION_BATCH,table_existed:exists,previous,
      planned_ids:buildApplicationImport().map(r=>r.application.application_id)},null,2);
    writeFileSync(snapshotPath,snapshot,{flag:'wx'});
    const snapshotHash = createHash('sha256').update(snapshot).digest('hex');
    if (createHash('sha256').update(readFileSync(snapshotPath)).digest('hex')!==snapshotHash) throw new Error('snapshot_mismatch');
    const applied = (await client.query('SELECT checksum_sha256 FROM ops.applied_migrations WHERE migration_file=$1',[migration])).rows[0];
    if (applied && applied.checksum_sha256!==checksum) throw new Error('migration_checksum_mismatch');
    if (!applied) {
      if (exists) throw new Error('untracked_application_table');
      await client.query(sql);
      await recordApplicationMigration(client,migration,sql,'catalog_application_import');
    }
    const result = await importVehicleApplications(client as unknown as PoolClient,'prod');
    const actual = (await client.query(`SELECT status,count(*)::int total FROM commerce.vehicle_measure_applications
      WHERE environment='prod' AND application_id=ANY($1::text[]) GROUP BY status`,
    [buildApplicationImport().map(r=>r.application.application_id)])).rows;
    if (actual.reduce((n,r)=>n+r.total,0)!==result.planned) throw new Error('import_count_mismatch');
    if (result.inserted) await client.query(`INSERT INTO audit.events
      (environment,domain,entity_table,entity_id,event_type,actor_label,payload_after)
      VALUES ('prod','catalog','commerce.vehicle_measure_applications',$1,'catalog_applications_imported',
        'Importação solicitada pelo proprietário',$2::jsonb)`,
    [randomUUID(),JSON.stringify({batch:APPLICATION_BATCH,...result,snapshot_sha256:snapshotHash})]);
    const report = {batch:APPLICATION_BATCH,mode:commit?'commit':'dry-run',...result,actual,
      snapshot_path:snapshotPath,snapshot_sha256:snapshotHash};
    writeFileSync(reportPath,JSON.stringify({...report,state:'prepared'},null,2),{flag:'wx'});
    await client.query(commit?'COMMIT':'ROLLBACK');
    writeFileSync(reportPath,JSON.stringify({...report,state:commit?'committed':'rolled_back'},null,2));
    console.log(JSON.stringify({...report,report_path:reportPath},null,2));
  } catch(error) {await client.query('ROLLBACK').catch(()=>{});throw error;}
  finally {await client.end();}
}
main().catch(error=>{
  console.error(`application_import_failed:${error.code ?? error.message ?? error.name}`);
  process.exitCode=1;
});
