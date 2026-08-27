import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const {
  migrationChecksum,
  migrationIdentity,
  recordApplicationMigration,
} = require('../../../scripts/migration-ledger.cjs') as {
  migrationChecksum: (sql: string) => string;
  migrationIdentity: (file: string) => {
    order: number; suffix: string; file: string;
  };
  recordApplicationMigration: (
    client: { query: ReturnType<typeof vi.fn> },
    file: string,
    sql: string,
    appliedBy?: string,
  ) => Promise<boolean>;
};

describe('ledger canônico de migrations', () => {
  it('materializa o histórico conhecido sem inventar data de aplicação', () => {
    const sql = readFileSync('db/migrations/0213_migration_ledger.sql', 'utf8');
    const rows = sql.match(
      /\(\d+,'[a-z]*','\d{4}[a-z]*_[a-z0-9_]+[.]sql','[0-9a-f]{64}',NULL,/g,
    ) || [];

    expect(sql).toContain('CREATE TABLE ops.applied_migrations');
    expect(sql).toContain('applied_migrations_immutable');
    expect(sql).toContain("VALUES (true,213,'0213_migration_ledger.sql',now())");
    expect(rows).toHaveLength(213);
    expect(rows.some((row) => row.includes("'0213_migration_ledger.sql'"))).toBe(false);
  });

  it('entende migrations com sufixo e calcula SHA-256 do arquivo bruto', () => {
    expect(migrationIdentity('0109b_push_pk_include_unit.sql')).toEqual({
      order: 109,
      suffix: 'b',
      file: '0109b_push_pk_include_unit.sql',
    });
    expect(migrationChecksum('SELECT 1;')).toBe(
      createHash('sha256').update('SELECT 1;').digest('hex'),
    );
    expect(() => migrationIdentity('migration.sql')).toThrow('nome de migration invalido');
  });

  it('registra o arquivo e avança o marcador na mesma transação do executor', async () => {
    const checksum = migrationChecksum('SELECT 1;');
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("to_regclass('ops.applied_migrations')")) {
        return { rows: [{ ready: true }] };
      }
      if (sql.includes('SELECT migration_order')) {
        return { rows: [{
          migration_order: 214,
          migration_suffix: '',
          checksum_sha256: checksum,
        }] };
      }
      return { rows: [] };
    });

    await expect(recordApplicationMigration(
      { query },'0214_example.sql','SELECT 1;','unit_test',
    )).resolves.toBe(true);
    expect(query).toHaveBeenCalledTimes(4);
    expect(query.mock.calls[1]?.[0]).toContain('INSERT INTO ops.applied_migrations');
    expect(query.mock.calls[3]?.[0]).toContain('ops.application_schema_state');
  });

  it('recusa checksum diferente do que já foi gravado', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("to_regclass('ops.applied_migrations')")) {
        return { rows: [{ ready: true }] };
      }
      if (sql.includes('SELECT migration_order')) {
        return { rows: [{
          migration_order: 214,
          migration_suffix: '',
          checksum_sha256: '0'.repeat(64),
        }] };
      }
      return { rows: [] };
    });

    await expect(recordApplicationMigration(
      { query },'0214_example.sql','SELECT 1;',
    )).rejects.toThrow('migration_ledger_mismatch:0214_example.sql');
  });
});
