#!/usr/bin/env node
'use strict';
/* eslint-disable no-console */
// ─────────────────────────────────────────────────────────────────────────────
// RESETA a senha de um login de parceiro JÁ existente (não cria novo).
// Espelha o scrypt do app (password.ts) — mesmos parâmetros e formato
// scrypt:<salt_hex>:<hash_hex>. Atualiza login_password_hash + _set_at do
// token ATIVO (revoked_at IS NULL) daquele usuário na unidade.
//
//   DRY-RUN: node --env-file=.env scripts/resetar-senha-parceiro.cjs --slug=<slug> --username=<user> --env=prod|test
//   APLICAR: COMMIT=1 node --env-file=.env scripts/resetar-senha-parceiro.cjs --slug=<slug> --username=<user> --env=prod|test
//   Em produção também exige ALLOW_PROD_PARTNER_PASSWORD_RESET=<slug>:<usuario>.
//   A senha pode vir de PARTNER_NEW_PASSWORD; sem ela, uma senha forte é gerada.
//
// Sem --password, gera uma senha forte legível e a exibe UMA vez.
// ─────────────────────────────────────────────────────────────────────────────
const crypto = require('node:crypto');
const { Client } = require('pg');

const SCRYPT_KEYLEN = 64;
const SCRYPT_PARAMS = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS);
  return `scrypt:${salt.toString('hex')}:${derived.toString('hex')}`;
}

function genPassword() {
  const alpha = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz';
  const digits = '23456789';
  const pick = (set, n) => Array.from({ length: n }, () => set[crypto.randomInt(set.length)]).join('');
  return `${pick(alpha, 4)}-${pick(alpha, 4)}-${pick(digits, 3)}`;
}

function parseArgs() {
  const out = {};
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

async function main() {
  const args = parseArgs();
  const slug = args.slug;
  const env = args.env || process.env.FAREJADOR_ENV;
  const username = (args.username || '').trim();
  const password = process.env.PARTNER_NEW_PASSWORD || args.password || genPassword();
  const COMMIT = process.env.COMMIT === '1';

  if (!slug || !username) {
    console.error('Faltou --slug e/ou --username. Ex: --slug=zz-teste-meier --username=wallace');
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
  if (
    COMMIT
    && env === 'prod'
    && process.env.ALLOW_PROD_PARTNER_PASSWORD_RESET !== `${slug}:${username.toLowerCase()}`
  ) {
    console.error(`Produção bloqueada. Informe ALLOW_PROD_PARTNER_PASSWORD_RESET=${slug}:${username.toLowerCase()}.`);
    process.exit(2);
  }
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL ausente (use --env-file=.env).');
    process.exit(2);
  }

  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  try {
    const u = await c.query(
      `SELECT id, display_name, status FROM network.partner_units
        WHERE environment = $1 AND slug = $2 AND deleted_at IS NULL`,
      [env, slug],
    );
    if (u.rowCount === 0) { console.error(`Unidade não encontrada: env=${env} slug=${slug}`); process.exit(1); }
    const unit = u.rows[0];

    const tok = await c.query(
      `SELECT id, role, login_password_set_at FROM network.partner_access_tokens
        WHERE environment = $1 AND partner_unit_id = $2
          AND lower(login_username) = lower($3) AND revoked_at IS NULL
        ORDER BY created_at DESC`,
      [env, unit.id, username],
    );
    if (tok.rowCount === 0) { console.error(`Nenhum login ATIVO "${username}" nessa unidade. (Crie com criar-login-dono.cjs.)`); process.exit(1); }
    if (tok.rowCount > 1) { console.warn(`⚠ ${tok.rowCount} logins ativos "${username}" — vou resetar TODOS.`); }

    console.log(`Unidade: ${unit.display_name} (${unit.id}) env=${env} status=${unit.status}`);
    console.log(`Login(s) a resetar: usuário="${username}" — ${tok.rowCount} token(s) [role=${tok.rows[0].role}, senha setada em ${tok.rows[0].login_password_set_at}]`);

    if (!COMMIT) {
      console.log('\n*** DRY-RUN — nada alterado. Rode com COMMIT=1 pra gravar a nova senha. ***');
      return;
    }

    const passwordHash = hashPassword(password);
    const upd = await c.query(
      `UPDATE network.partner_access_tokens
          SET login_password_hash = $4, login_password_set_at = now()
        WHERE environment = $1 AND partner_unit_id = $2
          AND lower(login_username) = lower($3) AND revoked_at IS NULL
        RETURNING id`,
      [env, unit.id, username, passwordHash],
    );

    console.log('\n=== SENHA RESETADA (anote — não será exibida de novo) ===');
    console.log(`  URL:     /parceiro/${slug}/`);
    console.log(`  usuário: ${username}`);
    console.log(`  senha:   ${password}`);
    console.log(`  tokens:  ${upd.rowCount} atualizado(s)`);
    console.log('=========================================================');
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error('Erro:', e.message); process.exit(1); });
