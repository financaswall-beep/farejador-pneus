#!/usr/bin/env node
'use strict';

const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const { auditMigrationManifest } = require('./check-migrations.cjs');

const root = path.resolve(__dirname, '..');
const migrationFile = '0197_catalog_integrity.sql';
const commit = process.argv.includes('--commit');

function assertGuards() {
  if (process.env.ALLOW_PROD_CATALOG_MIGRATION !== '0197') {
    throw new Error('explicit_authorization_required');
  }
  if (process.env.FAREJADOR_ENV !== 'prod') throw new Error('prod_environment_required');
  if (!process.env.DATABASE_URL) throw new Error('database_url_required');
  if (!process.env.PROD_BACKUP_FILE || !process.env.PROD_BACKUP_SHA256) {
    throw new Error('verified_backup_required');
  }
  const actual = createHash('sha256')
    .update(readFileSync(process.env.PROD_BACKUP_FILE)).digest('hex');
  if (actual.toLowerCase() !== process.env.PROD_BACKUP_SHA256.toLowerCase()) {
    throw new Error('backup_hash_mismatch');
  }
  const manifest = auditMigrationManifest(root);
  if (!manifest.ok) throw new Error(`migration_manifest_invalid:${manifest.errors.join('|')}`);
}

async function installationState(client) {
  const { rows } = await client.query(`SELECT jsonb_build_object(
    'positive_constraints',(SELECT count(*)::int FROM pg_constraint
      WHERE conname IN (
        'matriz_product_prices_price_amount_check',
        'product_prices_price_amount_check',
        'partner_stock_levels_sale_price_check'
      ) AND convalidated),
    'open_price_indexes',(SELECT count(*)::int FROM pg_indexes
      WHERE schemaname='commerce' AND indexname IN (
        'matriz_product_prices_one_open_idx','product_prices_one_open_type_idx'
      )),
    'guard_functions',(SELECT count(*)::int
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='commerce' AND p.proname IN (
       'guard_catalog_tire_variant','guard_catalog_price_window',
       'guard_catalog_price_history'
     ) AND p.prosecdef
       AND p.proconfig @> ARRAY['search_path=pg_catalog, public']::text[]),
    'identity_functions',(SELECT count(*)::int
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='commerce' AND p.proname IN (
       'catalog_brand_identity','catalog_measure_identity'
     ) AND p.provolatile='i'),
    'guard_triggers',(SELECT count(*)::int FROM pg_trigger
      WHERE tgname IN (
        'catalog_tire_variant_from_spec','catalog_tire_variant_from_product',
        'matriz_product_price_window_guard','product_price_window_guard',
        'matriz_product_price_immutable_update','matriz_product_price_immutable_delete',
        'product_price_immutable_update','product_price_immutable_delete'
      ) AND NOT tgisinternal AND tgenabled<>'D'),
    'public_function_execute',(SELECT count(*)::int
      FROM information_schema.routine_privileges
     WHERE grantee='PUBLIC' AND specific_schema='commerce'
       AND routine_name IN (
         'catalog_brand_identity','catalog_measure_identity',
         'guard_catalog_tire_variant','guard_catalog_price_window',
         'guard_catalog_price_history'
       ) AND privilege_type='EXECUTE')
  ) state`);
  return rows[0].state;
}

function installationOk(state) {
  return Number(state.positive_constraints) === 3
    && Number(state.open_price_indexes) === 2
    && Number(state.guard_functions) === 3
    && Number(state.identity_functions) === 2
    && Number(state.guard_triggers) === 8
    && Number(state.public_function_execute) === 0;
}

function anyInstalled(state) {
  return Number(state.open_price_indexes) > 0
    || Number(state.guard_functions) > 0
    || Number(state.identity_functions) > 0
    || Number(state.guard_triggers) > 0;
}

async function reconciliation(client) {
  const { rows } = await client.query(`SELECT jsonb_build_object(
    'matriz_non_positive',(SELECT count(*) FROM commerce.matriz_product_prices
      WHERE price_amount<=0),
    'network_non_positive',(SELECT count(*) FROM commerce.product_prices
      WHERE price_amount<=0),
    'partner_non_positive',(SELECT count(*) FROM commerce.partner_stock_levels
      WHERE sale_price IS NOT NULL AND sale_price<=0),
    'matriz_multiple_open',(SELECT count(*) FROM (
      SELECT environment,product_id FROM commerce.matriz_product_prices
       WHERE valid_until IS NULL GROUP BY environment,product_id HAVING count(*)>1
    ) duplicate_rows),
    'network_multiple_open',(SELECT count(*) FROM (
      SELECT environment,product_id,price_type FROM commerce.product_prices
       WHERE valid_until IS NULL
       GROUP BY environment,product_id,price_type HAVING count(*)>1
    ) duplicate_rows),
    'prod_duplicate_variants',(SELECT count(*) FROM (
      SELECT commerce.catalog_measure_identity(ts.tire_size),
             commerce.catalog_brand_identity(p.brand),p.tire_condition
        FROM commerce.products p JOIN commerce.tire_specs ts
          ON ts.environment=p.environment AND ts.product_id=p.id
       WHERE p.environment='prod' AND p.deleted_at IS NULL AND p.product_type='tire'
       GROUP BY 1,2,3 HAVING count(*)>1
    ) duplicate_rows),
    'prod_matriz_overlaps',(SELECT count(*) FROM commerce.matriz_product_prices a
      JOIN commerce.matriz_product_prices b
        ON b.environment=a.environment AND b.product_id=a.product_id AND b.id>a.id
       AND tstzrange(a.valid_from,COALESCE(a.valid_until,'infinity'),'[)')
           && tstzrange(b.valid_from,COALESCE(b.valid_until,'infinity'),'[)')
     WHERE a.environment='prod'),
    'prod_network_overlaps',(SELECT count(*) FROM commerce.product_prices a
      JOIN commerce.product_prices b
        ON b.environment=a.environment AND b.product_id=a.product_id
       AND b.price_type=a.price_type AND b.id>a.id
       AND tstzrange(a.valid_from,COALESCE(a.valid_until,'infinity'),'[)')
           && tstzrange(b.valid_from,COALESCE(b.valid_until,'infinity'),'[)')
     WHERE a.environment='prod')
  ) state`);
  return rows[0].state;
}

