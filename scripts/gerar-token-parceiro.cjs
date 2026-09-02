'use strict';
// Gera, lista ou revoga tokens de acesso do Portal Parceiro.
//
// Uso:
//   COMMIT=1 node scripts/gerar-token-parceiro.cjs --slug=<slug> [--label="texto"] --env=prod|test
//   node scripts/gerar-token-parceiro.cjs --slug=<slug> --list
//   COMMIT=1 node scripts/gerar-token-parceiro.cjs --slug=<slug> --revoke=<token_id> --env=prod|test
// Em produção, gerar/revogar também exige ALLOW_PROD_PARTNER_TOKEN=<slug>.
//
// O token em texto puro só aparece UMA VEZ no stdout. Copie e cole na tela
// de login do portal (/parceiro/<slug>/). O banco só guarda o sha256.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

// Carrega .env manualmente (sem depender de dotenv).
(function loadDotEnv() {
  if (process.env.DATABASE_URL) return;
  const envPath = path.resolve(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    if (process.env[m[1]] !== undefined) continue;
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    process.env[m[1]] = val;
  }
})();

function parseArgs() {
  const out = {};
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

async function main() {
  const args = parseArgs();
  const slug = args.slug;
  const env = args.env || process.env.FAREJADOR_ENV;
  const commit = process.env.COMMIT === '1';
  const mutating = !args.list;

  if (!slug) {
    console.error('Faltou --slug=<slug-da-unidade>. Ex: --slug=borracharia-rio-do-ouro');
    process.exit(2);
  }
  if (!['prod', 'test'].includes(env)) {
    console.error('Informe --env=prod|test ou FAREJADOR_ENV=prod|test.');
    process.exit(2);
  }
  if (process.env.FAREJADOR_ENV !== env) {
    console.error(`Ambiente divergente: argumento=${env}, FAREJADOR_ENV=${process.env.FAREJADOR_ENV || 'ausente'}.`);
    process.exit(2);
  }
  if (mutating && !commit) {
    console.error('Operação de gravação bloqueada. Revise os argumentos e informe COMMIT=1.');
    process.exit(2);
  }
  if (
    mutating
    && env === 'prod'
    && process.env.ALLOW_PROD_PARTNER_TOKEN !== slug
  ) {
    console.error(`Produção bloqueada. Informe ALLOW_PROD_PARTNER_TOKEN=${slug}.`);
    process.exit(2);
  }
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL nao definido no ambiente.');
    process.exit(2);
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  try {
    const unit = await client.query(
      `SELECT id, display_name, status
         FROM network.partner_units
        WHERE environment = $1 AND slug = $2 AND deleted_at IS NULL`,
      [env, slug],
    );
    if (unit.rowCount === 0) {
      console.error(`Unidade nao encontrada: env=${env} slug=${slug}`);
      process.exit(1);
    }
    const partnerUnitId = unit.rows[0].id;
    console.log(`Unidade: ${unit.rows[0].display_name} (${partnerUnitId}) status=${unit.rows[0].status}\n`);

    if (args.list) {
      const rows = await client.query(
        `SELECT id, label, created_at, last_used_at, revoked_at
           FROM network.partner_access_tokens
          WHERE environment = $1 AND partner_unit_id = $2
          ORDER BY created_at DESC`,
        [env, partnerUnitId],
      );
      if (rows.rowCount === 0) {
        console.log('Nenhum token cadastrado.');
        return;
      }
      console.log('Tokens cadastrados:');
      for (const r of rows.rows) {
        const status = r.revoked_at ? `REVOGADO em ${r.revoked_at.toISOString()}` : 'ATIVO';
        const last = r.last_used_at ? r.last_used_at.toISOString() : 'nunca';
        console.log(`  ${r.id}  [${status}]  label="${r.label ?? ''}"  criado=${r.created_at.toISOString()}  ultimo_uso=${last}`);
      }
      return;
    }

    if (args.revoke) {
      const tokenId = String(args.revoke);
      const res = await client.query(
        `UPDATE network.partner_access_tokens
            SET revoked_at = now()
          WHERE id = $1 AND environment = $2 AND partner_unit_id = $3 AND revoked_at IS NULL
          RETURNING id, label`,
        [tokenId, env, partnerUnitId],
      );
      if (res.rowCount === 0) {
        console.error(`Token ${tokenId} nao encontrado ou ja revogado para essa unidade.`);
        process.exit(1);
      }
      console.log(`Token revogado: ${res.rows[0].id} (label="${res.rows[0].label ?? ''}")`);
      return;
    }

    // Geracao de token novo
    const token = crypto.randomBytes(32).toString('hex'); // 64 chars hex
    const label = args.label || `gerado_em_${new Date().toISOString().slice(0, 10)}`;

    const insert = await client.query(
      `INSERT INTO network.partner_access_tokens (environment, partner_unit_id, token_hash, label, created_by)
       VALUES ($1, $2, network.hash_partner_token($3), $4, $5)
       RETURNING id, created_at`,
      [env, partnerUnitId, token, label, 'script:gerar-token-parceiro'],
    );

    console.log('=== TOKEN GERADO (COPIE AGORA - NAO SERA EXIBIDO DE NOVO) ===\n');
    console.log(token);
    console.log('\n=============================================================');
    console.log(`token_id: ${insert.rows[0].id}`);
    console.log(`criado:   ${insert.rows[0].created_at.toISOString()}`);
    console.log(`label:    ${label}`);
    console.log(`\nCole esse token na tela de login do portal:`);
    console.log(`  /parceiro/${slug}/`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('Erro:', err.message);
  process.exit(1);
});
