/**
 * PROVA de INTEGRAÇÃO — FILME DO GALPÃO (0128) + BAIXA MANUAL com motivo,
 * no env `test`, chamando o CÓDIGO REAL (trigger + rótulos + wrappers).
 * Blinda:
 *   toda BOCA grava no filme com o rótulo certo — definir (insert+update) ·
 *   entrada (custo médio no filme) · compra de fornecedor (ref=purchase, reason=nome) ·
 *   cancelamento de compra · venda de atacado (ref=order) · cancelamento da venda ·
 *   VAREJO da matriz (bot/balcão) e cancelamento do varejo · baixa manual (motivo) ·
 *   remoção (op=delete) — e o fail-safe: UPDATE cru sem rótulo vira 'sem_rotulo',
 *   update só de notes/min NÃO vira movimento. Baixa manual RECUSA acima do saldo
 *   (e não deixa rastro). Prova de ouro: Σ deltas do filme == saldo final.
 *
 * Seeds descartáveis (medida '93/93-93', marcador PROVA-FILME) com pré-limpeza
 * por marcador + limpeza no finally (mesmo molde da prova-sino-galpao).
 *
 * USO:
 *   npx tsx --env-file=.env.pooler scripts/prova-estoque-movimentos-test.ts
 */
process.env.WHOLESALE_STOCK_DECREMENT = 'true'; // baixa/devolução do atacado ligadas (espelha prod)

const ENV = 'test' as const;
const MEASURE = '93/93-93'; // descartável (94 sino, 95 logistica, 96 vendas, 97 visao, 98 fiado)