const allZero = (state) => Object.values(state).every((value) => Number(value) === 0);

async function probeBehavior(client) {
  await client.query('SAVEPOINT catalog_probe');
  try {
    const product = await client.query(`INSERT INTO commerce.products
      (environment,product_code,product_name,product_type)
      VALUES ('prod','MIG-0197-'||gen_random_uuid()::text,'Serviço probe 0197','service')
      RETURNING id`);
    const productId = product.rows[0].id;
    const price = await client.query(`INSERT INTO commerce.matriz_product_prices
      (environment,product_id,price_amount) VALUES ('prod',$1,25) RETURNING id`, [productId]);

    await client.query('SAVEPOINT overlap_probe');
    let overlapBlocked = false;
    try {
      await client.query(`INSERT INTO commerce.matriz_product_prices
        (environment,product_id,price_amount) VALUES ('prod',$1,30)`, [productId]);
    } catch (error) {
      overlapBlocked = error && error.code === '23P01';
    }
    await client.query('ROLLBACK TO SAVEPOINT overlap_probe');
    if (!overlapBlocked) throw new Error('price_overlap_probe_not_blocked');

    await client.query('SAVEPOINT immutable_probe');
    let immutableBlocked = false;
    try {
      await client.query(`UPDATE commerce.matriz_product_prices
        SET price_amount=26 WHERE id=$1`, [price.rows[0].id]);
    } catch (error) {
      immutableBlocked = error && error.code === '55000';
    }
    await client.query('ROLLBACK TO SAVEPOINT immutable_probe');
    if (!immutableBlocked) throw new Error('price_history_probe_not_blocked');

    await client.query(`UPDATE commerce.matriz_product_prices
      SET valid_until=GREATEST(clock_timestamp(),valid_from+interval '1 microsecond')
      WHERE id=$1`, [price.rows[0].id]);
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT catalog_probe');
  }
}

async function main() {
  assertGuards();
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  let transactionFinished = false;
  try {
    const before = await installationState(client);
    if (anyInstalled(before)) {
      throw new Error(installationOk(before)
        ? 'migration_already_applied'
        : `partial_migration_state:${JSON.stringify(before)}`);
    }

    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout='10s'`);
    await client.query(`SET LOCAL statement_timeout='180s'`);
    await client.query(`SET LOCAL idle_in_transaction_session_timeout='240s'`);
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('farejador:migrations:0197'))`);
    await client.query(readFileSync(path.join(root, 'db', 'migrations', migrationFile), 'utf8'));

    const inside = await installationState(client);
    if (!installationOk(inside)) {
      throw new Error(`object_verification_failed:${JSON.stringify(inside)}`);
    }
    await probeBehavior(client);
    const insideReconciliation = await reconciliation(client);
    if (!allZero(insideReconciliation)) {
      throw new Error(`reconciliation_failed:${JSON.stringify(insideReconciliation)}`);
    }

    await client.query(commit ? 'COMMIT' : 'ROLLBACK');
    transactionFinished = true;

    const outside = await installationState(client);
    if (commit && !installationOk(outside)) throw new Error('post_commit_objects_missing');
    if (!commit && anyInstalled(outside)) throw new Error('dry_run_left_schema_changes');
    const outsideReconciliation = commit ? await reconciliation(client) : null;
    if (commit && !allZero(outsideReconciliation)) {
      throw new Error(`post_commit_reconciliation_failed:${JSON.stringify(outsideReconciliation)}`);
    }
    console.log(JSON.stringify({
      environment: 'prod', mode: commit ? 'commit' : 'dry-run', migration: migrationFile,
      objects: commit ? outside : inside,
      reconciliation: commit ? outsideReconciliation : insideReconciliation,
    }, null, 2));
  } catch (error) {
    if (!transactionFinished) await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`PROD_CATALOG_MIGRATION_FAILED:${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
