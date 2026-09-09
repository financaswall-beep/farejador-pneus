'use strict';

const { Pool } = require('pg');
const { BATCH, CHECKED_AT, confirmed, pending }
  = require('./data/catalog-tire-spec-review-20260909.cjs');

const apply = process.argv.includes('--apply');
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL obrigatória');

function normalize(value) {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .trim().replace(/\s+/g, ' ').toLowerCase();
}

function validateResearch() {
  const reviewed = [...confirmed, ...pending];
  const codes = reviewed.map((row) => row.productCode);
  if (codes.length !== 49 || new Set(codes).size !== codes.length) {
    throw new Error('stage4_review_must_cover_49_unique_products');
  }
  for (const row of confirmed) {
    if (!['front', 'rear', 'both'].includes(row.position)) {
      throw new Error(`invalid_position:${row.productCode}`);
    }
    if (!/^https:\/\//.test(row.sourceUrl)) throw new Error(`invalid_source:${row.productCode}`);
  }
}

async function main() {
  validateResearch();
  const pool = new Pool({ connectionString, max: 1, ssl: { rejectUnauthorized: false } });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout='30s'");
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [BATCH]);
    const inventory = await client.query(`
      SELECT p.id AS product_id,p.product_code,p.brand,ts.id AS tire_spec_id,
             ts.tire_size,ts.tread_pattern,ts.load_index,ts.speed_rating,ts.position
        FROM commerce.products p
        JOIN commerce.tire_specs ts
          ON ts.environment=p.environment AND ts.product_id=p.id
       WHERE p.environment='prod' AND p.product_type='tire' AND p.deleted_at IS NULL
       ORDER BY p.product_code
       FOR UPDATE OF p,ts
    `);
    const byCode = new Map(inventory.rows.map((row) => [row.product_code, row]));
    const reviewedCodes = new Set([...confirmed, ...pending].map((row) => row.productCode));
    const unexpected = inventory.rows.filter((row) => !reviewedCodes.has(row.product_code));
    const missing = [...reviewedCodes].filter((code) => !byCode.has(code));
    if (unexpected.length || missing.length || inventory.rowCount !== 49) {
      throw new Error(`stage4_inventory_changed:${JSON.stringify({
        total: inventory.rowCount,
        unexpected: unexpected.map((row) => row.product_code),
        missing,
      })}`);
    }

    const changed = [];
    const unchanged = [];
    for (const research of confirmed) {
      const before = byCode.get(research.productCode);
      if (normalize(before.brand) !== normalize(research.brand)
        || before.tire_size !== research.measure
        || normalize(before.tread_pattern) !== normalize(research.treadPattern)) {
        throw new Error(`stage4_identity_mismatch:${research.productCode}`);
      }
      if (before.position && before.position !== research.position) {
        throw new Error(`stage4_position_conflict:${research.productCode}`);
      }
      if (before.load_index && before.load_index !== research.loadIndex) {
        throw new Error(`stage4_load_conflict:${research.productCode}`);
      }
      if (before.speed_rating && before.speed_rating !== research.speedRating) {
        throw new Error(`stage4_speed_conflict:${research.productCode}`);
      }
      const needsUpdate = before.load_index !== research.loadIndex
        || before.speed_rating !== research.speedRating
        || before.position !== research.position;
      if (!needsUpdate) {
        unchanged.push(research.productCode);
        continue;
      }
      const updated = await client.query(`
        UPDATE commerce.tire_specs
           SET load_index=$3,speed_rating=$4,position=$5,updated_at=now()
         WHERE environment='prod' AND id=$1 AND product_id=$2
         RETURNING id,tread_pattern,load_index,speed_rating,position
      `, [before.tire_spec_id, before.product_id, research.loadIndex,
        research.speedRating, research.position]);
      const after = updated.rows[0];
      await client.query(`
        INSERT INTO audit.events
          (environment,domain,entity_table,entity_id,event_type,actor_label,
           payload_before,payload_after)
        VALUES ('prod','catalog','commerce.tire_specs',$1,
                'catalog_tire_spec_changed',$2,$3::jsonb,$4::jsonb)
      `, [before.tire_spec_id, 'Etapa 4 — pesquisa oficial autorizada pelo proprietário',
        JSON.stringify(before), JSON.stringify({
          ...after,
          product_id: before.product_id,
          reason: 'Enriquecimento individual do pneu atual com fonte oficial do fabricante.',
          batch: BATCH,
          checked_at: CHECKED_AT,
          source_type: 'manufacturer_catalog',
          truth_type: 'verified',
          confidence_level: 'high',
          source_reference: research.sourceUrl,
          source_title: research.sourceTitle,
          extractor_version: BATCH,
        })]);
      changed.push(research.productCode);
    }

    const result = {
      mode: apply ? 'apply' : 'dry-run',
      batch: BATCH,
      catalog_products_reviewed: inventory.rowCount,
      confirmed_specs: confirmed.length,
      pending_physical_identification: pending.length,
      changed,
      unchanged,
    };
    if (apply) await client.query('COMMIT');
    else await client.query('ROLLBACK');
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
