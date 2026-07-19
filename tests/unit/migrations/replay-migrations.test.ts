import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  patchKnownMigrationIssues,
  stripEmbeddedTransactionControl,
} = require('../../../scripts/migration-compat.cjs') as {
  patchKnownMigrationIssues: (file: string, sql: string) => { sql: string; reason: string | null };
  stripEmbeddedTransactionControl: (sql: string) => string;
};

describe('replay imutavel das migrations historicas', () => {
  it('escapa position na 0020 sem editar o arquivo versionado', () => {
    const result = patchKnownMigrationIssues(
      '0020_vehicle_fitment_validation.sql',
      'RETURNS TABLE (\n  position          TEXT,\n  x TEXT\n)\nSELECT f.position, x GROUP BY f.position, x WHERE f.position = p_position OR f.position = \'both\';',
    );
    expect(result.reason).toContain('PostgreSQL 17');
    expect(result.sql).toContain('"position"          TEXT,');
    expect(result.sql).toContain('f."position",');
    expect(result.sql).toContain('f."position" = p_position');
    expect(result.sql).toContain('f."position" = \'both\'');
  });

  it('torna o seed da 0083 seguro quando a unidade historica nao existe', () => {
    const result = patchKnownMigrationIssues(
      '0083_network_unit_coverage_and_token_role.sql',
      "INSERT INTO network.unit_coverage (environment, unit_id, municipio)\nVALUES ('prod', '36203e18-c3fb-4201-bca1-b15c605faa37', 'itaborai')\nON CONFLICT (environment, unit_id, municipio) DO NOTHING;",
    );
    expect(result.sql).toContain('WHERE EXISTS');
    expect(result.sql).toContain('FROM core.units');
  });

  it('preserva a tabela ainda referenciada durante replay da 0101', () => {
    const result = patchKnownMigrationIssues(
      '0101_drop_organizadora_dead_tables.sql',
      'DROP TABLE IF EXISTS ops.agent_incidents;',
    );
    expect(result.sql).not.toContain('DROP TABLE IF EXISTS ops.agent_incidents;');
    expect(result.sql).toContain('replay fresh');
  });

  it('nao altera migrations sem compatibilidade conhecida', () => {
    const sql = 'SELECT 1;';
    expect(patchKnownMigrationIssues('0143_matriz_logistics_payroll_consistency.sql', sql))
      .toEqual({ sql, reason: null });
  });

  it('remove transacoes historicas para o dry-run nao confirmar dados', () => {
    const sql = [
      'BEGIN;',
      'CREATE TABLE example(id bigint);',
      'COMMIT;',
      'DO $$',
      'BEGIN',
      '  NULL;',
      'END;',
      '$$;',
    ].join('\n');

    const result = stripEmbeddedTransactionControl(sql);
    expect(result).not.toMatch(/^BEGIN;$/m);
    expect(result).not.toMatch(/^COMMIT;$/m);
    expect(result).toContain('CREATE TABLE example');
    expect(result).toContain('DO $$\nBEGIN\n');
  });
});
