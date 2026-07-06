/**
 * PROVA de INTEGRAÇÃO — ESTOQUE MÍNIMO do galpão (0126) + SINO da matriz
 * (getMatrizNotificacoes) no env `test`, chamando o CÓDIGO REAL.
 * Blinda:
 *   mínimo grava/lê no galpão (set + list) · "+ Entrada" PRESERVA o mínimo ·
 *   sino acusa repor SÓ com mínimo definido e qty <= min (opt-in; NULL nunca
 *   alerta) · fiado vencido entra/sai do sino junto com a quitação · entrega
 *   failed da MAIN entra no sino e some quando o dono resolve · pedido FORA
 *   da main não vaza pro sino (guard) · min inválido recusa (min_invalid).
 *
 * Seeds descartáveis (medida '94/94-94', marcador PROVA-SINO) com pré-limpeza
 * por marcador + limpeza no finally (mesmo molde da prova-logistica).
 *
 * USO:
 *   npx tsx --env-file=.env.pooler scripts/prova-sino-galpao-test.ts
 */
process.env.WHOLESALE_FINANCE = 'true';

const ENV = 'test' as const;
const MEASURE = '94/94-94'; // descartável (95 logistica, 97 visao, 98 fiado, 99 outras)

function isoDate(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  const { pool } = await import('../src/persistence/db.js');
  const { env } = await import('../src/shared/config/env.js');
  const {
    setWholesaleStock, addWholesaleStockEntry, listWholesaleStock,
    getMatrizNotificacoes, registerWholesaleSale, settleWholesaleOrderPayment,
  } = await import('../src/admin/painel/queries.js');

  if (env.FAREJADOR_ENV !== 'test') throw new Error('ABORTADO: só roda em test.');
  console.log('=== PROVA SINO + MÍNIMO DO GALPÃO (test) ===');

  const client = await pool.connect();
  let fails = 0;
  let productId = '';
  let contactId = '';
  let buyerId = '';
  const orderIds: string[] = [];
  const check = (name: string, ok: boolean, extra = ''): void => {
    if (!ok) fails++;
    console.log(`  [${ok ? 'OK ' : 'XX '}] ${name}${extra ? ' — ' + extra : ''}`);
  };
  const noRepor = async () => (await getMatrizNotificacoes(ENV, pool)).galpao_repor
    .find((m) => m.measure === MEASURE);

  const limpar = async (): Promise<void> => {
    await client.query(`DELETE FROM commerce.order_items WHERE environment=$1 AND order_id IN (
       SELECT id FROM commerce.orders WHERE environment=$1 AND delivery_address LIKE '%PROVA-SINO%')`, [ENV]);
    await client.query(`DELETE FROM commerce.orders WHERE environment=$1 AND delivery_address LIKE '%PROVA-SINO%'`, [ENV]);
    await client.query(`DELETE FROM commerce.wholesale_order_items WHERE environment=$1 AND order_id IN (
       SELECT id FROM commerce.wholesale_orders WHERE environment=$1 AND buyer_id IN (
         SELECT id FROM commerce.wholesale_customers WHERE environment=$1 AND name='PROVA-SINO-BORRACHEIRO'))`, [ENV]);
    await client.query(`DELETE FROM commerce.wholesale_orders WHERE environment=$1 AND buyer_id IN (
       SELECT id FROM commerce.wholesale_customers WHERE environment=$1 AND name='PROVA-SINO-BORRACHEIRO')`, [ENV]);
    await client.query(`DELETE FROM commerce.wholesale_customers WHERE environment=$1 AND name='PROVA-SINO-BORRACHEIRO'`, [ENV]);
    await client.query(`DELETE FROM commerce.wholesale_stock WHERE environment=$1 AND measure=$2`, [ENV, MEASURE]);
    await client.query(`DELETE FROM commerce.tire_specs WHERE environment=$1 AND product_id IN (
       SELECT id FROM commerce.products WHERE environment=$1 AND product_code LIKE 'PROVA-SINO-%')`, [ENV]);
    await client.query(`DELETE FROM commerce.products WHERE environment=$1 AND product_code LIKE 'PROVA-SINO-%'`, [ENV]);
    await client.query(`DELETE FROM core.contacts WHERE environment=$1 AND name='PROVA-SINO contato'`, [ENV]);
  };

  try {
    await limpar(); // run interrompido não envenena este

    // ── setup: unit main + produto/catálogo + contato + borracheiro ──
    const mu = await client.query<{ id: string }>(
      `SELECT id FROM core.units WHERE environment=$1 AND slug='main'`, [ENV]);
    if (!mu.rows[0]) throw new Error('unit main não existe no env test.');
    const mainUnitId = mu.rows[0].id;
    const prod = await client.query<{ id: string }>(
      `INSERT INTO commerce.products (environment, product_code, product_name, product_type, brand)
       VALUES ($1::env_t, $2, 'PROVA-SINO pneu', 'tire', 'PROVA') RETURNING id`,
      [ENV, 'PROVA-SINO-' + (Date.now() % 1000000)]);
    productId = prod.rows[0]!.id;
    await client.query(
      `INSERT INTO commerce.tire_specs (environment, product_id, tire_size, width_mm, aspect_ratio, rim_diameter)
       VALUES ($1::env_t, $2, $3, 94, 94, 94)`, [ENV, productId, MEASURE]);
    const ct = await client.query<{ id: string }>(
      `INSERT INTO core.contacts (environment, chatwoot_contact_id, name, phone_e164)
       VALUES ($1::env_t, $2, 'PROVA-SINO contato', '+5521900000001') RETURNING id`,
      [ENV, Date.now() % 2000000000]);
    contactId = ct.rows[0]!.id;
    const b = await client.query<{ id: string }>(
      `INSERT INTO commerce.wholesale_customers (environment, name, phone)
       VALUES ($1,'PROVA-SINO-BORRACHEIRO','21977776666') RETURNING id`, [ENV]);
    buyerId = b.rows[0]!.id;
    check('setup: main + catálogo 94/94-94 + contato + borracheiro', true);

    // régua de partida (test pode ter lixo de outras frentes)
    const base = await getMatrizNotificacoes(ENV, pool);
    const baseFiadoCount = base.fiado_vencido.count;
    const baseFiadoTotal = Number(base.fiado_vencido.total);
    const baseFalhas = base.entregas_falhadas.length;

    // ── G1: mínimo grava e volta na leitura ──
    const g1 = await setWholesaleStock(
      { measure: MEASURE, quantity_on_hand: 10, unit_cost: 20, min_quantity: 5, environment: ENV }, pool);
    const lida = (await listWholesaleStock(ENV, pool)).find((r) => r.measure === MEASURE);
    check('G1 set grava min=5 e list devolve', g1.min_quantity === 5 && lida?.min_quantity === 5,
      `set=${g1.min_quantity} list=${lida?.min_quantity}`);

    // ── G2: 10 > 5 → NÃO alerta ──
    check('G2 qty acima do mínimo NÃO entra no repor', !(await noRepor()));

    // ── G3: qty 3 <= 5 → alerta com os números certos ──
    await setWholesaleStock({ measure: MEASURE, quantity_on_hand: 3, unit_cost: 20, min_quantity: 5, environment: ENV }, pool);
    const g3 = await noRepor();
    check('G3 qty<=min entra no repor do sino', !!g3 && g3.quantity_on_hand === 3 && g3.min_quantity === 5,
      JSON.stringify(g3 ?? null));

    // ── G4: "+ Entrada" soma e PRESERVA o mínimo → sai do repor ──
    const g4 = await addWholesaleStockEntry({ measure: MEASURE, quantity_in: 10, unit_cost: 20, environment: ENV }, pool);
    check('G4 entrada preserva o mínimo e sai do repor',
      g4.quantity_on_hand === 13 && g4.min_quantity === 5 && !(await noRepor()),
      `qty=${g4.quantity_on_hand} min=${g4.min_quantity}`);

    // ── G5: sem mínimo (null) = NUNCA alerta, mesmo baixo (opt-in) ──
    await setWholesaleStock({ measure: MEASURE, quantity_on_hand: 1, unit_cost: 20, min_quantity: null, environment: ENV }, pool);
    check('G5 min NULL não alerta nem com qty=1', !(await noRepor()));

    // ── G6: mínimo inválido recusa ──
    let g6 = '';
    try {
      await setWholesaleStock({ measure: MEASURE, quantity_on_hand: 1, unit_cost: 20, min_quantity: -1, environment: ENV }, pool);
    } catch (err) { g6 = err instanceof Error ? err.message : String(err); }
    check('G6 min negativo → min_invalid', g6 === 'min_invalid', g6);

    // ── F1: fiado vencido entra no sino ──
    await setWholesaleStock({ measure: MEASURE, quantity_on_hand: 20, unit_cost: 20, environment: ENV }, pool);
    const venda = await registerWholesaleSale(
      { customer_id: buyerId, items: [{ measure: MEASURE, quantity: 2, unit_price: 50 }],
        created_by: 'prova-sino', environment: ENV, payment_status: 'pending', due_date: isoDate(-1) }, pool);
    let s = await getMatrizNotificacoes(ENV, pool);
    check('F1 fiado vencido (+1, +R$100) entra no sino',
      s.fiado_vencido.count === baseFiadoCount + 1
        && Math.round((Number(s.fiado_vencido.total) - baseFiadoTotal) * 100) === 10000,
      `${baseFiadoCount}/${baseFiadoTotal} → ${s.fiado_vencido.count}/${s.fiado_vencido.total}`);

    // ── F2: quitou → sai do sino ──
    await settleWholesaleOrderPayment(venda.order_id, ENV, pool);
    s = await getMatrizNotificacoes(ENV, pool);
    check('F2 fiado quitado sai do sino', s.fiado_vencido.count === baseFiadoCount);

    // ── E1: entrega failed da MAIN entra no sino (com motivo) ──
    const o1 = await client.query<{ id: string }>(
      `INSERT INTO commerce.orders (environment, contact_id, total_amount, status, fulfillment_mode, delivery_address, unit_id,
                                    delivery_status, delivery_failure_reason)
       VALUES ($1::env_t, $2, 100, 'open', 'delivery', 'Rua PROVA-SINO, 1', $3, 'failed', 'cliente ausente PROVA-SINO')
       RETURNING id`, [ENV, contactId, mainUnitId]);
    orderIds.push(o1.rows[0]!.id);
    s = await getMatrizNotificacoes(ENV, pool);
    const e1 = s.entregas_falhadas.find((e) => e.order_id === o1.rows[0]!.id);
    check('E1 failed da MAIN entra no sino com motivo',
      s.entregas_falhadas.length === baseFalhas + 1 && !!e1 && e1.reason === 'cliente ausente PROVA-SINO',
      e1 ? e1.reason ?? '' : 'não achou');

    // ── E2: dono resolveu (cancelou) → some do sino ──
    await client.query(`UPDATE commerce.orders SET status='cancelled' WHERE id=$1 AND environment=$2`,
      [o1.rows[0]!.id, ENV]);
    s = await getMatrizNotificacoes(ENV, pool);
    check('E2 pedido cancelado sai do sino', s.entregas_falhadas.length === baseFalhas);

    // ── E3: failed FORA da main NÃO vaza pro sino (guard) ──
    const o2 = await client.query<{ id: string }>(
      `INSERT INTO commerce.orders (environment, contact_id, total_amount, status, fulfillment_mode, delivery_address, unit_id,
                                    delivery_status, delivery_failure_reason)
       VALUES ($1::env_t, $2, 100, 'open', 'delivery', 'Rua PROVA-SINO, 2', NULL, 'failed', 'fora da main PROVA-SINO')
       RETURNING id`, [ENV, contactId]);
    orderIds.push(o2.rows[0]!.id);
    s = await getMatrizNotificacoes(ENV, pool);
    check('E3 failed fora da MAIN não entra no sino (guard)',
      s.entregas_falhadas.length === baseFalhas
        && !s.entregas_falhadas.find((e) => e.order_id === o2.rows[0]!.id));

    console.log(fails === 0
      ? '\n✅ SINO + MÍNIMO PROVADOS (grava/lê + entrada preserva + opt-in + fiado entra/sai + failed main entra/sai + guard)'
      : `\n❌ ${fails} checagem(ns) FALHARAM`);
    process.exitCode = fails === 0 ? 0 : 1;
  } finally {
    try { await limpar(); } catch { /* limpeza best-effort */ }
    client.release();
    await pool.end();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
