/**
 * PROVA de INTEGRAÇÃO do FURO achado na banca de conciliação (2026-07-02): cancelar
 * venda de VAREJO da matriz NÃO devolvia o pneu ao galpão. Roda no env `test`,
 * chamando o CÓDIGO REAL (applyMatrizGalpaoDecrement grava a trilha da baixa +
 * cancelManualOrder → cancel_manual_order + applyMatrizGalpaoReturn). Blinda:
 *   baixa registra a trilha (audit.events) · cancelar DEVOLVE exatamente o que saiu ·
 *   sob CLAMP (vendeu mais que tinha) devolve só o que saiu (não infla) · venda que
 *   NÃO baixou (flag off = sem trilha) cancela sem devolver (não inventa estoque) ·
 *   segundo cancelamento não devolve de novo (cancel_manual_order barra 'ja cancelado').
 *
 * Seeds descartáveis (medida '96/96-96', contato/produto PROVA-CANCEL) e LIMPA no finally.
 *
 * USO:
 *   npx tsx --env-file=.env.pooler scripts/prova-cancel-varejo-galpao-test.ts
 */

const ENV = 'test' as const;
const MEASURE = '96/96-96';

async function main(): Promise<void> {
  const { pool } = await import('../src/persistence/db.js');
  const { env } = await import('../src/shared/config/env.js');
  const { applyMatrizGalpaoDecrement } = await import('../src/atendente-v2/wholesale-stock-read.js');
  const { cancelManualOrder } = await import('../src/admin/painel/queries.js');

  if (env.FAREJADOR_ENV !== 'test') throw new Error('ABORTADO: só roda em test.');
  console.log('=== PROVA CANCELAR VAREJO DEVOLVE O GALPÃO (test) ===');

  const client = await pool.connect();
  let fails = 0;
  let productId = '';
  let contactId = '';
  const orderIds: string[] = [];
  const check = (name: string, ok: boolean, extra = ''): void => {
    if (!ok) fails++;
    console.log(`  [${ok ? 'OK ' : 'XX '}] ${name}${extra ? ' — ' + extra : ''}`);
  };
  const qtyOf = async (): Promise<number> => {
    const r = await client.query<{ q: string }>(
      `SELECT quantity_on_hand AS q FROM commerce.wholesale_stock WHERE environment=$1 AND measure=$2`, [ENV, MEASURE]);
    return Number(r.rows[0]?.q ?? -1);
  };
  const seedOrder = async (qty: number): Promise<string> => {
    const o = await client.query<{ id: string }>(
      `INSERT INTO commerce.orders (environment, contact_id, total_amount, status, fulfillment_mode)
       VALUES ($1::env_t, $2, 0, 'open', 'pickup') RETURNING id`, [ENV, contactId]);
    const id = o.rows[0]!.id;
    await client.query(
      `INSERT INTO commerce.order_items (environment, order_id, product_id, quantity, unit_price)
       VALUES ($1::env_t, $2, $3, $4, 100)`, [ENV, id, productId, qty]);
    orderIds.push(id);
    return id;
  };

  try {
    // ── setup: produto + tire_spec + galpão(10 × R$20) + contato descartável ──
    const prod = await client.query<{ id: string }>(
      `INSERT INTO commerce.products (environment, product_code, product_name, product_type, brand)
       VALUES ($1::env_t, $2, 'PROVA-CANCEL pneu', 'tire', 'PROVA') RETURNING id`, [ENV, 'PROVA-CANCEL-' + (Date.now() % 1000000)]);
    productId = prod.rows[0]!.id;
    await client.query(
      `INSERT INTO commerce.tire_specs (environment, product_id, tire_size, width_mm, aspect_ratio, rim_diameter)
       VALUES ($1::env_t, $2, $3, 96, 96, 96)`, [ENV, productId, MEASURE]);
    await client.query(`DELETE FROM commerce.wholesale_stock WHERE environment=$1 AND measure=$2`, [ENV, MEASURE]);
    await client.query(
      `INSERT INTO commerce.wholesale_stock (environment, measure, quantity_on_hand, unit_cost) VALUES ($1,$2,10,20)`, [ENV, MEASURE]);
    const c = await client.query<{ id: string }>(
      `INSERT INTO core.contacts (environment, chatwoot_contact_id, name)
       VALUES ($1::env_t, $2, 'PROVA-CANCEL contato') RETURNING id`, [ENV, Date.now() % 2000000000]);
    contactId = c.rows[0]!.id;
    check('setup: produto + tire_spec + galpão 10un×R$20 + contato', (await qtyOf()) === 10);

    // ── C1: venda baixa 3 → galpão 10→7, trilha gravada ──
    const o1 = await seedOrder(3);
    await applyMatrizGalpaoDecrement(client, ENV, [{ productId, quantity: 3 }], true, o1);
    check('C1 baixa da venda (10→7)', (await qtyOf()) === 7, `qty=${await qtyOf()}`);
    const trail = await client.query<{ n: string }>(
      `SELECT count(*) AS n FROM audit.events WHERE environment=$1 AND entity_id=$2 AND event_type='matriz_galpao_decrement'`, [ENV, o1]);
    check('C1b trilha da baixa gravada (audit.events)', Number(trail.rows[0]!.n) === 1);

    // ── C2: CANCELAR devolve exatamente 3 → galpão 7→10 + trilha de devolução ──
    await cancelManualOrder({ order_id: o1, actor_label: 'prova-cancel', reason: 'teste', environment: ENV });
    check('C2 cancelar DEVOLVE ao galpão (7→10)', (await qtyOf()) === 10, `qty=${await qtyOf()}`);
    const st = await client.query<{ status: string }>(`SELECT status FROM commerce.orders WHERE id=$1`, [o1]);
    check('C2b pedido virou cancelled', st.rows[0]?.status === 'cancelled');
    const ret = await client.query<{ n: string }>(
      `SELECT count(*) AS n FROM audit.events WHERE environment=$1 AND entity_id=$2 AND event_type='matriz_galpao_return'`, [ENV, o1]);
    check('C2c trilha da devolução gravada', Number(ret.rows[0]!.n) === 1);

    // ── C3: segundo cancelamento é barrado (cancel_manual_order), galpão fica 10 ──
    let barrou = false;
    try { await cancelManualOrder({ order_id: o1, actor_label: 'prova-cancel', reason: 'teste', environment: ENV }); }
    catch (e) { barrou = /ja cancelado|já cancelado/i.test((e as Error).message); }
    check('C3 segundo cancelamento barrado (não devolve de novo)', barrou && (await qtyOf()) === 10, `qty=${await qtyOf()}`);

    // ── C4: CLAMP — vende 15 com só 10 → baixa até 0, trilha registra 10 (não 15) ──
    const o2 = await seedOrder(15);
    await applyMatrizGalpaoDecrement(client, ENV, [{ productId, quantity: 15 }], true, o2);
    check('C4 baixa com clamp (10→0)', (await qtyOf()) === 0, `qty=${await qtyOf()}`);
    await cancelManualOrder({ order_id: o2, actor_label: 'prova-cancel', reason: 'teste', environment: ENV });
    check('C4b cancelar devolve só o que SAIU (0→10, não 15)', (await qtyOf()) === 10, `qty=${await qtyOf()}`);

    // ── C5: venda que NÃO baixou (flag off = sem trilha) → cancelar não inventa estoque ──
    const o3 = await seedOrder(4);
    await applyMatrizGalpaoDecrement(client, ENV, [{ productId, quantity: 4 }], false, o3); // enabled=false
    check('C5 flag off: venda não baixou (galpão fica 10)', (await qtyOf()) === 10, `qty=${await qtyOf()}`);
    await cancelManualOrder({ order_id: o3, actor_label: 'prova-cancel', reason: 'teste', environment: ENV });
    check('C5b cancelar sem trilha NÃO inventa estoque (fica 10)', (await qtyOf()) === 10, `qty=${await qtyOf()}`);

    console.log(`\n${fails === 0 ? '✅ CANCELAR VAREJO DEVOLVE O GALPÃO PROVADO (baixa+trilha+devolução exata+clamp+sem-trilha+idempotente)' : `❌ ${fails} CASO(S) FALHARAM`}`);
  } finally {
    for (const id of orderIds) {
      await client.query(`DELETE FROM audit.events WHERE environment=$1 AND entity_id=$2`, [ENV, id]);
      await client.query(`DELETE FROM commerce.order_items WHERE environment=$1 AND order_id=$2`, [ENV, id]);
      await client.query(`DELETE FROM commerce.orders WHERE id=$1`, [id]);
    }
    await client.query(`DELETE FROM commerce.wholesale_stock WHERE environment=$1 AND measure=$2`, [ENV, MEASURE]);
    if (productId) {
      await client.query(`DELETE FROM commerce.tire_specs WHERE environment=$1 AND product_id=$2`, [ENV, productId]);
      await client.query(`DELETE FROM commerce.products WHERE id=$1`, [productId]);
    }
    if (contactId) await client.query(`DELETE FROM core.contacts WHERE id=$1`, [contactId]);
    client.release();
    await pool.end();
  }
  process.exit(fails > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