async function main(): Promise<void> {
  const { randomUUID } = await import('node:crypto');
  const { pool } = await import('../src/persistence/db.js');
  const { env } = await import('../src/shared/config/env.js');
  const {
    setWholesaleStockComRotulo, addWholesaleStockEntryComRotulo, deleteWholesaleStockComRotulo,
    applyGalpaoBaixaManual, listGalpaoMovements,
    registerWholesaleSale, cancelWholesaleSale,
    registerWholesalePurchase, cancelWholesalePurchase,
  } = await import('../src/admin/painel/queries.js');
  const { applyMatrizGalpaoDecrement, applyMatrizGalpaoReturn } = await import('../src/atendente-v2/wholesale-stock-read.js');

  if (env.FAREJADOR_ENV !== 'test') throw new Error('ABORTADO: só roda em test.');
  console.log('=== PROVA FILME DO GALPÃO + BAIXA MANUAL (test) ===');

  const client = await pool.connect();
  let fails = 0;
  let productId = '';
  const auditOrderIds: string[] = [];
  const operationKeys: string[] = [];
  const operationKey = () => { const value = randomUUID(); operationKeys.push(value); return value; };
  const check = (name: string, ok: boolean, extra = ''): void => {
    if (!ok) fails++;
    console.log(`  [${ok ? 'OK ' : 'XX '}] ${name}${extra ? ' — ' + extra : ''}`);
  };
  // o filme da medida da prova, mais novo primeiro
  const filme = async () => listGalpaoMovements({ measure: MEASURE, limit: 200, environment: ENV }, pool);
  const topo = async () => (await filme())[0];

  const limpar = async (): Promise<void> => {
    await client.query(`DELETE FROM audit.events
      WHERE environment=$1 AND actor_label='prova-filme'`, [ENV]);
    await client.query(`DELETE FROM audit.operation_idempotency WHERE environment=$1 AND entity_id IN (
      SELECT id FROM commerce.wholesale_orders WHERE environment=$1 AND created_by='prova-filme'
      UNION ALL
      SELECT id FROM commerce.wholesale_purchases WHERE environment=$1 AND created_by='prova-filme')`, [ENV]);
    if (operationKeys.length > 0) {
      await client.query(`DELETE FROM audit.operation_idempotency
        WHERE environment=$1 AND idempotency_key=ANY($2)`, [ENV, operationKeys]);
    }
    await client.query(`DELETE FROM commerce.wholesale_order_items WHERE environment=$1 AND order_id IN (
       SELECT id FROM commerce.wholesale_orders WHERE environment=$1 AND buyer_id IN (
         SELECT id FROM commerce.wholesale_customers WHERE environment=$1 AND name='PROVA-FILME-BORRACHEIRO'))`, [ENV]);
    await client.query(`DELETE FROM commerce.wholesale_orders WHERE environment=$1 AND buyer_id IN (
       SELECT id FROM commerce.wholesale_customers WHERE environment=$1 AND name='PROVA-FILME-BORRACHEIRO')`, [ENV]);
    await client.query(`DELETE FROM commerce.wholesale_customers WHERE environment=$1 AND name='PROVA-FILME-BORRACHEIRO'`, [ENV]);
    await client.query(`DELETE FROM commerce.wholesale_purchase_items WHERE environment=$1 AND purchase_id IN (
       SELECT id FROM commerce.wholesale_purchases WHERE environment=$1 AND supplier_id IN (
         SELECT id FROM commerce.wholesale_suppliers WHERE environment=$1 AND name='PROVA-FILME-FORN'))`, [ENV]);
    await client.query(`DELETE FROM commerce.wholesale_purchases WHERE environment=$1 AND supplier_id IN (
       SELECT id FROM commerce.wholesale_suppliers WHERE environment=$1 AND name='PROVA-FILME-FORN')`, [ENV]);
    await client.query(`DELETE FROM commerce.wholesale_suppliers WHERE environment=$1 AND name='PROVA-FILME-FORN'`, [ENV]);
    await client.query(`DELETE FROM commerce.wholesale_stock WHERE environment=$1 AND measure=$2`, [ENV, MEASURE]);
    await client.query(`DELETE FROM commerce.wholesale_stock_movements WHERE environment=$1 AND measure=$2`, [ENV, MEASURE]);
    await client.query(`DELETE FROM commerce.tire_specs WHERE environment=$1 AND product_id IN (
       SELECT id FROM commerce.products WHERE environment=$1 AND product_code LIKE 'PROVA-FILME-%')`, [ENV]);
    await client.query(`DELETE FROM commerce.products WHERE environment=$1 AND product_code LIKE 'PROVA-FILME-%'`, [ENV]);
    if (auditOrderIds.length > 0) {
      await client.query(`DELETE FROM audit.events WHERE environment=$1 AND entity_id = ANY($2)`, [ENV, auditOrderIds]);
    }
  };

  try {
    await limpar(); // run interrompido não envenena este

    // ── setup: catálogo 93/93-93 (a ponte produto→medida do varejo) ──
    const prod = await client.query<{ id: string }>(
      `INSERT INTO commerce.products (environment, product_code, product_name, product_type, brand)
       VALUES ($1::env_t, $2, 'PROVA-FILME pneu', 'tire', 'PROVA') RETURNING id`,
      [ENV, 'PROVA-FILME-' + (Date.now() % 1000000)]);
    productId = prod.rows[0]!.id;
    await client.query(
      `INSERT INTO commerce.tire_specs (environment, product_id, tire_size, width_mm, aspect_ratio, rim_diameter)
       VALUES ($1::env_t, $2, $3, 93, 93, 93)`, [ENV, productId, MEASURE]);
    check('setup: catálogo 93/93-93', true);

    // ── M1: Definir (insert) → filme op=insert source='definir' ──
    await setWholesaleStockComRotulo({ measure: MEASURE, quantity_on_hand: 10, unit_cost: 20, environment: ENV }, pool);
    let m = await topo();
    check('M1 Definir novo → insert/definir 0→10', !!m && m.op === 'insert' && m.source === 'definir'
      && m.qty_before === 0 && m.qty_after === 10, JSON.stringify(m ?? null));

    // ── M2: Definir de novo (mudou qty) → update/definir 10→8 ──
    await setWholesaleStockComRotulo({ measure: MEASURE, quantity_on_hand: 8, unit_cost: 20, environment: ENV }, pool);
    m = await topo();
    check('M2 Definir mudança → update/definir 10→8 (delta -2)', !!m && m.op === 'update' && m.source === 'definir'
      && m.qty_before === 10 && m.qty_after === 8 && m.qty_delta === -2, JSON.stringify(m ?? null));

    // ── M3: update SÓ de notes/mínimo → NÃO é movimento (filme não cresce) ──
    const antesM3 = (await filme()).length;
    await setWholesaleStockComRotulo({ measure: MEASURE, quantity_on_hand: 8, unit_cost: 20, min_quantity: 3, notes: 'só nota', environment: ENV }, pool);
    check('M3 mexer só em mínimo/notes NÃO grava movimento', (await filme()).length === antesM3);

    // ── M4: + Entrada → source='entrada', custo médio no filme (8@20 + 8@40 → 16@30) ──
    await addWholesaleStockEntryComRotulo({ measure: MEASURE, quantity_in: 8, unit_cost: 40, environment: ENV }, pool);
    m = await topo();
    check('M4 Entrada → entrada 8→16, custo 20→30 no filme', !!m && m.source === 'entrada'
      && m.qty_before === 8 && m.qty_after === 16 && Number(m.cost_before) === 20 && Number(m.cost_after) === 30,
      JSON.stringify(m ?? null));

    // ── M5: venda de ATACADO → source='venda_atacado' ref=order_id (16→13) ──
    const venda = await registerWholesaleSale(
      { new_customer: { name: 'PROVA-FILME-BORRACHEIRO', phone: null },
        items: [{ measure: MEASURE, quantity: 3, unit_price: 60 }],
        created_by: 'prova-filme', environment: ENV, idempotency_key: operationKey() }, pool);
    m = await topo();
    check('M5 venda de atacado → venda_atacado 16→13 ref=order', !!m && m.source === 'venda_atacado'
      && m.qty_before === 16 && m.qty_after === 13 && m.ref === venda.order_id, JSON.stringify(m ?? null));

    // ── M6: cancelar a venda → source='cancelamento_venda' devolve 13→16 ──
    await cancelWholesaleSale({ order_id: venda.order_id, cancelled_by: 'prova-filme',
      reason: 'reversão da prova do filme', environment: ENV,
      idempotency_key: operationKey() }, pool);
    m = await topo();
    check('M6 cancelar venda → cancelamento_venda 13→16 (espelho)', !!m && m.source === 'cancelamento_venda'
      && m.qty_before === 13 && m.qty_after === 16 && m.ref === venda.order_id, JSON.stringify(m ?? null));

    // ── M7: COMPRA de fornecedor → source='compra' ref=purchase reason=fornecedor (16→20) ──
    const compra = await registerWholesalePurchase(
      { new_supplier: { name: 'PROVA-FILME-FORN', phone: null },
        items: [{ measure: MEASURE, quantity: 4, unit_cost: 25 }],
        created_by: 'prova-filme', environment: ENV, idempotency_key: operationKey() }, pool);
    m = await topo();
    check('M7 compra → compra 16→20 ref=purchase reason=fornecedor', !!m && m.source === 'compra'
      && m.qty_before === 16 && m.qty_after === 20 && m.ref === compra.purchase_id && m.reason === 'PROVA-FILME-FORN',
      JSON.stringify(m ?? null));

    // ── M8: CANCELAR a compra → source='cancelamento_compra' (20→16, média reversa) ──
    await cancelWholesalePurchase({ purchase_id: compra.purchase_id, cancelled_by: 'prova-filme',
      reason: 'reversão da compra de prova', environment: ENV,
      idempotency_key: operationKey() }, pool);
    m = await topo();
    check('M8 cancelar compra → cancelamento_compra 20→16', !!m && m.source === 'cancelamento_compra'
      && m.qty_before === 20 && m.qty_after === 16 && m.ref === compra.purchase_id, JSON.stringify(m ?? null));

    // ── M9: VAREJO da matriz (bot/balcão) → source='varejo' ref=order (16→14) ──
    const varejoOrderId = randomUUID();
    auditOrderIds.push(varejoOrderId);
    await client.query('BEGIN');
    await applyMatrizGalpaoDecrement(client, ENV, [{ productId, quantity: 2 }], true, varejoOrderId);
    await client.query('COMMIT');
    m = await topo();
    check('M9 varejo da matriz → varejo 16→14 ref=order', !!m && m.source === 'varejo'
      && m.qty_before === 16 && m.qty_after === 14 && m.ref === varejoOrderId, JSON.stringify(m ?? null));

    // ── M10: cancelar o varejo → source='cancelamento_varejo' devolve 14→16 ──
    await client.query('BEGIN');
    await applyMatrizGalpaoReturn(client, ENV, varejoOrderId);
    await client.query('COMMIT');
    m = await topo();
    check('M10 cancelar varejo → cancelamento_varejo 14→16 (guiado pela trilha)', !!m && m.source === 'cancelamento_varejo'
      && m.qty_before === 14 && m.qty_after === 16 && m.ref === varejoOrderId, JSON.stringify(m ?? null));

    // ── M11: BAIXA MANUAL com motivo → source='baixa_manual' reason gravado (16→13) ──
    const b = await applyGalpaoBaixaManual({ measure: MEASURE, quantity: 3, reason: 'quebra: furou na desmontagem', environment: ENV }, pool);
    m = await topo();
    check('M11 baixa manual → baixa_manual 16→13 com motivo', b.quantity_on_hand === 13 && !!m
      && m.source === 'baixa_manual' && m.reason === 'quebra: furou na desmontagem' && m.qty_delta === -3,
      JSON.stringify(m ?? null));

    // ── M12: baixa ACIMA do saldo → recusa, saldo intacto, filme sem linha nova ──
    const antesM12 = (await filme()).length;
    let e12 = '';
    try {
      await applyGalpaoBaixaManual({ measure: MEASURE, quantity: 99, reason: 'quebra', environment: ENV }, pool);
    } catch (err) { e12 = err instanceof Error ? err.message : String(err); }
    const saldo12 = await client.query<{ q: number }>(
      `SELECT quantity_on_hand q FROM commerce.wholesale_stock WHERE environment=$1 AND measure=$2`, [ENV, MEASURE]);
    check('M12 baixa acima do saldo → recusa e não deixa rastro',
      e12 === 'baixa_maior_que_estoque:13' && saldo12.rows[0]?.q === 13 && (await filme()).length === antesM12, e12);

    // ── M13: baixa sem motivo → reason_required ──
    let e13 = '';
    try {
      await applyGalpaoBaixaManual({ measure: MEASURE, quantity: 1, reason: ' ', environment: ENV }, pool);
    } catch (err) { e13 = err instanceof Error ? err.message : String(err); }
    check('M13 baixa sem motivo → reason_required', e13 === 'reason_required', e13);

    // ── M14: FAIL-SAFE — UPDATE cru (sem rótulo) ainda entra no filme como 'sem_rotulo' ──
    await client.query(
      `UPDATE commerce.wholesale_stock SET quantity_on_hand = quantity_on_hand - 1 WHERE environment=$1 AND measure=$2`,
      [ENV, MEASURE]);
    m = await topo();
    check('M14 UPDATE cru → sem_rotulo 13→12 (a trilha nunca fura)', !!m && m.source === 'sem_rotulo'
      && m.qty_before === 13 && m.qty_after === 12, JSON.stringify(m ?? null));

    // ── M15: PROVA DE OURO — Σ deltas do filme == saldo atual (o filme conta a história toda) ──
    const rows = await filme();
    const soma = rows.reduce((s, x) => s + x.qty_delta, 0);
    check('M15 Σ deltas do filme == saldo do galpão (12)', soma === 12, `Σ=${soma}`);

    // ── M16: REMOVER a medida → op=delete source='remocao' (12→0) ──
    await deleteWholesaleStockComRotulo(MEASURE, ENV, pool);
    m = await topo();
    check('M16 remover medida → delete/remocao 12→0', !!m && m.op === 'delete' && m.source === 'remocao'
      && m.qty_before === 12 && m.qty_after === 0, JSON.stringify(m ?? null));

    // ── M17: filtro por medida e limit da leitura funcionam ──
    const todos = await listGalpaoMovements({ limit: 5, environment: ENV }, pool);
    const soDaMedida = await listGalpaoMovements({ measure: MEASURE, limit: 200, environment: ENV }, pool);
    check('M17 leitura: limit respeitado e filtro por medida só traz a medida',
      todos.length <= 5 && soDaMedida.every((x) => x.measure === MEASURE) && soDaMedida.length >= 10,
      `todos=${todos.length} medida=${soDaMedida.length}`);

    console.log(fails === 0
      ? '\n✅ FILME DO GALPÃO PROVADO (todas as bocas rotuladas + baixa manual honesta + fail-safe sem_rotulo + Σ deltas == saldo)'
      : `\n❌ ${fails} checagem(ns) FALHARAM`);
    process.exitCode = fails === 0 ? 0 : 1;
  } catch (err) {
    // transação pendurada de um erro no meio → não travar a limpeza
    try { await client.query('ROLLBACK'); } catch { /* sem transação aberta */ }
    throw err;
  } finally {
    try { await limpar(); } catch { /* limpeza best-effort */ }
    client.release();
    await pool.end();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
