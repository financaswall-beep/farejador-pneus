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
  SELECT
    psl.id,
    psl.unit_id,
    unit.slug AS unit_slug,
    unit.display_name AS unit_name,
    psl.item_name,
    psl.tire_size,
    psl.brand,
    psl.quantity_on_hand,
    COALESCE(psl.quantity_reserved, 0) AS quantity_reserved
  FROM commerce.partner_stock_levels psl
  LEFT JOIN LATERAL (
    SELECT s.slug, s.display_name
    FROM network.partner_unit_summary s
    WHERE s.environment=psl.environment
      AND s.unit_id=psl.unit_id
    LIMIT 1
  ) unit ON true
  WHERE psl.environment=$1
    AND psl.deleted_at IS NULL
    AND COALESCE(psl.item_type, 'pneu')='pneu'
    AND psl.tire_condition IS NULL
    AND (
      unit.slug LIKE 'zz-teste-%'
      OR lower(btrim(COALESCE(psl.brand, '')))='teste'
    )
  ORDER BY unit.slug, psl.item_name, psl.id
  FOR UPDATE OF psl`;

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
      stock: candidates.rows,
    }, null, 2));

    if (expectedArchive !== null && candidates.rowCount !== expectedArchive) {
      throw new Error(
        `quantidade mudou: esperado ${expectedArchive}, encontrado ${candidates.rowCount}`,
      );
    }
    const reserved = candidates.rows.filter((row) => Number(row.quantity_reserved) > 0);
    if (reserved.length > 0) {
      throw new Error(
        `há ${reserved.length} estoque(s) de teste com reserva; arquivamento bloqueado`,
      );
    }

    if (commit && candidates.rowCount > 0) {
      const runId = randomUUID();
      const ids = candidates.rows.map((row) => row.id);
      await client.query(
        `INSERT INTO audit.events (
           environment,domain,entity_table,entity_id,event_type,actor_label,payload_before
         )
         SELECT
           psl.environment,
           'stock',
           'commerce.partner_stock_levels',
           psl.id,
           'partner_pending_test_stock_archived',
           'maintenance:partner-test-stock-cleanup',
           jsonb_build_object(
             'run_id',$3::text,
             'reason','test_stock_must_not_remain_in_production',
             'unit_id',psl.unit_id,
             'item_name',psl.item_name,
             'tire_size',psl.tire_size,
             'brand',psl.brand,
             'tire_condition',psl.tire_condition,
             'quantity_on_hand',psl.quantity_on_hand,
             'quantity_reserved',psl.quantity_reserved
           )
         FROM commerce.partner_stock_levels psl
         WHERE psl.environment=$1
           AND psl.id=ANY($2::uuid[])`,
        [environment, ids, runId],
      );
      const archived = await client.query(
        `UPDATE commerce.partner_stock_levels
         SET deleted_at=now(),
             product_id=NULL,
             updated_by='maintenance:partner-test-stock-cleanup',
             updated_at=now()
         WHERE environment=$1
           AND id=ANY($2::uuid[])
           AND deleted_at IS NULL`,
        [environment, ids],
      );
      if (archived.rowCount !== candidates.rowCount) {
        throw new Error(
          `arquivamento parcial: esperado ${candidates.rowCount}, alterado ${archived.rowCount}`,
        );
      }
      await client.query('COMMIT');
      console.log(`OK: ${archived.rowCount} estoques de teste arquivados; run_id=${runId}`);
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
