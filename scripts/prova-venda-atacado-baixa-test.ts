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
import { pool } from '../src/persistence/db.js';
import { env } from '../src/shared/config/env.js';
import { registerWholesaleSale } from '../src/admin/painel/queries.js';

const ENV = 'test' as const;
const MEASURE = '99/99-99';
const BUYER = 'PROVA-VENDA-BAIXA-' + Date.now();

async function stockQty(client: import('pg').PoolClient): Promise<number | null> {
  const r = await client.query<{ q: string }>(
    `SELECT quantity_on_hand AS q FROM commerce.wholesale_stock WHERE environment=$1 AND measure=$2`, [ENV, MEASURE]);
  return r.rows[0] ? Number(r.rows[0].q) : null;
}

async function main(): Promise<void> {
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

    // 3. CLAMP: vende 100 (mais que tem) → galpão vai a 0, NÃO fica negativo, venda registra
    const v3 = await registerWholesaleSale(
      { customer_id: buyerId, items: [{ measure: MEASURE, quantity: 100, unit_price: 50 }], created_by: 'prova-venda-baixa', environment: ENV }, pool);
    check('3 vende 100 (mais que tem): venda registra', Number(v3.total_amount) === 5000, String(v3.total_amount));
    check('3b CLAMP: galpão vai a 0, não negativo', (await stockQty(client)) === 0, `${await stockQty(client)}un`);

    // 4. FURO: reseta 10un e vende com a medida TORTA ('99 99 99', como se digitasse sem clicar)
    await client.query(`UPDATE commerce.wholesale_stock SET quantity_on_hand=10 WHERE environment=$1 AND measure=$2`, [ENV, MEASURE]);
    await registerWholesaleSale(
      { customer_id: buyerId, items: [{ measure: '99 99 99', quantity: 1, unit_price: 50 }], created_by: 'prova-venda-baixa', environment: ENV }, pool);
    const furoStock = await stockQty(client);
    const furoItem = await client.query<{ unit_cost: string }>(
      `SELECT unit_cost FROM commerce.wholesale_order_items WHERE environment=$1 AND measure=$2 ORDER BY id DESC LIMIT 1`, [ENV, '99 99 99']);
    check('4 FURO confirmado: medida torta NÃO baixa (galpão fica 10)', furoStock === 10, `${furoStock}un`);
    check('4b FURO confirmado: custo congelado virou 0 (lucro inflado)', Number(furoItem.rows[0]?.unit_cost) === 0, `custo ${furoItem.rows[0]?.unit_cost}`);

    console.log(`\n${fails === 0 ? '✅ BAIXA DA VENDA DE ATACADO PROVADA (e furo da medida torta confirmado)' : `❌ ${fails} CASO(S) FALHARAM`}`);
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
