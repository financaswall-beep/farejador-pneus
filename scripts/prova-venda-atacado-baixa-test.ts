/**
 * PROVA de INTEGRAÇÃO da BAIXA da venda de atacado (env `test`), chamando o CÓDIGO REAL
 * (registerWholesaleSale) com a flag WHOLESALE_STOCK_DECREMENT LIGADA. Prova o caminho
 * ponta-a-ponta que o unitário (mock) não cobre: a venda REALMENTE baixar o galpão no banco.
 *
 * Roda com a flag on por fora (o env é lido no import):
 *   WHOLESALE_STOCK_DECREMENT=true npx tsx --env-file=.env.pooler scripts/prova-venda-atacado-baixa-test.ts
 *
 * Escreve e COMITA (registerWholesaleSale não dá pra BEGIN/ROLLBACK por fora) → seeda uma
 * medida descartável ('99/99-99') e um cliente de prova, e LIMPA tudo no finally.
 */
// A configuracao e validada no primeiro import de env. A flag precisa nascer
// antes dele; import estatico tornava esta prova falsamente vermelha.
process.env.WHOLESALE_STOCK_DECREMENT = 'true';

const ENV = 'test' as const;
const MEASURE = '99/99-99';
const BUYER = 'PROVA-VENDA-BAIXA-' + Date.now();

async function stockQty(client: import('pg').PoolClient): Promise<number | null> {
  const r = await client.query<{ q: string }>(
    `SELECT quantity_on_hand AS q FROM commerce.wholesale_stock WHERE environment=$1 AND measure=$2`, [ENV, MEASURE]);
  return r.rows[0] ? Number(r.rows[0].q) : null;
}

