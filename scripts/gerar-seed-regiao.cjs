'use strict';

/**
 * Gera o arquivo de SEMENTE de uma região a partir de um banco que já a tenha.
 *
 * Por que existe: o dicionário de bairros é REGIONAL (624 bairros do Rio não
 * servem pra um cliente de Belo Horizonte), então ele NÃO entra nas migrations
 * — que são iguais pra todo mundo. Fica como semente escolhida na instalação.
 *
 * O SQL é montado pelo próprio Postgres (quote_nullable), então acento, aspas,
 * array e nulo saem escapados corretamente — nada de escapar na mão.
 *
 * Uso:
 *   node --env-file=.env.novo scripts/gerar-seed-regiao.cjs rio-de-janeiro
 *
 * Saída: db/seeds/regiao-<nome>.sql  (idempotente: ON CONFLICT DO NOTHING)
 */

const { writeFileSync, mkdirSync } = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

const raiz = path.resolve(__dirname, '..');
const nomeRegiao = (process.argv[2] || '').trim();
const ambiente = process.env.SEED_ENV || 'prod';

if (!nomeRegiao || !/^[a-z0-9-]+$/.test(nomeRegiao)) {
  console.error('Uso: node --env-file=<env> scripts/gerar-seed-regiao.cjs <nome-da-regiao>');
  console.error('  (nome só com minúsculas, números e hífen — vira nome de arquivo)');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL ausente.');
  process.exit(1);
}

/** Tabelas que compõem o dicionário regional, na ordem de dependência. */
const TABELAS = [
  { sch: 'commerce', tab: 'geo_resolutions', porAmbiente: true },
  { sch: 'commerce', tab: 'vehicle_models', porAmbiente: true },
];

const aspas = (s) => '"' + s.replace(/"/g, '""') + '"';

async function colunasDe(client, sch, tab) {
  const r = await client.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2
        AND is_generated = 'NEVER' AND identity_generation IS NULL
      ORDER BY ordinal_position`,
    [sch, tab],
  );
  if (r.rows.length === 0) throw new Error(`tabela ${sch}.${tab} não existe na origem`);
  return r.rows.map((x) => x.column_name);
}

async function linhasInsert(client, { sch, tab, porAmbiente }) {
  const cols = await colunasDe(client, sch, tab);
  const lista = cols.map(aspas).join(', ');
  // O Postgres escapa cada valor: quote_nullable devolve 'texto' ou NULL.
  const valores = cols.map((c) => `quote_nullable(${aspas(c)}::text)`).join(` || ',' || `);
  const filtro = porAmbiente ? `WHERE environment = $1` : '';
  const params = porAmbiente ? [ambiente] : [];

  const sql = `
    SELECT 'INSERT INTO ${aspas(sch)}.${aspas(tab)} (${lista}) VALUES ('
           || ${valores}
           || ') ON CONFLICT DO NOTHING;' AS linha
      FROM ${aspas(sch)}.${aspas(tab)} ${filtro}
     ORDER BY 1`;

  const r = await client.query(sql, params);
  return r.rows.map((x) => x.linha);
}

async function main() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  });
  await client.connect();

  const partes = [];
  const placar = [];
  try {
    for (const alvo of TABELAS) {
      const linhas = await linhasInsert(client, alvo);
      partes.push(`-- ${alvo.sch}.${alvo.tab} (${linhas.length} linhas)`);
      partes.push(...linhas, '');
      placar.push(`${alvo.sch}.${alvo.tab}: ${linhas.length}`);
    }
  } finally {
    await client.end();
  }

  const cabecalho = [
    `-- Semente regional: ${nomeRegiao}`,
    `-- Gerada por scripts/gerar-seed-regiao.cjs em ${new Date().toISOString().slice(0, 10)}.`,
    '--',
    '-- NÃO é migration: migrations são iguais pra todo cliente, esta semente é',
    '-- da REGIÃO onde o cliente opera. Rode uma vez, na instalação.',
    '-- Idempotente (ON CONFLICT DO NOTHING) — rodar de novo não duplica.',
    '',
    'BEGIN;',
    '',
  ].join('\n');

  const destino = path.join(raiz, 'db', 'seeds', `regiao-${nomeRegiao}.sql`);
  mkdirSync(path.dirname(destino), { recursive: true });
  writeFileSync(destino, cabecalho + partes.join('\n') + '\nCOMMIT;\n', 'utf8');

  console.log(`OK: db/seeds/regiao-${nomeRegiao}.sql`);
  placar.forEach((l) => console.log('  ' + l));
}

main().catch((erro) => {
  console.error(`ERRO: ${erro.message}`);
  process.exit(1);
});
