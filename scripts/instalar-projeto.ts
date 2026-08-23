/**
 * INSTALADOR — leva um projeto Supabase VAZIO até "zero km" do Farejador.
 *
 * Existe porque a planta (db/migrations) sozinha não basta: três coisas ficam
 * de fora dela de propósito e, sem elas, a instalação quebra ou nasce muda —
 * foi exatamente o que apanhamos na virada de 2026-08-23:
 *
 *   1. `pg_cron` — nenhuma migration cria a extensão, mas a 0096 e a 0201
 *      chamam `cron.schedule`. Sem ligar antes, a construção falha no meio.
 *   2. `farejador_partner_app` — a role restrita do portal do parceiro.
 *      NENHUMA migration a cria e 89 dão GRANT pra ela. É a trava que impede
 *      o parceiro de enxergar o galpão da matriz.
 *   3. Dicionário regional — bairros e modelos são da REGIÃO do cliente,
 *      não iguais pra todo mundo (ver db/seeds/regiao-*.sql).
 *
 * Uso:
 *   npx tsx --env-file=.env.novo scripts/instalar-projeto.ts --confirmo
 *
 * `--local` = ensaio num Postgres vazio de laboratório (Docker), onde não há
 * pg_cron de verdade: pula a extensão e manda o replay usar o agendador de
 * mentira. NÃO precisa de disciplina pra usar direito — o próprio
 * replay-migrations recusa `--bootstrap-local` fora de loopback.
 *
 * Variáveis lidas do ambiente:
 *   DATABASE_URL         (obrigatória)  destino, como `postgres`
 *   PARTNER_DB_PASSWORD  (obrigatória)  senha da role restrita do parceiro
 *   SEED_REGIAO          (opcional)     ex.: rio-de-janeiro
 *   OWNER_USERNAME       (opcional)     usuário do dono
 *   OWNER_PASSWORD       (opcional)     senha do dono
 *   OWNER_NOME           (opcional)     nome exibido (padrão: o username)
 *   FAREJADOR_ENV        (opcional)     prod (padrão) | test
 *
 * Seguro por desenho: recusa banco que já tenha o Farejador instalado, e a
 * senha nunca é impressa.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { hashPassword } from '../src/parceiro/password.js';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const url = process.env.DATABASE_URL;
const senhaParceiro = process.env.PARTNER_DB_PASSWORD;
const regiao = process.env.SEED_REGIAO?.trim();
const donoUsuario = process.env.OWNER_USERNAME?.trim();
const donoSenha = process.env.OWNER_PASSWORD;
const donoNome = process.env.OWNER_NOME?.trim() || donoUsuario;
const ambiente = (process.env.FAREJADOR_ENV?.trim() || 'prod') as 'prod' | 'test';

function aborta(mensagem: string): never {
  console.error(`ERRO: ${mensagem}`);
  process.exit(1);
}

if (!process.argv.includes('--confirmo')) {
  aborta('rode com --confirmo (o instalador escreve no banco de destino)');
}
if (!url) aborta('DATABASE_URL ausente');
if (!senhaParceiro || senhaParceiro.length < 12) {
  aborta('PARTNER_DB_PASSWORD ausente ou curta demais (mínimo 12 caracteres)');
}
if (donoUsuario && (!donoSenha || donoSenha.length < 8)) {
  aborta('OWNER_USERNAME informado mas OWNER_PASSWORD ausente ou curta (mínimo 8)');
}

const modoLocal = process.argv.includes('--local');
const passos: string[] = [];

async function main(): Promise<void> {
  const client = new pg.Client({
    connectionString: url,
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  });
  await client.connect();

  try {
    const jaTem = await client.query<{ instalado: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM pg_namespace WHERE nspname = 'commerce'
      ) AS instalado
    `);
    if (jaTem.rows[0]?.instalado) {
      aborta('o banco de destino JÁ tem o Farejador instalado — este script só roda em banco vazio');
    }

    // 1) extensão que as migrations não criam
    if (modoLocal) {
      passos.push('pg_cron PULADA (ensaio local — agendador de mentira)');
    } else {
      await client.query('CREATE EXTENSION IF NOT EXISTS pg_cron');
      passos.push('pg_cron ligada');
    }

    // 2) role restrita do parceiro, com o perfil exato da produção
    const literal = `'${senhaParceiro!.replace(/'/g, "''")}'`;
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'farejador_partner_app') THEN
          CREATE ROLE farejador_partner_app LOGIN PASSWORD ${literal}
            NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION;
        END IF;
      END $$;
    `);
    const perfil = await client.query<{ ok: boolean }>(`
      SELECT (rolcanlogin AND NOT rolsuper AND NOT rolbypassrls AND NOT rolinherit) AS ok
        FROM pg_roles WHERE rolname = 'farejador_partner_app'
    `);
    if (!perfil.rows[0]?.ok) aborta('role do parceiro nasceu com perfil errado');
    passos.push('role farejador_partner_app criada (NOBYPASSRLS, NOINHERIT)');
  } finally {
    await client.end();
  }

  // 3) as migrations, numa transação única (script próprio, já provado)
  const argsReplay = [path.join(raiz, 'scripts', 'replay-migrations.cjs'), '--commit'];
  if (modoLocal) argsReplay.push('--bootstrap-local');
  execFileSync(process.execPath, argsReplay, { stdio: 'inherit', env: process.env, cwd: raiz });
  passos.push('migrations aplicadas');

  const client2 = new pg.Client({
    connectionString: url,
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  });
  await client2.connect();
  try {
    // 4) dicionário da região (opcional)
    if (regiao) {
      const arquivo = path.join(raiz, 'db', 'seeds', `regiao-${regiao}.sql`);
      if (!existsSync(arquivo)) aborta(`semente não encontrada: db/seeds/regiao-${regiao}.sql`);
      await client2.query(readFileSync(arquivo, 'utf8'));
      const n = await client2.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM commerce.geo_resolutions WHERE environment = $1`,
        [ambiente],
      );
      passos.push(`semente ${regiao} carregada (${n.rows[0]?.n} bairros)`);
    }

    // 5) conta do dono (opcional): pessoa + colaborador com papel de painel
    if (donoUsuario && donoSenha) {
      const hash = await hashPassword(donoSenha);
      await client2.query('BEGIN');
      const pessoa = await client2.query<{ id: string }>(
        `INSERT INTO network.partner_people (environment, username, password_hash, password_set_at)
         VALUES ($1, $2, $3, now()) RETURNING id`,
        [ambiente, donoUsuario, hash],
      );
      await client2.query(
        `INSERT INTO network.matriz_collaborators
           (environment, person_id, display_name, job, panel_role, job_title, work_area, created_by)
         VALUES ($1, $2, $3, 'colaborador', 'owner', 'Proprietário', 'administrative', 'instalador')`,
        [ambiente, pessoa.rows[0]!.id, donoNome],
      );
      await client2.query('COMMIT');
      passos.push(`conta de dono criada: ${donoUsuario} (papel owner)`);
    }
  } catch (erro) {
    await client2.query('ROLLBACK').catch(() => undefined);
    throw erro;
  } finally {
    await client2.end();
  }

  console.log('\nINSTALADO:');
  for (const p of passos) console.log(`  - ${p}`);
  if (!donoUsuario) console.log('  (sem conta de dono — informe OWNER_USERNAME/OWNER_PASSWORD)');
}

main().catch((erro: unknown) => {
  console.error(`ERRO: ${erro instanceof Error ? erro.message : String(erro)}`);
  process.exit(1);
});