async function main(): Promise<void> {
  const { pool } = await import('../src/persistence/db.js');
  const { env } = await import('../src/shared/config/env.js');
  const { registerWholesaleSale } = await import('../src/admin/painel/queries.js');
  if (env.FAREJADOR_ENV !== ENV) throw new Error('ABORTADO: esta prova so roda em test.');
  console.log('=== PROVA VENDA ATACADO → BAIXA (test) ===');
  console.log(`    flag WHOLESALE_STOCK_DECREMENT = ${env.WHOLESALE_STOCK_DECREMENT}`);
  if (!env.WHOLESALE_STOCK_DECREMENT) {
    console.log('    ⚠️  flag OFF — rode com WHOLESALE_STOCK_DECREMENT=true pra provar a baixa.');
  }
  const client = await pool.connect();
  let fails = 0;
  let buyerId = '';
  const check = (name: string, ok: boolean, extra = ''): void => {
    if (!ok) fails++;
    console.log(`  [${ok ? 'OK ' : 'XX '}] ${name}${extra ? ' — ' + extra : ''}`);
  };

  try {
    // setup: galpão com 40un @ custo 21.25 + um comprador de prova
    await client.query(`DELETE FROM commerce.wholesale_stock WHERE environment=$1 AND measure=$2`, [ENV, MEASURE]);
    await client.query(
      `INSERT INTO commerce.wholesale_stock (environment, measure, quantity_on_hand, unit_cost)
       VALUES ($1,$2,40,21.25)`, [ENV, MEASURE]);
    const b = await client.query<{ id: string }>(
      `INSERT INTO commerce.wholesale_customers (environment, name) VALUES ($1,$2) RETURNING id`, [ENV, BUYER]);
    buyerId = b.rows[0]!.id;
    check('setup: galpão 40un @21.25 + comprador', (await stockQty(client)) === 40);

    // 1. vende 1 → galpão 40 → 39, custo congelado 21.25
    const v1 = await registerWholesaleSale(
      { customer_id: buyerId, items: [{ measure: MEASURE, quantity: 1, unit_price: 50 }], created_by: 'prova-venda-baixa', environment: ENV }, pool);
    check('1 venda 1un: total R$50', Number(v1.total_amount) === 50, String(v1.total_amount));
    check('1b BAIXOU o galpão 40 → 39', (await stockQty(client)) === 39, `${await stockQty(client)}un`);
    const it1 = await client.query<{ unit_cost: string; line_profit: string }>(
      `SELECT unit_cost, line_profit FROM commerce.wholesale_order_items
        WHERE environment=$1 AND measure=$2 ORDER BY id DESC LIMIT 1`, [ENV, MEASURE]);
    check('1c custo congelado = 21.25 (lucro 28.75)', Number(it1.rows[0]?.unit_cost) === 21.25 && Number(it1.rows[0]?.line_profit) === 28.75,
      `custo ${it1.rows[0]?.unit_cost} / lucro ${it1.rows[0]?.line_profit}`);

    // 2. vende 5 → 39 → 34 (agrega e baixa de novo)
    await registerWholesaleSale(
      { customer_id: buyerId, items: [{ measure: MEASURE, quantity: 5, unit_price: 50 }], created_by: 'prova-venda-baixa', environment: ENV }, pool);
    check('2 venda 5un: galpão 39 → 34', (await stockQty(client)) === 34, `${await stockQty(client)}un`);

    // 3. TRAVA DE OVERSELL: vende 100 (tem 34) SEM confirmar → REJEITA e não grava nada (rollback)
    let travou = false;
    try {
      await registerWholesaleSale(
        { customer_id: buyerId, items: [{ measure: MEASURE, quantity: 100, unit_price: 50 }], created_by: 'prova-venda-baixa', environment: ENV }, pool);
    } catch (e) { travou = (e as Error).message.startsWith('oversell:'); }
    check('3 vende 100 sem confirmar: TRAVA (oversell)', travou);
    check('3b travou SEM tocar no estoque (segue 34)', (await stockQty(client)) === 34, `${await stockQty(client)}un`);

    // 4. CONFIRMANDO (allow_oversell=true): a mesma venda passa → clampa em 0, registra R$5000
    const v4 = await registerWholesaleSale(
      { customer_id: buyerId, items: [{ measure: MEASURE, quantity: 100, unit_price: 50 }], created_by: 'prova-venda-baixa', environment: ENV, allow_oversell: true }, pool);
    check('4 confirmando (allow_oversell): venda registra R$5000', Number(v4.total_amount) === 5000, String(v4.total_amount));
    check('4b clamp: galpão vai a 0, não negativo', (await stockQty(client)) === 0, `${await stockQty(client)}un`);

    // 5. Medida TORTA ('99 99 99') SEM confirmar: o guard TAMBÉM barra (onHand 0 pra ela) → trava
    //    em vez de gravar venda com custo 0. De brinde, tampa o furo da medida digitada errada.
    await client.query(`UPDATE commerce.wholesale_stock SET quantity_on_hand=10 WHERE environment=$1 AND measure=$2`, [ENV, MEASURE]);
    let travouTorta = false;
    try {
      await registerWholesaleSale(
        { customer_id: buyerId, items: [{ measure: '99 99 99', quantity: 1, unit_price: 50 }], created_by: 'prova-venda-baixa', environment: ENV }, pool);
    } catch (e) { travouTorta = (e as Error).message.startsWith('oversell:'); }
    check('5 medida torta sem confirmar: guard TAMBÉM barra (onHand 0)', travouTorta);
    check('5b galpão intacto (segue 10)', (await stockQty(client)) === 10, `${await stockQty(client)}un`);

    console.log(`\n${fails === 0 ? '✅ TRAVA DE OVERSELL PROVADA (barra sem confirmar, passa com allow_oversell, e ainda tampa a medida torta)' : `❌ ${fails} CASO(S) FALHARAM`}`);
  } finally {
    await client.query(
      `DELETE FROM commerce.wholesale_order_items WHERE environment=$1 AND order_id IN
         (SELECT id FROM commerce.wholesale_orders WHERE environment=$1 AND created_by='prova-venda-baixa')`, [ENV]);
    await client.query(`DELETE FROM commerce.wholesale_orders WHERE environment=$1 AND created_by='prova-venda-baixa'`, [ENV]);
    if (buyerId) await client.query(`DELETE FROM commerce.wholesale_customers WHERE id=$1`, [buyerId]);
    await client.query(`DELETE FROM commerce.wholesale_stock WHERE environment=$1 AND measure=$2`, [ENV, MEASURE]);
    client.release();
    await pool.end();
  }
  process.exit(fails > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
