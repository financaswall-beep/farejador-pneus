/**
 * PROVA de INTEGRAÇÃO — PESQUISA DE SATISFAÇÃO cobrindo a ENTREGA DA MATRIZ (0131)
 * + NOTA no score da Rede, no env `test`, chamando o CÓDIGO REAL
 * (dispatchMatrizDeliverySurveys + tryCaptureSurveyReply + getPainelRede). Blinda:
 *   entrega da matriz (unit main, delivered) recém-finalizada gera UMA pesquisa
 *   (order_id preenchido, partner_order_id NULL) · dedup: rodar 2x não duplica ·
 *   captura da nota por conversation_id serve o trilho da matriz (pending→answered) ·
 *   captura 2x não regrava · entrega NÃO-delivered não dispara · pedido de PARCEIRO
 *   não entra no trilho da matriz (só unit main) · getPainelRede traz
 *   satisfaction_avg/count por unidade (média das answered) — base do score.
 *
 * sendMessage sai na hora em test (Chatwoot não configurado) — não trava a prova.
 * Seeds descartáveis (marcador 'PROVA-SAT') e LIMPA tudo no finally (DELETE físico,
 * na ordem das FKs). Não usa transação: o dispatch roda no pool global (precisa ver
 * os dados commitados).
 *
 * USO:
 *   npx tsx --env-file=.env.pooler scripts/prova-satisfacao-matriz-test.ts
 */

// Flag LIGADA antes de qualquer import que leia `env` (parse no 1º import).
process.env.SATISFACTION_SURVEY = 'true';

const ENV = 'test' as const;
const MARK = 'PROVA-SAT';

