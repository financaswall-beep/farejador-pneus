'use strict';
// SÓ-LEITURA: estado do raio de entrega (delivery_radius_km) dos parceiros ATIVOS em prod.
// Gate de deploy da Fase 3 (entrega por proximidade): com a flag ROUTING_PROXIMITY_FIRST
// já ligada no Coolify, loja sem raio fica FORA da entrega assim que a Fase 3 subir.
//   FAREJADOR_ENV=prod node --env-file=.env scripts/checar-raio-prod.cjs
const { Client } = require('pg');

function loadDatabaseUrl() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL ausente');
  return process.env.DATABASE_URL;
}

async function main() {
  if (process.env.FAREJADOR_ENV !== 'prod') {
    throw new Error('este gate exige FAREJADOR_ENV=prod explicitamente');
  }
  const client = new Client({
    connectionString: loadDatabaseUrl(),
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout='30s'");
    const r = await client.query(
      `SELECT pu.slug, COALESCE(pu.display_name, u.name) AS nome, pu.service_mode,
              pu.delivery_radius_km, (pu.latitude IS NOT NULL AND pu.longitude IS NOT NULL) AS tem_coord
         FROM network.partner_units pu
         JOIN network.partners p ON p.id = pu.partner_id AND p.environment = pu.environment
         JOIN core.units u ON u.id = pu.unit_id
        WHERE pu.environment = 'prod'
          AND pu.status = 'active' AND p.status = 'active'
          AND pu.deleted_at IS NULL AND p.deleted_at IS NULL
        ORDER BY pu.slug`,
    );
    console.log('=== RAIO DE ENTREGA — parceiros ativos (prod) ===');
    for (const row of r.rows) {
      const entrega = row.service_mode === 'delivery' || row.service_mode === 'both';
      const raio = row.delivery_radius_km != null ? `${Number(row.delivery_radius_km)} km` : 'NULL (fora da entrega na Fase 3)';
      console.log(
        `  ${row.slug.padEnd(28)} modo=${String(row.service_mode).padEnd(8)} coord=${row.tem_coord ? 'sim' : 'NÃO'}  ${entrega ? 'raio=' + raio : '(só retirada — raio não se aplica)'}`,
      );
    }
    console.log(`\nTotal: ${r.rowCount} unidade(s) ativa(s).`);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    await client.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
