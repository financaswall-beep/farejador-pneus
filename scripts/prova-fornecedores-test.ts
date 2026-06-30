/**
 * PROVA do módulo FORNECEDORES (0114) no env `test`, chamando o CÓDIGO REAL
 * (registerWholesaleSupplier / registerWholesalePurchase / ranking). O ponto crítico
 * é DINHEIRO: a compra tem que ALIMENTAR o custo MÉDIO PONDERADO do galpão.
 *
 * Diferente da prova-geo: estas funções ESCREVEM e COMITAM (não dá BEGIN/ROLLBACK por
 * fora). Então a prova SEEDA uma medida de catálogo descartável ('99/99-99' ligada ao
 * produto FAKE-REDE-PNEU) e LIMPA tudo que criou no finally (idempotente).
 *
 * USO: npx tsx --env-file=.env.pooler scripts/prova-fornecedores-test.ts
 */
import { pool } from '../src/persistence/db.js';
import {
  registerWholesaleSupplier,
  registerWholesalePurchase,
  getWholesaleSupplierRanking,
  getWholesaleSupplierMeasureBreakdown,
  listWholesalePurchases,
  listWholesaleStock,
} from '../src/admin/painel/queries.js';

const ENV = 'test' as const;
const MEASURE = '99/99-99';                 // medida descartável (única)
const SUPPLIER = 'PROVA-FORNECEDOR-' + Date.now();

