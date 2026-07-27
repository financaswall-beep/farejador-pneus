/**
 * Inventário somente leitura para planejar uma limpeza de dados de produção.
 * Não lê conteúdo das linhas e não altera nenhum objeto.
 */
const { Client } = require('pg');

const applicationSchemas = [
  'raw',
  'core',
  'analytics',
  'ops',
  'commerce',
  'agent',
  'network',
  'finance',
  'marketing',
  'audit',
];

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

async function main() {
  if (process.env.FAREJADOR_ENV !== 'prod') {
    throw new Error('prod_environment_required');
  }
  if (!process.env.DATABASE_URL) throw new Error('database_url_required');

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query(`SET LOCAL statement_timeout='120s'`);

    const tables = await client.query(
      `SELECT n.nspname schema_name,c.relname table_name,c.relkind
         FROM pg_class c
         JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=ANY($1::text[])
          AND c.relkind IN ('r','p')
          AND NOT c.relispartition
        ORDER BY n.nspname,c.relname`,
      [applicationSchemas],
    );
    const tableCounts = [];
    for (const table of tables.rows) {
      const qualified = `${quoteIdentifier(table.schema_name)}.${quoteIdentifier(table.table_name)}`;
      const count = await client.query(`SELECT count(*)::int total FROM ${qualified}`);
      const hasEnvironment = await client.query(
        `SELECT EXISTS (
           SELECT 1
             FROM information_schema.columns
            WHERE table_schema=$1
              AND table_name=$2
              AND column_name='environment'
         ) present`,
        [table.schema_name, table.table_name],
      );
      let environments = null;
      if (hasEnvironment.rows[0].present) {
        const distribution = await client.query(
          `SELECT environment::text environment,count(*)::int rows
             FROM ${qualified}
            GROUP BY environment::text
            ORDER BY environment::text`,
        );
        environments = distribution.rows;
      }
      tableCounts.push({
        schema: table.schema_name,
        table: table.table_name,
        rows: count.rows[0].total,
        partitioned: table.relkind === 'p',
        environments,
      });
    }

    const objectCounts = await client.query(
      `SELECT
         (SELECT count(*)::int
            FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
           WHERE n.nspname=ANY($1::text[])) functions,
         (SELECT count(*)::int
            FROM pg_trigger t
            JOIN pg_class c ON c.oid=t.tgrelid
            JOIN pg_namespace n ON n.oid=c.relnamespace
           WHERE n.nspname=ANY($1::text[]) AND NOT t.tgisinternal) triggers,
         (SELECT count(*)::int
            FROM pg_views v WHERE v.schemaname=ANY($1::text[])) views,
         (SELECT count(*)::int
            FROM pg_matviews v WHERE v.schemaname=ANY($1::text[])) materialized_views`,
      [applicationSchemas],
    );
    const foreignKeys = await client.query(
      `SELECT
         src_ns.nspname source_schema,
         src.relname source_table,
         con.conname constraint_name,
         dst_ns.nspname target_schema,
         dst.relname target_table,
         CASE con.confdeltype
           WHEN 'a' THEN 'NO ACTION'
           WHEN 'r' THEN 'RESTRICT'
           WHEN 'c' THEN 'CASCADE'
           WHEN 'n' THEN 'SET NULL'
           WHEN 'd' THEN 'SET DEFAULT'
         END on_delete
       FROM pg_constraint con
       JOIN pg_class src ON src.oid=con.conrelid
       JOIN pg_namespace src_ns ON src_ns.oid=src.relnamespace
       JOIN pg_class dst ON dst.oid=con.confrelid
       JOIN pg_namespace dst_ns ON dst_ns.oid=dst.relnamespace
      WHERE con.contype='f'
        AND (src_ns.nspname=ANY($1::text[]) OR dst_ns.nspname=ANY($1::text[]))
      ORDER BY src_ns.nspname,src.relname,con.conname`,
      [applicationSchemas],
    );
    const databaseSize = await client.query(
      `SELECT pg_database_size(current_database())::bigint::text bytes,
              pg_size_pretty(pg_database_size(current_database())) pretty`,
    );
    const collaboratorSummary = await client.query(
      `SELECT
         mc.environment::text environment,
         COALESCE(mc.panel_role,'none') panel_role,
         (mc.revoked_at IS NULL) active,
         count(*)::int rows,
         count(*) FILTER (
           WHERE pp.revoked_at IS NULL AND pp.password_hash IS NOT NULL
         )::int login_ready,
         count(*) FILTER (
           WHERE EXISTS (
             SELECT 1
               FROM network.partner_access_tokens pat
              WHERE pat.person_id=mc.person_id
           )
         )::int also_partner_people
       FROM network.matriz_collaborators mc
       JOIN network.partner_people pp ON pp.id=mc.person_id
      GROUP BY mc.environment::text,COALESCE(mc.panel_role,'none'),(mc.revoked_at IS NULL)
      ORDER BY mc.environment::text,COALESCE(mc.panel_role,'none'),(mc.revoked_at IS NULL) DESC`,
    );

    const schemas = applicationSchemas.map((schema) => {
      const items = tableCounts.filter((table) => table.schema === schema);
      return {
        schema,
        tables: items.length,
        non_empty_tables: items.filter((table) => table.rows > 0).length,
        rows: items.reduce((total, table) => total + table.rows, 0),
      };
    });
    const possibleControlData = tableCounts.filter((table) =>
      /(config|setting|rule|prompt|admin|user|token|session|taxonomy|feature)/i
        .test(table.table),
    );

    console.log(JSON.stringify({
      mode: 'read_only',
      environment: 'prod',
      database_size: databaseSize.rows[0],
      structure_to_preserve: {
        tables: tableCounts.length,
        ...objectCounts.rows[0],
      },
      collaborator_summary: collaboratorSummary.rows,
      data_by_schema: schemas,
      all_tables: tableCounts,
      foreign_keys: foreignKeys.rows,
      non_empty_tables: tableCounts
        .filter((table) => table.rows > 0)
        .sort((a, b) => b.rows - a.rows),
      possible_control_or_access_tables: possibleControlData,
      immutable_raw_events: tableCounts.find(
        (table) => table.schema === 'raw' && table.table === 'raw_events',
      ) ?? null,
    }, null, 2));
    await client.query('ROLLBACK');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(
    `CLEANUP_INVENTORY_FAILED:${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
