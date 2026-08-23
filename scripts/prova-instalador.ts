/**
 * PROVA do instalador — confere que um banco recém-instalado por
 * `scripts/instalar-projeto.ts` nasceu utilizável, não só "sem erro".
 *
 * Roda contra o banco que acabou de ser instalado:
 *   npx tsx --env-file=<env> scripts/prova-instalador.ts
 *
 * Lê as MESMAS variáveis do instalador (OWNER_USERNAME/OWNER_PASSWORD), porque
 * a checagem mais importante é justamente "a conta criada consegue entrar".
 * Só leitura: não escreve nada.
 */

import pg from 'pg';
import { verifyPassword } from '../src/parceiro/password.js';
import { auditPartnerGrants } from './grants-parceiro-contract.js';

const ambiente = (process.env.FAREJADOR_ENV?.trim() || 'prod') as 'prod' | 'test';
const donoUsuario = process.env.OWNER_USERNAME?.trim();
const donoSenha = process.env.OWNER_PASSWORD;

let passou = 0;
let falhou = 0;

function checa(nome: string, condicao: boolean, detalhe = ''): void {
  if (condicao) {
    passou += 1;
    console.log(`  OK   ${nome}${detalhe ? ' — ' + detalhe : ''}`);
  } else {
    falhou += 1;
    console.log(`  FALHA ${nome}${detalhe ? ' — ' + detalhe : ''}`);
  }
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL ausente');

  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  });
  await client.connect();

  try {
    console.log('ESTRUTURA');
    const tabelas = await client.query<{ n: string }>(`
      SELECT count(*)::text AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind IN ('r','p') AND NOT c.relispartition
         AND n.nspname IN ('raw','core','analytics','ops','commerce','agent','network','finance','audit','dashboard','marketing')
    `);
    checa('tabelas criadas', Number(tabelas.rows[0]!.n) >= 150, `${tabelas.rows[0]!.n} tabelas`);

    const grants = await auditPartnerGrants(client);
    checa('role do parceiro com perfil restrito', grants.roleSafe,
      grants.roleViolations.join(', '));
    checa('baseline de permissões é íntegro', grants.baselineValid,
      grants.expectedSha256);
    checa('parceiro tem exatamente os grants aprovados',
      grants.actualCount === grants.expectedCount
        && grants.actualSha256 === grants.expectedSha256
        && grants.missingGrants.length === 0
        && grants.unexpectedGrants.length === 0,
      `${grants.actualCount}/${grants.expectedCount}; hash ${grants.actualSha256}`);
    if (grants.missingGrants.length > 0) {
      console.log(`    ausentes: ${grants.missingGrants.join(', ')}`);
    }
    if (grants.unexpectedGrants.length > 0) {
      console.log(`    inesperados: ${grants.unexpectedGrants.join(', ')}`);
    }
    checa('parceiro NÃO acessa dados exclusivos da Matriz',
      grants.sensitivePrivileges.length === 0,
      grants.sensitivePrivileges.map((item) =>
        `${item.relation}:${item.scope}:${item.privilege}`).join(', '));

    console.log('\nDICIONÁRIO');
    const bairros = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM commerce.geo_resolutions WHERE environment = $1`, [ambiente]);
    checa('bairros carregados', Number(bairros.rows[0]!.n) > 0, `${bairros.rows[0]!.n} bairros`);

    if (Number(bairros.rows[0]!.n) > 0) {
      const resolve = await client.query<{ cidade: string | null }>(
        `SELECT city_name AS cidade FROM commerce.resolve_neighborhood($1, $2, NULL) LIMIT 1`,
        [ambiente, 'Santa Cruz']);
      checa('motor resolve bairro → cidade', !!resolve.rows[0]?.cidade, `Santa Cruz → ${resolve.rows[0]?.cidade}`);
    }

    console.log('\nDADO DE NEGÓCIO (tem que estar ZERADO)');
    for (const tabela of ['commerce.orders', 'core.conversations', 'network.partner_units', 'commerce.wholesale_stock']) {
      const r = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${tabela}`);
      checa(`${tabela} vazia`, r.rows[0]!.n === '0', `${r.rows[0]!.n} linhas`);
    }

    console.log('\nCONTA DO DONO');
    if (!donoUsuario || !donoSenha) {
      console.log('  (pulado — sem OWNER_USERNAME/OWNER_PASSWORD no ambiente)');
    } else {
      const login = await client.query<{
        password_hash: string; collaborator_id: string | null; panel_role: string | null; display_name: string | null;
      }>(
        `SELECT pp.password_hash, mc.id AS collaborator_id, mc.panel_role, mc.display_name
           FROM network.partner_people pp
           LEFT JOIN network.matriz_collaborators mc
             ON mc.person_id = pp.id AND mc.environment = pp.environment
            AND mc.revoked_at IS NULL AND mc.panel_role IS NOT NULL
          WHERE pp.environment = $1 AND lower(pp.username) = lower($2)
            AND pp.revoked_at IS NULL AND pp.password_hash IS NOT NULL
          LIMIT 1`,
        [ambiente, donoUsuario]);

      const linha = login.rows[0];
      checa('conta existe e tem senha', !!linha);
      if (linha) {
        checa('hash no formato da casa', linha.password_hash.startsWith('scrypt:'));
        checa('senha CERTA é aceita', await verifyPassword(donoSenha, linha.password_hash));
        checa('senha ERRADA é recusada', !(await verifyPassword(donoSenha + 'x', linha.password_hash)));
        checa('tem papel de painel (senão o login devolve null)',
          !!linha.collaborator_id && !!linha.panel_role && !!linha.display_name,
          `${linha.panel_role} / ${linha.display_name}`);
      }
    }
  } finally {
    await client.end();
  }

  console.log(`\nPLACAR: ${passou} passaram, ${falhou} falharam`);
  if (falhou > 0) process.exit(1);
}

main().catch((erro: unknown) => {
  console.error(`ERRO: ${erro instanceof Error ? erro.message : String(erro)}`);
  process.exit(1);
});