async function main(): Promise<void> {
  console.log('=== PROVA FORNECEDORES (test) ===');
  const client = await pool.connect();
  let fails = 0;
  const check = (name: string, ok: boolean, extra = ''): void => {
    if (!ok) fails++;
    console.log(`  [${ok ? 'OK ' : 'XX '}] ${name}${extra ? ' — ' + extra : ''}`);
  };

  try {
    // setup: produto fake + tire_spec '99/99-99' no catálogo test + galpão zerado nessa medida
    const prod = await client.query<{ id: string }>(
      `SELECT id FROM commerce.products WHERE environment=$1 AND product_code='FAKE-REDE-PNEU'`, [ENV]);
    if (!prod.rows[0]) throw new Error('FAKE-REDE-PNEU não existe no test — rode o seed.');
    const productId = prod.rows[0].id;
    await client.query(`DELETE FROM commerce.tire_specs WHERE environment=$1 AND tire_size=$2`, [ENV, MEASURE]);
    await client.query(
      `INSERT INTO commerce.tire_specs (environment, product_id, tire_size, width_mm, aspect_ratio, rim_diameter)
       VALUES ($1,$2,$3,99,99,99)`, [ENV, productId, MEASURE]);
    await client.query(`DELETE FROM commerce.wholesale_stock WHERE environment=$1 AND measure=$2`, [ENV, MEASURE]);

    // 1. cria fornecedor
    const sup = await registerWholesaleSupplier({ name: SUPPLIER, phone: '21999998888', environment: ENV }, pool);
    check('1 cria ficha de fornecedor', !!sup.id && sup.name === SUPPLIER);

    // 2. compra 1 — 10 un a R$20 → galpão 10un, custo 20
    const p1 = await registerWholesalePurchase(
      { supplier_id: sup.id, items: [{ measure: MEASURE, quantity: 10, unit_cost: 20 }], created_by: 'prova-fornecedor', environment: ENV }, pool);
    check('2 compra 1: total R$200', p1.total_amount === '200.00', p1.total_amount);
    const r1 = (await listWholesaleStock(ENV, pool)).find((r) => r.measure === MEASURE);
    check('2b galpão recebeu 10un @ custo 20', r1?.quantity_on_hand === 10 && Number(r1?.unit_cost) === 20,
      `${r1?.quantity_on_hand}un @${r1?.unit_cost}`);

    // 3. compra 2 — 10 un a R$30 → custo MÉDIO ponderado (10*20+10*30)/20 = 25
    const p2 = await registerWholesalePurchase(
      { supplier_id: sup.id, items: [{ measure: MEASURE, quantity: 10, unit_cost: 30 }], created_by: 'prova-fornecedor', environment: ENV }, pool);
    check('3 compra 2: total R$300', p2.total_amount === '300.00', p2.total_amount);
    const r2 = (await listWholesaleStock(ENV, pool)).find((r) => r.measure === MEASURE);
    check('3b CUSTO MÉDIO ponderado = 25 (20un)', r2?.quantity_on_hand === 20 && Number(r2?.unit_cost) === 25,
      `${r2?.quantity_on_hand}un @${r2?.unit_cost}`);

    // 4. ranking: o fornecedor aparece com total gasto 500 e 2 compras
    const rank = (await getWholesaleSupplierRanking(ENV, pool)) as Array<{ supplier_id: string; total_spent: string; purchases_count: number }>;
    const meu = rank.find((r) => r.supplier_id === sup.id);
    check('4 ranking: total gasto R$500 em 2 compras', !!meu && Number(meu.total_spent) === 500 && Number(meu.purchases_count) === 2,
      meu ? `R$${meu.total_spent}/${meu.purchases_count}x` : 'não achou');

    // 5. histórico: 2 compras desse fornecedor
    const hist = (await listWholesalePurchases(ENV, pool)).filter((h) => h.supplier_name === SUPPLIER);
    check('5 histórico: 2 compras', hist.length === 2, `${hist.length}`);

    // 6. medida fora do catálogo → rollback (atômico, não suja o galpão)
    let rejeitou = false;
    try {
      await registerWholesalePurchase(
        { supplier_id: sup.id, items: [{ measure: 'LIXO-123', quantity: 1, unit_cost: 5 }], created_by: 'prova-fornecedor', environment: ENV }, pool);
    } catch (e) { rejeitou = (e as Error).message === 'measure_not_in_catalog'; }
    check('6 medida fora do catálogo → rejeita (rollback)', rejeitou);

    // 7. INSIGHT #1/#2 breakdown: SUPPLIER1 na MEASURE = custo médio ponderado 25, 20un
    const bd1 = (await getWholesaleSupplierMeasureBreakdown(ENV, pool)) as Array<{ supplier_id: string; measure: string; qty_total: string; avg_cost: string }>;
    const mine1 = bd1.find((r) => r.supplier_id === sup.id && r.measure === MEASURE);
    check('7 breakdown: custo médio ponderado 25 em 20un', !!mine1 && Number(mine1.avg_cost) === 25 && Number(mine1.qty_total) === 20,
      mine1 ? `R$${mine1.avg_cost}/${mine1.qty_total}un` : 'não achou');

    // 8. segundo fornecedor MAIS BARATO na mesma medida → tem que vir NA FRENTE (régua do ★)
    const sup2 = await registerWholesaleSupplier({ name: SUPPLIER + '-B', environment: ENV }, pool);
    await registerWholesalePurchase(
      { supplier_id: sup2.id, items: [{ measure: MEASURE, quantity: 10, unit_cost: 15 }], created_by: 'prova-fornecedor', environment: ENV }, pool);
    const bd2 = (await getWholesaleSupplierMeasureBreakdown(ENV, pool)) as Array<{ supplier_id: string; measure: string; avg_cost: string }>;
    const forMeasure = bd2.filter((r) => r.measure === MEASURE && (r.supplier_id === sup.id || r.supplier_id === sup2.id));
    check('8 breakdown ordena do mais barato (sup2 R$15 antes do sup1 R$25)',
      forMeasure.length === 2 && forMeasure[0]!.supplier_id === sup2.id && Number(forMeasure[0]!.avg_cost) === 15
        && forMeasure[1]!.supplier_id === sup.id && Number(forMeasure[1]!.avg_cost) === 25,
      forMeasure.map((r) => `R$${r.avg_cost}`).join(' < '));

    console.log(`\n${fails === 0 ? '✅ TODOS OS CASOS DE FORNECEDOR PASSARAM' : `❌ ${fails} CASO(S) FALHARAM`}`);
  } finally {
    // cleanup — apaga tudo que a prova criou (purchase_items caem por cascade)
    await client.query(`DELETE FROM commerce.wholesale_purchases WHERE environment=$1 AND created_by='prova-fornecedor'`, [ENV]);
    await client.query(`DELETE FROM commerce.wholesale_suppliers WHERE environment=$1 AND name LIKE 'PROVA-FORNECEDOR-%'`, [ENV]);
    await client.query(`DELETE FROM commerce.wholesale_stock WHERE environment=$1 AND measure=$2`, [ENV, MEASURE]);
    await client.query(`DELETE FROM commerce.tire_specs WHERE environment=$1 AND tire_size=$2`, [ENV, MEASURE]);
    client.release();
    await pool.end();
  }
  process.exit(fails > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
