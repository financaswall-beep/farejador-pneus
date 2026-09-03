'use strict';

// Auditoria somente leitura da cobertura e do roteamento da Rede.
const { Client } = require('pg');

const environment = process.env.FAREJADOR_ENV;
if (!['prod', 'test'].includes(environment)) {
  throw new Error('FAREJADOR_ENV deve ser informado explicitamente como prod ou test');
}
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL ausente');

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

async function main() {
  await client.connect();
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await client.query("SET LOCAL statement_timeout='30s'");

  console.log(`=== UNIDADES + COBERTURA DA REDE (env=${environment}) ===\n`);

  console.log(`--- core.units (${environment}) ---`);
  const units = await client.query(
    `SELECT id, slug, name
       FROM core.units
      WHERE environment=$1
      ORDER BY name`,
    [environment],
  );
  for (const row of units.rows) {
    console.log(`  ${row.slug.padEnd(20)} ${row.name}  [${row.id}]`);
  }
  console.log();

  console.log(`--- network.partners + partner_units (${environment}) ---`);
  const partnerUnits = await client.query(
    `SELECT p.trade_name, pu.slug, pu.status AS unit_status,
            p.status AS partner_status, pu.unit_id
       FROM network.partner_units pu
       JOIN network.partners p
         ON p.id=pu.partner_id AND p.environment=pu.environment
      WHERE pu.environment=$1
      ORDER BY pu.created_at`,
    [environment],
  );
  for (const row of partnerUnits.rows) {
    console.log(
      `  ${(row.trade_name || '').padEnd(24)} slug=${(row.slug || '').padEnd(18)}`
      + ` unit=${row.unit_status}/${row.partner_status} unit_id=${row.unit_id}`,
    );
  }
  console.log();

  console.log(`--- network.unit_coverage (${environment}) ---`);
  const coverage = await client.query(
    `SELECT uc.municipio, u.name AS unit_name, uc.unit_id
       FROM network.unit_coverage uc
       JOIN core.units u ON u.id=uc.unit_id AND u.environment=uc.environment
      WHERE uc.environment=$1
      ORDER BY u.name, uc.municipio`,
    [environment],
  );
  console.log(`  (total ${coverage.rowCount} linhas)`);
  for (const row of coverage.rows) {
    console.log(`  municipio=${JSON.stringify(row.municipio)} -> ${row.unit_name}`);
  }
  console.log();

  const distinct = await client.query(
    `SELECT DISTINCT municipio
       FROM network.unit_coverage
      WHERE environment=$1
      ORDER BY municipio`,
    [environment],
  );
  console.log(`--- valores distintos em unit_coverage.municipio (${distinct.rowCount}) ---`);
  console.log(`  ${distinct.rows.map((row) => row.municipio).join(' | ')}`);
  console.log();

  console.log(`--- resolve_neighborhood(${environment}, <bairro>) ---`);
  for (const neighborhood of ['fonseca', 'centro', 'meier', 'bom sucesso', 'icarai', 'alcantara']) {
    try {
      const result = await client.query(
        `SELECT city_name, neighborhood_canonical
           FROM commerce.resolve_neighborhood($1, $2, NULL)
          LIMIT 1`,
        [environment, neighborhood],
      );
      const row = result.rows[0];
      console.log(
        `  ${JSON.stringify(neighborhood)} -> city_name=${row ? JSON.stringify(row.city_name) : 'NULL'}`
        + ` canonical=${row ? JSON.stringify(row.neighborhood_canonical) : '-'}`,
      );
    } catch (error) {
      console.log(`  ${JSON.stringify(neighborhood)} -> ERRO ${error.message}`);
    }
  }

  await client.query('ROLLBACK');
}

main()
  .catch(async (error) => {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => client.end().catch(() => undefined));
