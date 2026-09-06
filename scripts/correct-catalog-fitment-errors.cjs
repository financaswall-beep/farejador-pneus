#!/usr/bin/env node
'use strict';
const { Client } = require('pg');
const { createHash } = require('node:crypto');
const { mkdirSync, writeFileSync, readFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { assertTarget } = require('./import-catalog-fitment-research.cjs');

const BATCH = 'catalog-fitment-corrections-20260906-v1';
const rules = [
  { make: 'Suzuki', model: 'Burgman 125i', measure: '90/90-10', position: 'rear',
    reason: 'O manual registra 90/90-10 na dianteira e 100/90-10 na traseira. Remover vínculo traseiro sem homologar outro SKU.',
    source: 'https://assets.suzukimotos.com.br/storage/manual-proprietario/MANUAL-DO-PROPRIETARIO-SUZUKI-BurgmanI.pdf' },
  { make: 'Haojue', model: 'Lindy 125', measure: '90/90-10', position: 'rear',
    reason: 'O manual registra 90/90-10 na dianteira e 100/90-10 na traseira. Remover vínculo traseiro sem homologar outro SKU.',
    source: 'https://haojuemotos.com.br/storage/manual-proprietario/MANUAL-DO-PROPRIETARIO-HAOJUE-LINDYQ.pdf' },
  { make: 'Honda', model: 'CB 300F Twister', measure: '140/70-17', position: 'both',
    reason: 'Associação genérica a ambos os eixos não comprovada. A Honda informa traseiro 150/60R17, diferente do 140/70R17 da CB 250F; não reaproveitar vínculo da geração anterior.',
    source: 'https://saladeimprensa.honda.com.br/releases/honda-cb-300f-twister-2023-novo-design-motor-atualizado-e-mesma-confiabilidade' },
];

function correctionRule(row) {
  return rules.find(r => r.make === row.make && r.model === row.model
    && r.measure === row.tire_size && r.position === row.fitment.position);
}

async function correctionTargets(client, environment) {
  const result = await client.query(`SELECT row_to_json(vf) fitment,vm.make,vm.model,
    vm.variant,vm.year_start,vm.year_end,ts.tire_size,p.product_code
    FROM commerce.vehicle_fitments vf
    JOIN commerce.vehicle_models vm ON vm.id=vf.vehicle_model_id AND vm.environment=vf.environment
    JOIN commerce.tire_specs ts ON ts.id=vf.tire_spec_id AND ts.environment=vf.environment
    JOIN commerce.products p ON p.id=ts.product_id AND p.environment=ts.environment
    WHERE vf.environment=$1 ORDER BY vf.id FOR UPDATE OF vf`, [environment]);
  return result.rows.filter(correctionRule);
}

async function removeIncorrectFitments(client, environment, targets) {
  if (!['prod', 'test'].includes(environment)) throw new Error('invalid_environment');
  for (const row of targets) {
    const rule = correctionRule(row);
    if (!rule || row.fitment.environment !== environment) throw new Error('invalid_correction_target');
    await client.query(`INSERT INTO audit.events
      (environment,domain,entity_table,entity_id,event_type,actor_label,payload_before,payload_after)
      VALUES ($1,'catalog','commerce.vehicle_fitments',$2,'catalog_incorrect_fitment_removed',
        'Correção de compatibilidades autorizada pelo proprietário',$3::jsonb,$4::jsonb)`,
    [environment, row.fitment.id, JSON.stringify(row),
      JSON.stringify({ batch: BATCH, reason: rule.reason, source_url: rule.source,
        replacement_product_approved: false })]);
    const deleted = await client.query(`DELETE FROM commerce.vehicle_fitments
      WHERE environment=$1 AND id=$2 RETURNING id`, [environment, row.fitment.id]);
    if (deleted.rowCount !== 1) throw new Error('correction_count_mismatch');
  }
  return targets.length;
}

async function main() {
  const args = process.argv.slice(2);
  assertTarget(args, process.env.DATABASE_URL);
  const commit = args.includes('--commit');
  const client = new Client({ connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query("SET LOCAL statement_timeout='20s'");
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [BATCH]);
    const targets = await correctionTargets(client, 'prod');
    if (!targets.length) {
      await client.query('ROLLBACK');
      console.log(JSON.stringify({ batch: BATCH, removed: 0, message: 'Nenhum vínculo-alvo presente.' }));
      return;
    }
    if (targets.length !== 10) throw new Error('unexpected_target_count');
    const backupDir = resolve(__dirname, '..', '.codex-tmp', 'backups');
    mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = join(backupDir, `${BATCH}-${stamp}.json`);
    const backup = JSON.stringify({ environment: 'prod', batch: BATCH, targets, rules }, null, 2);
    writeFileSync(backupPath, backup, { flag: 'wx' });
    const hash = createHash('sha256').update(backup).digest('hex');
    if (createHash('sha256').update(readFileSync(backupPath)).digest('hex') !== hash) throw new Error('backup_mismatch');
    const removed = await removeIncorrectFitments(client, 'prod', targets);
    if ((await correctionTargets(client, 'prod')).length) throw new Error('targets_remain');
    await client.query(commit ? 'COMMIT' : 'ROLLBACK');
    console.log(JSON.stringify({ batch: BATCH, mode: commit ? 'commit' : 'dry-run', removed,
      backup_path: backupPath, backup_sha256: hash, products_changed: false, stock_changed: false }, null, 2));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { await client.end(); }
}

module.exports = { correctionRule, correctionTargets, removeIncorrectFitments };
if (require.main === module) main().catch(error => {
  console.error(`catalog_fitment_correction_failed:${error.code || error.name}`);
  process.exitCode = 1;
});
