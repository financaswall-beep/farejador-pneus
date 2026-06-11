/**
 * PROVA da porta única de login (0095) no env TEST — ponta a ponta com banco real.
 *
 * Rodar: npx tsx --env-file=.env scripts/prova-porta-unica-test.ts
 * (o .env do projeto tem FAREJADOR_ENV=test; a prova RECUSA rodar fora do test)
 *
 * Cria dados PRÓPRIOS (pessoa prova.porta.unica + 2 vínculos em unidades ativas
 * do env test) e LIMPA TUDO no finally — não deixa rastro.
 */
import { randomBytes } from 'node:crypto';
import { pool } from '../src/persistence/db.js';
import { env } from '../src/shared/config/env.js';
import { hashPassword } from '../src/parceiro/password.js';
import { authenticatePersonGlobal } from '../src/parceiro/people.js';
import { consumeLoginTicket, newLoginTicket } from '../src/parceiro/login-ticket.js';
import { mintPartnerSession } from '../src/parceiro/queries.js';
import { authenticatePartnerSession } from '../src/parceiro/auth.js';

const USERNAME = 'prova.porta.unica';
const PASSWORD = 'senha-prova-' + randomBytes(4).toString('hex');

let fail = 0;
function check(nome: string, cond: boolean, extra?: unknown): void {
  console.log(`${cond ? '✅' : '❌'} ${nome}${extra !== undefined ? ' — ' + JSON.stringify(extra) : ''}`);
  if (!cond) fail++;
}

async function main(): Promise<void> {
  if (env.FAREJADOR_ENV !== 'test') {
    throw new Error('Esta prova só roda no env test (rode com --env-file=.env, que tem FAREJADOR_ENV=test).');
  }

  const units = await pool.query<{ id: string; slug: string }>(
    `SELECT pu.id, pu.slug
       FROM network.partner_units pu
       JOIN network.partners p ON p.id = pu.partner_id AND p.environment = pu.environment
      WHERE pu.environment = 'test' AND pu.status = 'active' AND p.status = 'active'
        AND pu.deleted_at IS NULL AND p.deleted_at IS NULL
      ORDER BY pu.created_at ASC
      LIMIT 2`,
  );
  if ((units.rowCount ?? 0) < 2) {
    throw new Error('A prova precisa de 2 unidades ativas no env test.');
  }
  const [unitA, unitB] = units.rows as [{ id: string; slug: string }, { id: string; slug: string }];

  const tokenIds: string[] = [];
  const personIds: string[] = [];

  try {
    // ── Setup: a pessoa + 2 vínculos (funcionário nas duas unidades) ──
    const hash = await hashPassword(PASSWORD);
    const person = await pool.query<{ id: string }>(
      `INSERT INTO network.partner_people (environment, username, password_hash, password_set_at)
       VALUES ('test', $1, $2, now()) RETURNING id`,
      [USERNAME, hash],
    );
    const personId = person.rows[0]!.id;
    personIds.push(personId);

    for (const unit of [unitA, unitB]) {
      const token = await pool.query<{ id: string }>(
        `INSERT INTO network.partner_access_tokens
           (environment, partner_unit_id, token_hash, label, created_by, role,
            login_username, login_password_hash, login_password_set_at, person_id)
         VALUES ('test', $1, network.hash_partner_token($2), 'prova-porta-unica', 'prova', 'funcionario',
                 $3, $4, now(), $5)
         RETURNING id`,
        [unit.id, randomBytes(32).toString('hex'), USERNAME, hash, personId],
      );
      tokenIds.push(token.rows[0]!.id);
    }

    // ── 1. Login global acha a pessoa e lista as lojas DELA ──
    const auth = await authenticatePersonGlobal('test', USERNAME, PASSWORD);
    check('login global autentica a pessoa', auth !== null);
    check('lista exatamente as 2 lojas', auth?.stores.length === 2, auth?.stores.map((s) => s.slug));

    // ── 2. Respostas de falha são iguais (anti-enumeração) ──
    check('senha errada → null', (await authenticatePersonGlobal('test', USERNAME, 'senha-errada-123')) === null);
    check('usuário inexistente → null', (await authenticatePersonGlobal('test', `nao.existe.${Date.now()}`, PASSWORD)) === null);

    // ── 3. Unicidade global do username (case-insensitive, índice lower()) ──
    let conflito = false;
    try {
      await pool.query(
        `INSERT INTO network.partner_people (environment, username, password_hash) VALUES ('test', $1, $2)`,
        [USERNAME.toUpperCase(), hash],
      );
    } catch (e) {
      conflito = (e as { code?: string }).code === '23505';
    }
    check('username é único na rede (até trocando maiúsculas)', conflito);

    // ── 4. Ticket → sessão da loja ESCOLHIDA → o painel valida ──
    const ticket = newLoginTicket('test', auth!.personId, auth!.stores);
    const data = consumeLoginTicket(ticket);
    check('ticket consome com as lojas dentro', data !== null && data.stores.length === 2);
    check('ticket é uso único', consumeLoginTicket(ticket) === null);

    const escolhida = data!.stores.find((s) => s.slug === unitB.slug)!;
    const session = await mintPartnerSession('test', escolhida.token_id);
    const ctx = await authenticatePartnerSession(escolhida.slug, session.session_token);
    check('sessão vale no painel da loja escolhida', ctx !== null && ctx.slug === unitB.slug, { slug: ctx?.slug, role: ctx?.role });

    const ctxOutraLoja = await authenticatePartnerSession(unitA.slug, session.session_token);
    check('a MESMA sessão NÃO vale na outra loja', ctxOutraLoja === null);

    // ── 5. Vínculo revogado some da porta única ──
    await pool.query(`UPDATE network.partner_access_tokens SET revoked_at = now() WHERE id = $1`, [tokenIds[1]]);
    const auth2 = await authenticatePersonGlobal('test', USERNAME, PASSWORD);
    check('vínculo revogado some (sobra 1 loja)', auth2?.stores.length === 1, auth2?.stores.map((s) => s.slug));
  } finally {
    // ── Cleanup: sessões → vínculos → pessoa (ordem das FKs) ──
    if (tokenIds.length) {
      await pool.query(`DELETE FROM network.partner_sessions WHERE token_id = ANY($1::uuid[])`, [tokenIds]);
      await pool.query(`DELETE FROM network.partner_access_tokens WHERE id = ANY($1::uuid[])`, [tokenIds]);
    }
    if (personIds.length) {
      await pool.query(`DELETE FROM network.partner_people WHERE id = ANY($1::uuid[])`, [personIds]);
    }
    await pool.end();
  }

  console.log(fail === 0 ? '\n🎉 PROVA PORTA ÚNICA: tudo verde' : `\n❌ ${fail} checagem(ns) falharam`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('ERRO:', e);
  process.exit(1);
});
