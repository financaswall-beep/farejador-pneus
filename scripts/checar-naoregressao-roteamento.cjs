'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// NÃO-REGRESSÃO DE ROTEAMENTO — gate da 0087 (FASE 1 do PLANO_CONFIG_LOJA_E_
// ROTEAMENTO_REDE_2026-06-05). Read-only (SELECT só), BEGIN/ROLLBACK por garantia.
//
// PROVA, no momento do apply, que `resolveUnitForMunicipio` continua resolvendo
// IDÊNTICO a hoje depois da 0087 (colunas novas NULL / coverage_kind='city'):
//   itaborai → Borracharia Rio do Ouro
//   niteroi  → Anderson Tavares
//
// Roda a MESMA query de src/atendente-v2/fulfillment.ts:resolveUnitForMunicipio
// (mesmo WHERE/ORDER BY/LIMIT 1) e a MESMA normalização (normalizeRegion). Se o
// parceiro resolvido divergir do esperado, sai com código != 0 (gate de deploy).
//
// USO: rodar com env=prod (DATABASE_URL apontando pra prod) ANTES e DEPOIS de
//   aplicar a 0087 — o resultado tem que ser o mesmo. Aponte DATABASE_URL ou
//   deixe que ele leia o .env (mesmo padrão de checar-cobertura-rede.cjs).
//     node scripts/checar-naoregressao-roteamento.cjs
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');

function loadDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const env = fs.readFileSync('.env', 'utf8');
  const m = env.match(/^DATABASE_URL=(.*)$/m);
  if (!m) throw new Error('DATABASE_URL não achado no .env');
  return m[1].trim().replace(/^["']|["']$/g, '');
}

const ENVIRONMENT = process.env.FAREJADOR_ENV || 'prod';

// Mesma normalização de fulfillment.ts (normalizeRegion): NFD, tira acento, trim, lower.
function normalizeRegion(s) {
  return (s == null ? '' : String(s)).normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
}

// Query byte-a-byte igual a resolveUnitForMunicipio (LIMIT 1 incluso).
const ROUTE_SQL = `
  SELECT pu.id            AS partner_unit_id,
         pu.unit_id       AS unit_id,
         p.id             AS partner_id,
         pu.slug          AS slug,
         p.trade_name     AS partner_name,
         COALESCE(pu.display_name, u.name) AS unit_name
  FROM network.unit_coverage uc
  JOIN network.partner_units pu ON pu.unit_id = uc.unit_id AND pu.environment = uc.environment
  JOIN network.partners p ON p.id = pu.partner_id AND p.environment = pu.environment
  JOIN core.units u ON u.id = pu.unit_id
  WHERE uc.environment = $1
    AND $2 LIKE '%' || uc.municipio || '%'
    AND pu.status = 'active'
    AND p.status = 'active'
    AND pu.deleted_at IS NULL
    AND p.deleted_at IS NULL
  ORDER BY length(uc.municipio) DESC, pu.created_at ASC
  LIMIT 1`;

// O que tem que continuar valendo (substring case-insensitive no trade_name).
const EXPECTATIONS = [
  { municipio: 'itaborai', expectNameContains: 'rio do ouro' },
  { municipio: 'niteroi', expectNameContains: 'anderson' },
];

const { Client } = require('pg');
const client = new Client({ connectionString: loadDatabaseUrl(), ssl: { rejectUnauthorized: false } });

async function resolve(municipio) {
  const m = normalizeRegion(municipio);
  if (!m) return null;
  const r = await client.query(ROUTE_SQL, [ENVIRONMENT, m]);
  return r.rows[0] || null;
}

async function main() {
  await client.connect();
  await client.query('BEGIN'); // read-only; ROLLBACK no fim por garantia
  console.log(`=== NÃO-REGRESSÃO DE ROTEAMENTO (env=${ENVIRONMENT}) ===\n`);

  let failures = 0;
  for (const exp of EXPECTATIONS) {
    const row = await resolve(exp.municipio);
    const name = row ? row.partner_name : null;
    const ok = !!name && name.toLowerCase().includes(exp.expectNameContains);
    if (!ok) failures++;
    console.log(`  ${exp.municipio.padEnd(10)} -> ${name ? `"${name}" (slug=${row.slug}, unit_id=${row.unit_id})` : 'NENHUM parceiro (matriz)'}`);
    console.log(`             esperado conter: "${exp.expectNameContains}"  ${ok ? 'OK' : '*** DIVERGÊNCIA ***'}`);
  }

  console.log();
  if (failures > 0) {
    console.log(`RESULTADO: ${failures} divergência(s) — REGRESSÃO de roteamento. NÃO prosseguir com o deploy.`);
  } else {
    console.log('RESULTADO: roteamento idêntico ao esperado (Rio do Ouro / Anderson). Sem regressão.');
  }

  await client.query('ROLLBACK');
  await client.end();
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
