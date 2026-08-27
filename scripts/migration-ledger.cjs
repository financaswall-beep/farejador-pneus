'use strict';

const { createHash } = require('node:crypto');

function migrationIdentity(migrationFile) {
  const match = /^(\d{4})([a-z]*)_[a-z0-9_]+[.]sql$/.exec(migrationFile);
  if (!match) throw new Error(`nome de migration invalido: ${migrationFile}`);
  return {
    order: Number(match[1]),
    suffix: match[2],
    file: migrationFile,
  };
}

function migrationChecksum(sql) {
  return createHash('sha256').update(sql).digest('hex');
}

async function hasMigrationLedger(client) {
  const result = await client.query(
    "SELECT to_regclass('ops.applied_migrations') IS NOT NULL AS ready",
  );
  return result.rows[0]?.ready === true;
}

async function recordApplicationMigration(
  client,
  migrationFile,
  rawSql,
  appliedBy = 'migration_executor',
) {
  if (!(await hasMigrationLedger(client))) return false;

  const identity = migrationIdentity(migrationFile);
  const checksum = migrationChecksum(rawSql);
  await client.query(`
    INSERT INTO ops.applied_migrations(
      migration_order,migration_suffix,migration_file,checksum_sha256,
      applied_at,recorded_by,verification_level
    ) VALUES ($1,$2,$3,$4,now(),$5,'executor')
    ON CONFLICT (migration_file) DO NOTHING
  `, [identity.order, identity.suffix, identity.file, checksum, appliedBy]);

  const recorded = await client.query(`
    SELECT migration_order,migration_suffix,checksum_sha256
      FROM ops.applied_migrations
     WHERE migration_file=$1
  `, [identity.file]);
  const row = recorded.rows[0];
  if (!row
      || Number(row.migration_order) !== identity.order
      || row.migration_suffix !== identity.suffix
      || row.checksum_sha256 !== checksum) {
    throw new Error(`migration_ledger_mismatch:${identity.file}`);
  }

  await client.query(`
    INSERT INTO ops.application_schema_state(
      singleton,version,migration_name,applied_at
    ) VALUES (true,$1,$2,now())
    ON CONFLICT (singleton) DO UPDATE
       SET version=EXCLUDED.version,
           migration_name=EXCLUDED.migration_name,
           applied_at=EXCLUDED.applied_at
     WHERE ops.application_schema_state.version<EXCLUDED.version
        OR (ops.application_schema_state.version=EXCLUDED.version
            AND ops.application_schema_state.migration_name<>EXCLUDED.migration_name)
  `, [identity.order, identity.file]);
  return true;
}

module.exports = {
  hasMigrationLedger,
  migrationChecksum,
  migrationIdentity,
  recordApplicationMigration,
};
