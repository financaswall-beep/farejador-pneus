/**
 * Cria (ou repõe) uma conta de DONO num banco JÁ instalado.
 *
 * Serve pra dois momentos:
 *   - depois de instalar, quando a conta não foi criada junto;
 *   - resgate: ninguém mais consegue entrar no painel da matriz.
 *
 * Cuidado que motiva este script: no painel da MATRIZ não basta existir em
 * `network.partner_people`. O login (authenticateMatrizAdmin) exige TAMBÉM um
 * `network.matriz_collaborators` com `panel_role` e `display_name` — sem isso
 * ele devolve null mesmo com a senha certa. Este script cria os dois, juntos,
 * na mesma transação.
 *
 * Uso:
 *   npx tsx --env-file=.env.novo scripts/criar-conta-dono.ts <usuario> [Nome Exibido]
 *
 * A senha vem de OWNER_PASSWORD no ambiente — nunca por argumento (argumento
 * fica no histórico do terminal e na lista de processos).
 */

import pg from 'pg';
import { hashPassword, verifyPassword } from '../src/parceiro/password.js';

const ambiente = (process.env.FAREJADOR_ENV?.trim() || 'prod') as 'prod' | 'test';
const usuario = (process.argv[2] || '').trim();
const nomeExibido = (process.argv[3] || '').trim() || usuario;
const senha = process.env.OWNER_PASSWORD;

function aborta(mensagem: string): never {
  console.error(`ERRO: ${mensagem}`);
  process.exit(1);
}

if (!usuario) aborta('uso: scripts/criar-conta-dono.ts <usuario> [Nome Exibido]');
if (!process.env.DATABASE_URL) aborta('DATABASE_URL ausente');
if (!senha || senha.length < 8) aborta('OWNER_PASSWORD ausente no ambiente ou com menos de 8 caracteres');

async function main(): Promise<void> {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  });
  await client.connect();

  try {
    const existe = await client.query<{ id: string }>(
      `SELECT id FROM network.partner_people
        WHERE environment = $1 AND lower(username) = lower($2)`,
      [ambiente, usuario],
    );
    if (existe.rowCount && existe.rowCount > 0) {
      aborta(`o usuário "${usuario}" já existe neste banco — escolha outro nome`);
    }

    await client.query('BEGIN');
    const pessoa = await client.query<{ id: string }>(
      `INSERT INTO network.partner_people (environment, username, password_hash, password_set_at)
       VALUES ($1, $2, $3, now()) RETURNING id`,
      [ambiente, usuario, await hashPassword(senha!)],
    );
    await client.query(
      `INSERT INTO network.matriz_collaborators
         (environment, person_id, display_name, job, panel_role, job_title, work_area, created_by)
       VALUES ($1, $2, $3, 'colaborador', 'owner', 'Proprietário', 'administrative', 'criar-conta-dono')`,
      [ambiente, pessoa.rows[0]!.id, nomeExibido],
    );
    await client.query('COMMIT');

    // Prova pelo MESMO caminho do login do painel — não basta ter gravado.
    const login = await client.query<{ password_hash: string; panel_role: string | null; display_name: string | null }>(
      `SELECT pp.password_hash, mc.panel_role, mc.display_name
         FROM network.partner_people pp
         LEFT JOIN network.matriz_collaborators mc
           ON mc.person_id = pp.id AND mc.environment = pp.environment
          AND mc.revoked_at IS NULL AND mc.panel_role IS NOT NULL
        WHERE pp.environment = $1 AND lower(pp.username) = lower($2)
          AND pp.revoked_at IS NULL AND pp.password_hash IS NOT NULL
        LIMIT 1`,
      [ambiente, usuario],
    );
    const linha = login.rows[0];
    if (!linha) aborta('gravou mas o login não encontra a conta');
    if (!(await verifyPassword(senha!, linha.password_hash))) aborta('gravou mas a senha não confere');
    if (await verifyPassword(senha! + 'x', linha.password_hash)) aborta('senha errada foi aceita');
    if (!linha.panel_role || !linha.display_name) aborta('conta sem papel de painel — o login devolveria null');

    console.log(`OK: conta "${usuario}" criada e PROVADA`);
    console.log(`    papel: ${linha.panel_role} | nome: ${linha.display_name} | ambiente: ${ambiente}`);
    console.log('    senha certa entra, senha errada é recusada.');
  } catch (erro) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw erro;
  } finally {
    await client.end();
  }
}

main().catch((erro: unknown) => {
  console.error(`ERRO: ${erro instanceof Error ? erro.message : String(erro)}`);
  process.exit(1);
});
