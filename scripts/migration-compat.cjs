'use strict';

/**
 * Compatibilidade de replay para migrations historicas imutaveis.
 *
 * Estes ajustes existem somente em memoria. Os SQL versionados e seus hashes
 * permanecem intocados, inclusive quando um PostgreSQL 17 vazio precisa
 * reconstruir todo o schema.
 */
function patchKnownMigrationIssues(file, sql) {
  if (file === '0020_vehicle_fitment_validation.sql') {
    return {
      sql: sql
        .replace(/^(\s*)position(\s+)TEXT,$/m, '$1"position"$2TEXT,')
        .replace(/^(\s*)f\.position,$/gm, '$1f."position",')
        .replace(/f\.position\s*=\s*p_position/g, 'f."position" = p_position')
        .replace(/f\.position\s*=\s*'both'/g, 'f."position" = \'both\'')
        .replace(/(GROUP BY[^;]*?)f\.position,/g, '$1f."position",'),
      reason: 'PostgreSQL 17 exige position entre aspas em RETURNS TABLE',
    };
  }

  if (file === '0083_network_unit_coverage_and_token_role.sql') {
    return {
      sql: sql.replace(
        /INSERT INTO network\.unit_coverage \(environment, unit_id, municipio\)\s+VALUES \('prod', '36203e18-c3fb-4201-bca1-b15c605faa37', 'itaborai'\)\s+ON CONFLICT \(environment, unit_id, municipio\) DO NOTHING;/,
        `INSERT INTO network.unit_coverage (environment, unit_id, municipio)
         SELECT 'prod', '36203e18-c3fb-4201-bca1-b15c605faa37'::uuid, 'itaborai'
          WHERE EXISTS (SELECT 1 FROM core.units WHERE id='36203e18-c3fb-4201-bca1-b15c605faa37'::uuid)
         ON CONFLICT (environment, unit_id, municipio) DO NOTHING;`,
      ),
      reason: 'seed historico so pode referenciar unidade existente',
    };
  }

  if (file === '0101_drop_organizadora_dead_tables.sql') {
    return {
      sql: sql.replace(
        'DROP TABLE IF EXISTS ops.agent_incidents;',
        '-- replay fresh: ops.agent_incidents preservada porque views historicas ainda dependem dela',
      ),
      reason: 'replay preserva tabela ainda referenciada por views historicas',
    };
  }

  return { sql, reason: null };
}

/**
 * O replay oficial controla uma unica transacao externa. Algumas migrations
 * historicas trazem BEGIN;/COMMIT; proprios; manter esses comandos permitiria
 * que um COMMIT interno furasse o rollback do modo dry-run.
 *
 * BEGIN de blocos PL/pgSQL nao termina em ponto e virgula, portanto nao e
 * atingido por esta normalizacao.
 */
function stripEmbeddedTransactionControl(sql) {
  return sql.replace(
    /^[\t ]*(?:BEGIN|COMMIT);[\t ]*(?:--[^\r\n]*)?\r?\n?/gim,
    '',
  );
}

module.exports = { patchKnownMigrationIssues, stripEmbeddedTransactionControl };