async function main(): Promise<void> {
  const { pool } = await import('../src/persistence/db.js');
  const { env } = await import('../src/shared/config/env.js');
  const { dispatchMatrizDeliverySurveys, tryCaptureSurveyReply } = await import('../src/atendente-v2/satisfaction.js');
  const { getPainelRede } = await import('../src/admin/painel/queries.js');

  if (env.FAREJADOR_ENV !== 'test') throw new Error('ABORTADO: só roda em test.');
  console.log('=== PROVA SATISFAÇÃO DA MATRIZ (0131) + NOTA NO SCORE (test) ===');

  const client = await pool.connect();
  let fails = 0;
  const check = (name: string, ok: boolean, extra = ''): void => {
    if (!ok) fails++;
    console.log(`  [${ok ? 'OK ' : 'XX '}] ${name}${extra ? ' — ' + extra : ''}`);
  };

  let mainUnitId = '';
  let partnerUnitId = '';
  let contactId = '';
  let convId = '';
  const convChatwoot = 1_900_000_000 + (Date.now() % 90_000_000);
  const orderIds: string[] = [];
  let partnerSurveyId = '';

  const limpar = async (): Promise<void> => {
    await client.query(`DELETE FROM commerce.satisfaction_surveys WHERE order_id = ANY($1::uuid[])`, [orderIds.length ? orderIds : ['00000000-0000-0000-0000-000000000000']]);
    if (partnerSurveyId) await client.query(`DELETE FROM commerce.satisfaction_surveys WHERE id=$1`, [partnerSurveyId]);
    if (orderIds.length) await client.query(`DELETE FROM commerce.orders WHERE id = ANY($1::uuid[])`, [orderIds]);
    if (convId) await client.query(`DELETE FROM core.conversations WHERE id=$1`, [convId]);
    if (contactId) await client.query(`DELETE FROM core.contacts WHERE id=$1`, [contactId]);
  };

  const seedOrder = async (opts: { unitId: string; mode: 'delivery' | 'pickup'; deliveryStatus: string; status: string; delivered: boolean }): Promise<string> => {
    const o = await client.query<{ id: string }>(
      `INSERT INTO commerce.orders
         (environment, contact_id, unit_id, source_conversation_id, total_amount,
          status, fulfillment_mode, delivery_status, delivery_address, delivered_at)
       VALUES ($1::env_t, $2, $3, $4, 120, $5, $6, $7, $8, CASE WHEN $9 THEN now() ELSE NULL END)
       RETURNING id`,
      [ENV, contactId, opts.unitId, convId, opts.status, opts.mode, opts.deliveryStatus,
       opts.mode === 'delivery' ? 'Rua PROVA-SAT, 1 - Centro - Rio' : null, opts.delivered]);
    orderIds.push(o.rows[0]!.id);
    return o.rows[0]!.id;
  };

  try {
    await limpar();

    // ── setup: unit main + unit parceiro + contato + conversa ──
    mainUnitId = (await client.query<{ id: string }>(`SELECT id FROM core.units WHERE environment=$1 AND slug='main'`, [ENV])).rows[0]!.id;
    partnerUnitId = (await client.query<{ unit_id: string }>(`SELECT unit_id FROM network.partner_units WHERE environment=$1 AND slug='fake-rede-a'`, [ENV])).rows[0]!.unit_id;
    const c = await client.query<{ id: string }>(
      `INSERT INTO core.contacts (environment, chatwoot_contact_id, name, phone_e164)
       VALUES ($1::env_t, $2, '${MARK} contato', '+5521955550000') RETURNING id`, [ENV, convChatwoot]);
    contactId = c.rows[0]!.id;
    const cv = await client.query<{ id: string }>(
      `INSERT INTO core.conversations (environment, chatwoot_conversation_id, chatwoot_account_id, current_status, started_at, contact_id)
       VALUES ($1::env_t, $2, 1, 'open', now(), $3) RETURNING id`, [ENV, convChatwoot, contactId]);
    convId = cv.rows[0]!.id;
    check('setup: unit main + parceiro + contato + conversa', !!mainUnitId && !!partnerUnitId && !!contactId && !!convId);

    // ── 1. entrega da matriz ENTREGUE → dispara UMA pesquisa ──
    const oMatriz = await seedOrder({ unitId: mainUnitId, mode: 'delivery', deliveryStatus: 'delivered', status: 'delivered', delivered: true });
    await dispatchMatrizDeliverySurveys();
    const s1 = await client.query<{ id: string; unit_id: string; order_id: string; partner_order_id: string | null; fulfillment_mode: string; status: string }>(
      `SELECT id, unit_id, order_id, partner_order_id, fulfillment_mode, status FROM commerce.satisfaction_surveys WHERE order_id=$1`, [oMatriz]);
    check('1. entrega da matriz gerou 1 pesquisa pending (order_id, sem partner_order_id, unit main)',
      s1.rowCount === 1 && s1.rows[0]!.status === 'pending' && s1.rows[0]!.partner_order_id === null &&
      s1.rows[0]!.unit_id === mainUnitId && s1.rows[0]!.fulfillment_mode === 'delivery', JSON.stringify(s1.rows[0]));

    // ── 2. dedup: rodar de novo NÃO duplica ──
    await dispatchMatrizDeliverySurveys();
    const s2 = await client.query(`SELECT count(*)::int AS n FROM commerce.satisfaction_surveys WHERE order_id=$1`, [oMatriz]);
    check('2. rodar o disparo 2x não duplica (índice único da matriz)', s2.rows[0]!.n === 1);

    // ── 3. captura da nota por conversation_id (serve o trilho da matriz) ──
    const cap = await tryCaptureSurveyReply(client, ENV, convChatwoot, '5');
    const s3 = await client.query<{ status: string; rating: number }>(`SELECT status, rating FROM commerce.satisfaction_surveys WHERE order_id=$1`, [oMatriz]);
    check('3. cliente respondeu "5" → answered rating 5', cap === true && s3.rows[0]!.status === 'answered' && s3.rows[0]!.rating === 5);

    // ── 4. captura 2x não regrava (idempotente-avesso) ──
    const cap2 = await tryCaptureSurveyReply(client, ENV, convChatwoot, '3');
    const s4 = await client.query<{ rating: number }>(`SELECT rating FROM commerce.satisfaction_surveys WHERE order_id=$1`, [oMatriz]);
    check('4. responder de novo não regrava a nota (fica 5)', cap2 === false && s4.rows[0]!.rating === 5);

    // ── 5. entrega NÃO-delivered não dispara ──
    const oPend = await seedOrder({ unitId: mainUnitId, mode: 'delivery', deliveryStatus: 'dispatched', status: 'open', delivered: false });
    await dispatchMatrizDeliverySurveys();
    const s5 = await client.query(`SELECT count(*)::int AS n FROM commerce.satisfaction_surveys WHERE order_id=$1`, [oPend]);
    check('5. entrega ainda em rota (não delivered) NÃO gera pesquisa', s5.rows[0]!.n === 0);

    // ── 6. pedido de PARCEIRO (unit não-main) não entra no trilho da matriz ──
    const oPart = await seedOrder({ unitId: partnerUnitId, mode: 'delivery', deliveryStatus: 'delivered', status: 'delivered', delivered: true });
    await dispatchMatrizDeliverySurveys();
    const s6 = await client.query(`SELECT count(*)::int AS n FROM commerce.satisfaction_surveys WHERE order_id=$1`, [oPart]);
    check('6. entrega de PARCEIRO não é pega pelo disparo da matriz (só unit main)', s6.rows[0]!.n === 0);

    // ── 7. NOTA no score: pesquisa answered da unit parceiro entra no getPainelRede ──
    const ps = await client.query<{ id: string }>(
      `INSERT INTO commerce.satisfaction_surveys
         (environment, unit_id, fulfillment_mode, conversation_id, status, rating, answered_at, asked_at)
       VALUES ($1::env_t, $2, 'delivery', $3, 'answered', 3, now(), now()) RETURNING id`,
      [ENV, partnerUnitId, convChatwoot]);
    partnerSurveyId = ps.rows[0]!.id;
    // + a de matriz não conta pro parceiro (unit main), e a resposta 5 acima é da matriz.
    // Aqui a fake-rede-a tem 1 nota (3) → média 3.0, count 1.
    const rede = (await getPainelRede('month', pool)) as Array<Record<string, unknown>>;
    const fa = rede.find((r) => r.slug === 'fake-rede-a');
    check('7. getPainelRede traz satisfaction_avg/count da unidade (nota do parceiro)',
      !!fa && Number(fa.satisfaction_count) === 1 && Number(fa.satisfaction_avg) === 3.0,
      fa ? `avg=${fa.satisfaction_avg} count=${fa.satisfaction_count}` : 'unidade não achada');

    // ── 8. a nota da MATRIZ não vaza pro score do parceiro (unidade diferente) ──
    check('8. nota da matriz (unit main) não conta no score de nenhum parceiro',
      !rede.some((r) => r.unit_id === mainUnitId));

    console.log(fails === 0 ? '\n✅ PROVA VERDE (8/8 checks + setup)' : `\n❌ ${fails} CHECK(S) VERMELHO(S)`);
    process.exitCode = fails === 0 ? 0 : 1;
  } finally {
    await limpar();
    client.release();
    await pool.end();
  }
}

main().catch((err) => { console.error('PROVA ESTOUROU:', err); process.exitCode = 1; });
