'use strict';

const { randomUUID } = require('node:crypto');
const { Client } = require('pg');

function option(name) {
  const prefix = `--${name}=`;
  const raw = process.argv.find((arg) => arg.startsWith(prefix));
  return raw ? raw.slice(prefix.length) : null;
}

const environment = option('environment');
const expectedArchiveRaw = option('expected-archive');
const commit = process.argv.includes('--commit');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL ausente.');
  process.exit(1);
}
if (!['prod', 'test'].includes(environment)) {
  console.error('Informe --environment=prod ou --environment=test.');
  process.exit(1);
}
if (commit && expectedArchiveRaw === null) {
  console.error('Para gravar, informe --expected-archive=N com a quantidade vista no dry-run.');
  process.exit(1);
}

const expectedArchive = expectedArchiveRaw === null ? null : Number(expectedArchiveRaw);
if (expectedArchive !== null && (!Number.isInteger(expectedArchive) || expectedArchive < 0)) {
  console.error('--expected-archive deve ser um inteiro não negativo.');
  process.exit(1);
}

const candidatesSql = `
  SELECT p.id,p.product_code,p.product_name,p.brand,p.tire_condition,ts.tire_size
    FROM commerce.products p
    LEFT JOIN commerce.tire_specs ts
      ON ts.product_id=p.id AND ts.environment=p.environment
   WHERE p.environment=$1
     AND p.deleted_at IS NULL
     AND p.product_type='tire'
     AND NOT EXISTS (
       SELECT 1
         FROM commerce.wholesale_stock ws
        WHERE ws.environment=p.environment
          AND ws.tire_condition=p.tire_condition
          AND CASE
                WHEN lower(btrim(COALESCE(ws.brand,'')))='sem marca' THEN ''
                ELSE lower(btrim(COALESCE(ws.brand,'')))
              END
              = CASE
                  WHEN lower(btrim(COALESCE(p.brand,'')))='sem marca' THEN ''
                  ELSE lower(btrim(COALESCE(p.brand,'')))
                END
          AND regexp_replace(ws.measure,'[^0-9]+','','g')
              =regexp_replace(COALESCE(ts.tire_size,''),'[^0-9]+','','g')
     )
     AND NOT EXISTS (
       SELECT 1
         FROM commerce.wholesale_purchase_items wpi
         JOIN commerce.wholesale_purchases wp
           ON wp.id=wpi.purchase_id AND wp.environment=wpi.environment
        WHERE wpi.environment=p.environment
          AND wp.status='confirmed'
          AND wpi.tire_condition=p.tire_condition
          AND CASE
                WHEN lower(btrim(COALESCE(wpi.brand,'')))='sem marca' THEN ''
                ELSE lower(btrim(COALESCE(wpi.brand,'')))
              END
              = CASE
                  WHEN lower(btrim(COALESCE(p.brand,'')))='sem marca' THEN ''
                  ELSE lower(btrim(COALESCE(p.brand,'')))
                END
          AND regexp_replace(wpi.measure,'[^0-9]+','','g')
              =regexp_replace(COALESCE(ts.tire_size,''),'[^0-9]+','','g')
     )
     AND NOT EXISTS (
       SELECT 1
         FROM commerce.partner_stock_levels psl
        WHERE psl.environment=p.environment
          AND psl.product_id=p.id
          AND psl.deleted_at IS NULL
          AND COALESCE(psl.item_type,'pneu')='pneu'
          AND psl.tire_condition IS NOT NULL
     )
   ORDER BY p.product_code
   FOR UPDATE OF p`;

async function main() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  await client.query('BEGIN');
  try {
    const candidates = await client.query(candidatesSql, [environment]);
    console.log(JSON.stringify({
      mode: commit ? 'commit' : 'dry-run',
      environment,
      archive_count: candidates.rowCount,
      products: candidates.rows.map((row) => ({
        product_code: row.product_code,
        product_name: row.product_name,
        tire_size: row.tire_size,
        brand: row.brand,
        tire_condition: row.tire_condition,
      })),
    }, null, 2));

    if (expectedArchive !== null && candidates.rowCount !== expectedArchive) {
      throw new Error(
        `quantidade mudou: esperado ${expectedArchive}, encontrado ${candidates.rowCount}`,
      );
    }

    if (commit && candidates.rowCount > 0) {
      const runId = randomUUID();
      const ids = candidates.rows.map((row) => row.id);
      await client.query(
        `INSERT INTO audit.events (
           environment,domain,entity_table,entity_id,event_type,actor_label,payload_after
         )
         SELECT p.environment,'catalog','commerce.products',p.id,
                'catalog_legacy_archived','maintenance:catalog-reconcile',
                jsonb_build_object(
                  'run_id',$3::text,
                  'reason','no_matrix_purchase_stock_or_classified_partner_stock',
                  'product_code',p.product_code,
                  'product_name',p.product_name,
                  'brand',p.brand,
                  'tire_condition',p.tire_condition,
                  'tire_size',ts.tire_size
                )
           FROM commerce.products p
           LEFT JOIN commerce.tire_specs ts
             ON ts.product_id=p.id AND ts.environment=p.environment
          WHERE p.environment=$1 AND p.id=ANY($2::uuid[])`,
        [environment, ids, runId],
      );
      const archived = await client.query(
        `UPDATE commerce.products
            SET deleted_at=now(),updated_at=now()
          WHERE environment=$1 AND id=ANY($2::uuid[]) AND deleted_at IS NULL`,
        [environment, ids],
      );
      if (archived.rowCount !== candidates.rowCount) {
        throw new Error(
          `arquivamento parcial: esperado ${candidates.rowCount}, alterado ${archived.rowCount}`,
        );
      }
      await client.query('COMMIT');
      console.log(`OK: ${archived.rowCount} produtos arquivados; run_id=${runId}`);
      return;
    }

    await client.query('ROLLBACK');
    console.log('OK: dry-run concluído com rollback.');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`ERRO: ${error.message}`);
  process.exit(1);
});
