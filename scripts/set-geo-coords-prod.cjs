'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// Popula latitude/longitude (network.partner_units) dos parceiros REAIS em prod,
// a partir das coordenadas reais (links do Google Maps do Wallace, 2026-06-06).
// Combustível da camada GEO (proximidade). INOFENSIVO enquanto ROUTING_GEO=OFF
// (nada lê lat/long). Idempotente. Match por slug.
//
//   DRY-RUN (default):  node scripts/set-geo-coords-prod.cjs
//   APLICAR:            node scripts/set-geo-coords-prod.cjs --commit
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const { Client } = require('pg');

const COMMIT = process.argv.includes('--commit');
const ENV = 'prod';

// slug → [lat, lng]. Zona Sul/cidade do Rio (5 borracharias de teste) + 2 reais.
const COORDS = {
  'zz-teste-copacabana': [-22.984613, -43.198278],
  'zz-teste-meier': [-22.901230, -43.282202],
  'zz-teste-madureira': [-22.873217, -43.338000],
  'zz-teste-tijuca': [-22.938627, -43.249959],
  'zz-teste-barra': [-23.001191, -43.414283],
  'anderson-tavares': [-22.907564, -43.104245], // Niterói (real)
  'borracharia-rio-do-ouro': [-22.747397, -42.859156], // Itaboraí (real)
};

function loadDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const env = fs.readFileSync('.env', 'utf8');
  const m = env.match(/^DATABASE_URL=(.*)$/m);
  if (!m) throw new Error('DATABASE_URL não achado no .env');
  return m[1].trim().replace(/^["']|["']$/g, '');
}

(async () => {
  const c = new Client({ connectionString: loadDatabaseUrl(), ssl: { rejectUnauthorized: false } });
  await c.connect();
  try {
    await c.query('BEGIN');
    console.log(`=== SET GEO COORDS (env=${ENV}) — ${COMMIT ? 'APLICANDO' : 'DRY-RUN'} ===\n`);
    let changed = 0;
    let missing = 0;
    for (const [slug, [lat, lng]] of Object.entries(COORDS)) {
      const before = await c.query(
        `SELECT latitude, longitude FROM network.partner_units WHERE environment=$1 AND slug=$2 AND deleted_at IS NULL`,
        [ENV, slug],
      );
      if (before.rowCount === 0) {
        console.log(`  ${slug.padEnd(24)} — NÃO ENCONTRADO (pulado)`);
        missing++;
        continue;
      }
      const cur = before.rows[0];
      const já = Number(cur.latitude) === lat && Number(cur.longitude) === lng;
      await c.query(
        `UPDATE network.partner_units SET latitude=$3, longitude=$4 WHERE environment=$1 AND slug=$2 AND deleted_at IS NULL`,
        [ENV, slug, lat, lng],
      );
      const antes = cur.latitude != null ? `(${cur.latitude},${cur.longitude})` : 'NULL';
      console.log(`  ${slug.padEnd(24)} ${antes.padEnd(22)} → (${lat},${lng})${já ? '  [já estava]' : ''}`);
      if (!já) changed++;
    }
    console.log(`\n${changed} a mudar · ${missing} não encontrado(s).`);
    if (COMMIT) {
      await c.query('COMMIT');
      console.log('✅ APLICADO em prod. (Inofensivo: ROUTING_GEO ainda OFF → nada lê lat/long.)');
    } else {
      await c.query('ROLLBACK');
      console.log('↩️  DRY-RUN — nada gravado. Rode com --commit pra aplicar.');
    }
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    await c.end();
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
