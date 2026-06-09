'use strict';
// SÓ-LEITURA: estado do raio de entrega (delivery_radius_km) dos parceiros ATIVOS em prod.
// Gate de deploy da Fase 3 (entrega por proximidade): com a flag ROUTING_PROXIMITY_FIRST
// já ligada no Coolify, loja sem raio fica FORA da entrega assim que a Fase 3 subir.
//   node scripts/checar-raio-prod.cjs
const fs = require('fs');
const { Client } = require('pg');

function loadDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const env = fs.readFileSync('.env', 'utf8');
  const m = env.match(/^DATABASE_URL=(.*)$/m);
  if (!m) throw new Error('DATABASE_URL não achado no .env');
  return m[1].trim().replace(/^["']|["']$/g, '');
}

async function main() {
  const client = new Client({ connectionString: loadDatabaseUrl() });
  await client.connect();
  try {
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
    await client.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
