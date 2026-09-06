#!/usr/bin/env node
'use strict';

const { Client } = require('pg');
const { mkdirSync, writeFileSync, readFileSync } = require('node:fs');
const { resolve, join } = require('node:path');
const { createHash } = require('node:crypto');
const { BATCH, planResearchImport, loadCatalog, insertPendingResearch, stableId }
  = require('./catalog-fitment-research.cjs');

function assertTarget(args, connectionString) {
  if (!args.includes('--prod')) throw new Error('explicit_prod_flag_required');
  if (!connectionString) throw new Error('database_url_required');
  const target = new URL(connectionString);
  if (decodeURIComponent(target.username) !== 'postgres.beisgivepyfhgcujsqan'
    || target.hostname !== 'aws-0-sa-east-1.pooler.supabase.com') {
    throw new Error('unexpected_production_database');
  }
  const valid = new Set(['--prod', '--commit']);
  if (args.some(arg => !valid.has(arg))) throw new Error('unsupported_argument');
}

async function main() {
  const args = process.argv.slice(2);
  assertTarget(args, process.env.DATABASE_URL);
  const commit = args.includes('--commit');
  const { applications, bikes } = await import('./data/catalog-fitment-research-20260906.mjs');
  const client = new Client({ connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
  await client.connect();
  const reportDir = resolve(__dirname, '..', '.codex-tmp', 'backups');
  mkdirSync(reportDir, { recursive: true });
  let transaction = false;
  try {
    await client.query('BEGIN');
    transaction = true;
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query("SET LOCAL statement_timeout='20s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout='60s'");
    const products = await loadCatalog(client, 'prod');
    const plan = planResearchImport(applications, products);
    const ids = plan.candidates.map(c => stableId(`prod:${BATCH}:discovery:${c.source_key}`));
    const previous = await client.query(`SELECT id,status FROM commerce.fitment_discoveries
      WHERE environment='prod' AND id=ANY($1::uuid[])`, [ids]);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const beforePath = join(reportDir, `${BATCH}-${stamp}-before.json`);
    const before = JSON.stringify({ environment: 'prod', batch: BATCH, products,
      existing_imports: previous.rows, planned_discovery_ids: ids }, null, 2);
    writeFileSync(beforePath, before, { flag: 'wx' });
    const hash = createHash('sha256').update(before).digest('hex');
    if (createHash('sha256').update(readFileSync(beforePath)).digest('hex') !== hash) {
      throw new Error('snapshot_verification_failed');
    }
    const result = await insertPendingResearch(client, 'prod', plan);
    const verification = await client.query(`SELECT status,count(*)::int total
      FROM commerce.fitment_discoveries WHERE environment='prod' AND id=ANY($1::uuid[])
      GROUP BY status`, [ids]);
    if (verification.rows.reduce((sum, r) => sum + r.total, 0) !== ids.length) {
      throw new Error('import_count_mismatch');
    }
    const report = { batch: BATCH, environment: 'prod', mode: commit ? 'commit' : 'dry-run',
      products: products.length, research_configurations: bikes.length,
      researched_applications: plan.total, candidates: plan.candidates.length,
      source_review_applications: plan.skipped.filter(r => r.reason !== 'sem_produto_cadastrado_na_medida').length,
      no_catalog_product: plan.skipped.filter(r => r.reason === 'sem_produto_cadastrado_na_medida').length,
      blocked_configurations: bikes.filter(b => b.status.startsWith('BLOQUEADO')),
      homologated: 0, result, verification: verification.rows,
      before_path: beforePath, before_sha256: hash, skipped: plan.skipped };
    const reportPath = join(reportDir, `${BATCH}-${stamp}-report.json`);
    // Grava diário antes de COMMIT: mesmo falha de rede posterior permite reconciliar IDs.
    writeFileSync(reportPath, JSON.stringify({ ...report, transaction_state: 'prepared' }, null, 2), { flag: 'wx' });
    await client.query(commit ? 'COMMIT' : 'ROLLBACK');
    transaction = false;
    writeFileSync(reportPath, JSON.stringify({ ...report, transaction_state: commit ? 'committed' : 'rolled_back' }, null, 2));
    console.log(JSON.stringify({ ...report, result: {
      discoveries_created: result.discoveries_created.length,
      vehicles_created: result.vehicles_created.length, already_imported: result.already_imported.length,
    }, blocked_configurations: report.blocked_configurations.map(b => `${b.brand} ${b.model}: ${b.ref}`),
    skipped: undefined, report_path: reportPath }, null, 2));
  } catch (error) {
    if (transaction) await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { await client.end(); }
}

module.exports = { assertTarget };
if (require.main === module) main().catch(error => {
  // Mensagens do PG podem conter conteúdo de linhas: não imprimir payloads/segredos.
  console.error(`catalog_research_import_failed:${error.code || error.name || 'unknown'}`);
  process.exitCode = 1;
});
