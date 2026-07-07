/**
 * PROVA do CANCELAR COMPRA (0127) + ARQUIVAR FORNECEDOR no env `test`, chamando o
 * CÓDIGO REAL. O ponto crítico é DINHEIRO: o cancelamento tem que REVERTER o custo
 * médio ponderado do galpão pelo inverso exato — e clampar honesto quando não dá.
 *
 * Igual à prova-fornecedores: as funções ESCREVEM e COMITAM, então a prova seeda
 * a medida descartável '99/99-99' (produto FAKE-REDE-PNEU) e LIMPA tudo no finally.
 *
 * USO: npx tsx --env-file=.env.pooler scripts/prova-compras-cancel-test.ts
 */
// C5 exige o fiado ligado (compra pending) — a flag entra ANTES de qualquer import
// que leia `env` (parse no 1º import), por isso os imports são DINÂMICOS no main()
// (padrão da prova-financeiro-atacado; import estático é içado e mata o set).
process.env.WHOLESALE_FINANCE = 'true';

const ENV = 'test' as const;
const MEASURE = '99/99-99';
const SUPPLIER = 'PROVA-CANCEL-' + Date.now();

async function main(): Promise<void> {
  const { pool } = await import('../src/persistence/db.js');
  const { env } = await import('../src/shared/config/env.js');
  const {
    registerWholesaleSupplier,
    registerWholesalePurchase,
    cancelWholesalePurchase,
    archiveWholesaleSupplier,
    getWholesaleSupplierRanking,
    getWholesaleSupplierMeasureBreakdown,
    listWholesalePurchases,
    listWholesaleSuppliers,
    listWholesaleStock,
    getWholesaleFinance,
    settleWholesalePurchasePayment,
  } = await import('../src/admin/painel/queries.js');

  if (env.FAREJADOR_ENV !== 'test') throw new Error('ABORTADO: só roda em test.');
  if (!env.WHOLESALE_FINANCE) throw new Error('ABORTADO: WHOLESALE_FINANCE não ligou.');

  const stockRow = async () =>
    (await listWholesaleStock(ENV, pool)).find((r) => r.measure === MEASURE);

  console.log('=== PROVA CANCELAR COMPRA + ARQUIVAR FORNECEDOR (test) ===');
  const client = await pool.connect();
  let fails = 0;
  const check = (name: string, ok: boolean, extra = ''): void => {
    if (!ok) fails++;
    console.log(`  [${ok ? 'OK ' : 'XX '}] ${name}${extra ? ' — ' + extra : ''}`);
  };

  try {
    // setup: catálogo descartável + galpão zerado nessa medida
    const prod = await client.query<{ id: string }>(
      `SELECT id FROM commerce.products WHERE environment=$1 AND product_code='FAKE-REDE-PNEU'`, [ENV]);
    if (!prod.rows[0]) throw new Error('FAKE-REDE-PNEU não existe no test — rode o seed.');
    await client.query(`DELETE FROM commerce.tire_specs WHERE environment=$1 AND tire_size=$2`, [ENV, MEASURE]);
    await client.query(
      `INSERT INTO commerce.tire_specs (environment, product_id, tire_size, width_mm, aspect_ratio, rim_diameter)
       VALUES ($1,$2,$3,99,99,99)`, [ENV, prod.rows[0].id, MEASURE]);
    await client.query(`DELETE FROM commerce.wholesale_stock WHERE environment=$1 AND measure=$2`, [ENV, MEASURE]);

    const sup = await registerWholesaleSupplier({ name: SUPPLIER, environment: ENV }, pool);

    // C1. duas compras → média ponderada 25 (fundação, já provada na prova-fornecedores)
    await registerWholesalePurchase(
      { supplier_id: sup.id, items: [{ measure: MEASURE, quantity: 10, unit_cost: 20 }], created_by: 'prova-cancel', environment: ENV }, pool);
    const p2 = await registerWholesalePurchase(
      { supplier_id: sup.id, items: [{ measure: MEASURE, quantity: 10, unit_cost: 30 }], created_by: 'prova-cancel', environment: ENV }, pool);
    const s1 = await stockRow();
    check('C1 fundação: 20un @ média 25', s1?.quantity_on_hand === 20 && Number(s1?.unit_cost) === 25,
      `${s1?.quantity_on_hand}un @${s1?.unit_cost}`);

    // C2. CANCELA a compra 2 → galpão volta a 10un @ 20.00 EXATO (inverso ponderado)
    const c2 = await cancelWholesalePurchase(
      { purchase_id: p2.purchase_id, cancelled_by: 'prova-cancel', reason: 'registro errado', environment: ENV }, pool);
    const s2 = await stockRow();
    check('C2 cancelou: galpão reverte 10un @ 20.00 EXATO', s2?.quantity_on_hand === 10 && Number(s2?.unit_cost) === 20,
      `${s2?.quantity_on_hand}un @${s2?.unit_cost}`);
    check('C2b devolveu cancelled_at + payment_status', !!c2.cancelled_at && c2.payment_status === 'paid');
    const trilha = await client.query<{ status: string; cancelled_by: string; cancel_reason: string }>(
      `SELECT status, cancelled_by, cancel_reason FROM commerce.wholesale_purchases WHERE id=$1`, [p2.purchase_id]);
    check('C2c trilha gravada (status/by/reason)',
      trilha.rows[0]?.status === 'cancelled' && trilha.rows[0]?.cancelled_by === 'prova-cancel'
        && trilha.rows[0]?.cancel_reason === 'registro errado',
      JSON.stringify(trilha.rows[0]));

    // C3. cancelada some SOZINHA do ranking e do preço por medida
    const rank = (await getWholesaleSupplierRanking(ENV, pool)) as Array<{ supplier_id: string; total_spent: string; purchases_count: number }>;
    const meu = rank.find((r) => r.supplier_id === sup.id);
    check('C3 ranking: só a compra viva (R$200, 1 compra)', !!meu && Number(meu.total_spent) === 200 && Number(meu.purchases_count) === 1,
      meu ? `R$${meu.total_spent}/${meu.purchases_count}x` : 'não achou');
    const bd = (await getWholesaleSupplierMeasureBreakdown(ENV, pool)) as Array<{ supplier_id: string; measure: string; avg_cost: string; qty_total: string }>;
    const mine = bd.find((r) => r.supplier_id === sup.id && r.measure === MEASURE);
    check('C3b preço por medida: média volta a 20 em 10un', !!mine && Number(mine.avg_cost) === 20 && Number(mine.qty_total) === 10,
      mine ? `R$${mine.avg_cost}/${mine.qty_total}un` : 'não achou');

    // C4. cancelar 2x → purchase_already_cancelled (trilha original preservada)
    let dupla = false;
    try {
      await cancelWholesalePurchase({ purchase_id: p2.purchase_id, cancelled_by: 'prova-2x', environment: ENV }, pool);
    } catch (e) { dupla = (e as Error).message === 'purchase_already_cancelled'; }
    const trilha2 = await client.query<{ cancelled_by: string }>(
      `SELECT cancelled_by FROM commerce.wholesale_purchases WHERE id=$1`, [p2.purchase_id]);
    check('C4 cancelar 2x → purchase_already_cancelled, trilha intacta',
      dupla && trilha2.rows[0]?.cancelled_by === 'prova-cancel');

    // C5. compra FIADA → a pagar; cancela → some do a pagar; quitar → payable_not_found
    const p3 = await registerWholesalePurchase(
      { supplier_id: sup.id, items: [{ measure: MEASURE, quantity: 10, unit_cost: 40 }],
        created_by: 'prova-cancel', environment: ENV, payment_status: 'pending', due_date: '2026-08-01' }, pool);
    const fin1 = await getWholesaleFinance(ENV, pool);
    const payAntes = fin1.payables.find((p) => p.id === p3.purchase_id);
    check('C5 compra fiada entrou no a pagar (R$400)', !!payAntes && Number(payAntes.total_amount) === 400,
      payAntes ? `R$${payAntes.total_amount}` : 'não achou');
    const s3 = await stockRow();
    check('C5b galpão foi a 20un @ 30 (média com a fiada)', s3?.quantity_on_hand === 20 && Number(s3?.unit_cost) === 30,
      `${s3?.quantity_on_hand}un @${s3?.unit_cost}`);
    await cancelWholesalePurchase({ purchase_id: p3.purchase_id, cancelled_by: 'prova-cancel', environment: ENV }, pool);
    const fin2 = await getWholesaleFinance(ENV, pool);
    check('C5c cancelou: sumiu do a pagar', !fin2.payables.some((p) => p.id === p3.purchase_id));
    const s4 = await stockRow();
    check('C5d galpão reverteu de novo: 10un @ 20.00', s4?.quantity_on_hand === 10 && Number(s4?.unit_cost) === 20,
      `${s4?.quantity_on_hand}un @${s4?.unit_cost}`);
    let quitou = false;
    try { await settleWholesalePurchasePayment(p3.purchase_id, ENV, pool); }
    catch (e) { quitou = (e as Error).message === 'payable_not_found'; }
    check('C5e quitar compra cancelada → payable_not_found', quitou);

    // C6. CLAMP honesto: galpão menor que a compra (já "vendeu" parte) → 0, custo mantém
    const p4 = await registerWholesalePurchase(
      { supplier_id: sup.id, items: [{ measure: MEASURE, quantity: 10, unit_cost: 20 }], created_by: 'prova-cancel', environment: ENV }, pool);
    await client.query( // simula venda: baixa 15 das 20 direto (fora do caminho da compra)
      `UPDATE commerce.wholesale_stock SET quantity_on_hand = quantity_on_hand - 15
        WHERE environment=$1 AND measure=$2`, [ENV, MEASURE]);
    await cancelWholesalePurchase({ purchase_id: p4.purchase_id, cancelled_by: 'prova-cancel', environment: ENV }, pool);
    const s5 = await stockRow();
    check('C6 clamp: 5un − compra de 10 → 0un, custo mantido (não negativa, não inventa)',
      s5?.quantity_on_hand === 0 && Number(s5?.unit_cost) === 20,
      `${s5?.quantity_on_hand}un @${s5?.unit_cost}`);

    // C7. lista devolve status/pagamento; cancelada aparece com badge
    const lista = await listWholesalePurchases(ENV, pool);
    const viva = lista.find((l) => l.id !== p2.purchase_id && l.status === 'confirmed' && l.supplier_name === SUPPLIER);
    const cancelada = lista.find((l) => l.id === p2.purchase_id);
    check('C7 lista traz vivas E canceladas com payment_status/status',
      !!viva && !!cancelada && cancelada.status === 'cancelled' && !!cancelada.cancelled_at
        && typeof viva.payment_status === 'string');

    // C8. cancelar compra inexistente → purchase_not_found
    let naoAchou = false;
    try {
      await cancelWholesalePurchase(
        { purchase_id: '00000000-0000-0000-0000-000000000000', cancelled_by: 'prova', environment: ENV }, pool);
    } catch (e) { naoAchou = (e as Error).message === 'purchase_not_found'; }
    check('C8 compra inexistente → purchase_not_found', naoAchou);

    // C9. ARQUIVAR fornecedor: some do form/ranking; compras dele FICAM na lista
    await archiveWholesaleSupplier(sup.id, ENV, pool);
    const forms = await listWholesaleSuppliers(ENV, pool);
    const rank2 = (await getWholesaleSupplierRanking(ENV, pool)) as Array<{ supplier_id: string }>;
    const lista2 = await listWholesalePurchases(ENV, pool);
    check('C9 arquivado some do formulário e do ranking',
      !forms.some((s) => s.id === sup.id) && !rank2.some((r) => r.supplier_id === sup.id));
    check('C9b compras do arquivado CONTINUAM no histórico',
      lista2.some((l) => l.supplier_name === SUPPLIER));
    let arq2 = false;
    try { await archiveWholesaleSupplier(sup.id, ENV, pool); }
    catch (e) { arq2 = (e as Error).message === 'supplier_not_found'; }
    check('C9c arquivar 2x → supplier_not_found', arq2);

    console.log(`\n${fails === 0 ? '✅ CANCELAR COMPRA + ARQUIVAR PROVADOS' : `❌ ${fails} CASO(S) FALHARAM`}`);
  } finally {
    await client.query(`DELETE FROM commerce.wholesale_purchases WHERE environment=$1 AND created_by='prova-cancel'`, [ENV]);
    await client.query(`DELETE FROM commerce.wholesale_suppliers WHERE environment=$1 AND name LIKE 'PROVA-CANCEL-%'`, [ENV]);
    await client.query(`DELETE FROM commerce.wholesale_stock WHERE environment=$1 AND measure=$2`, [ENV, MEASURE]);
    await client.query(`DELETE FROM commerce.tire_specs WHERE environment=$1 AND tire_size=$2`, [ENV, MEASURE]);
    client.release();
    await pool.end();
  }
  process.exit(fails > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
