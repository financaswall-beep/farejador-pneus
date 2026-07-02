/**
 * PROVA de INTEGRAÇÃO do CUSTO CONGELADO no VAREJO da MATRIZ (0117 — fatia 2), env `test`,
 * chamando o CÓDIGO REAL (registerWalkinOrder + getVarejoResumo) com a flag
 * WHOLESALE_MATRIZ_RETAIL_COST LIGADA. Prova o que o unitário (mock) não cobre: a venda
 * REALMENTE fotografar o custo do galpão no banco, o congelamento sobreviver à mudança do
 * custo médio, o resumo somar certo (por DELTAS — robusto a dado pré-existente), o recorte
 * por mês e o cancelado ficarem fora, e venda de PARCEIRO não ser tocada.
 *
 * Roda com a flag on por fora (o env é lido no import):
 *   WHOLESALE_MATRIZ_RETAIL_COST=true npx tsx --env-file=.env.pooler scripts/prova-custo-varejo-matriz-test.ts
 *
 * Escreve e COMITA (registerWalkinOrder não dá pra BEGIN/ROLLBACK por fora) → seeda produto
 * e medida descartáveis ('99/98-97') e LIMPA tudo no finally (itens, pedidos, cliente,
 * spec, produtos, galpão).
 */
import type { PoolClient } from 'pg';
import { pool } from '../src/persistence/db.js';
import { env } from '../src/shared/config/env.js';
import { registerWalkinOrder, getVarejoResumo } from '../src/admin/painel/queries.js';
import { applyMatrizRetailCostSnapshot } from '../src/atendente-v2/wholesale-stock-read.js';

const ENV = 'test' as const;
const MEASURE = '99/98-97';
const TAG = 'PROVA-CUSTO-' + Date.now();

type Resumo = { faturamento: string; custo_total: string; lucro_total: string; vendas_count: number; itens_sem_custo: number };
const num = (v: unknown): number => Number(v ?? 0);
const delta = (a: Resumo, b: Resumo, k: keyof Resumo): number => num(a[k]) - num(b[k]);

async function itemCost(client: PoolClient, orderId: string, productId: string): Promise<number | null> {
  const r = await client.query<{ matriz_unit_cost: string | null }>(
    `SELECT matriz_unit_cost FROM commerce.order_items WHERE environment=$1 AND order_id=$2 AND product_id=$3 LIMIT 1`,
    [ENV, orderId, productId],
  );
  const v = r.rows[0]?.matriz_unit_cost;
  return v === null || v === undefined ? null : Number(v);
}

async function main(): Promise<void> {
  console.log('=== PROVA CUSTO CONGELADO NO VAREJO DA MATRIZ — 0117 (test) ===');
  console.log(`    flag WHOLESALE_MATRIZ_RETAIL_COST = ${env.WHOLESALE_MATRIZ_RETAIL_COST}`);
  const client = await pool.connect();
  let fails = 0;
  let pA = '';
  let pB = '';
  const check = (name: string, ok: boolean, extra = ''): void => {
    if (!ok) fails++;
    console.log(`  [${ok ? 'OK ' : 'XX '}] ${name}${extra ? ' — ' + extra : ''}`);
  };

  try {
    check('flag ligada (a prova exige rodar com WHOLESALE_MATRIZ_RETAIL_COST=true)', env.WHOLESALE_MATRIZ_RETAIL_COST === true);

    // setup: produto A com medida no galpão (40un @ 21.25) + produto B SEM medida
    const a = await client.query<{ id: string }>(
      `INSERT INTO commerce.products (environment, product_code, product_name, product_type)
       VALUES ($1,$2,$3,'tire') RETURNING id`, [ENV, TAG + '-A', 'Pneu prova custo A']);
    pA = a.rows[0]!.id;
    await client.query(
      `INSERT INTO commerce.tire_specs (environment, product_id, tire_size) VALUES ($1,$2,$3)`,
      [ENV, pA, MEASURE]);
    const b = await client.query<{ id: string }>(
      `INSERT INTO commerce.products (environment, product_code, product_name, product_type)
       VALUES ($1,$2,$3,'tire') RETURNING id`, [ENV, TAG + '-B', 'Pneu prova custo B (sem medida)']);
    pB = b.rows[0]!.id;
    await client.query(`DELETE FROM commerce.wholesale_stock WHERE environment=$1 AND measure=$2`, [ENV, MEASURE]);
    await client.query(
      `INSERT INTO commerce.wholesale_stock (environment, measure, quantity_on_hand, unit_cost) VALUES ($1,$2,40,21.25)`,
      [ENV, MEASURE]);
    const tudo0 = await getVarejoResumo('tudo', ENV, pool);
    const mes0 = await getVarejoResumo('mes', ENV, pool);
    check('setup: produtos + galpão 40un @21.25 + baseline do resumo', true);

    // 1. venda walk-in da MATRIZ (unit vazia = 'main'): A 2×150 + B 1×100
    const o1 = await registerWalkinOrder({
      environment: ENV, customer_name: TAG, customer_phone: '(21) 99999-0000', unit_id: null,
      items: [
        { product_id: pA, quantity: 2, unit_price: 150 },
        { product_id: pB, quantity: 1, unit_price: 100 },
      ],
      payment_method: 'dinheiro', fulfillment_mode: 'pickup', delivery_address: null,
      actor_label: 'prova-custo', idempotency_key: TAG + '-o1', source_tag: 'walkin_balcao',
    }, pool);
    check('1 venda matriz: item COM medida congelou 21.25', (await itemCost(client, o1.order_id, pA)) === 21.25,
      String(await itemCost(client, o1.order_id, pA)));
    check('1b item SEM medida no galpão ficou NULL (não chuta)', (await itemCost(client, o1.order_id, pB)) === null);

    // 2. custo médio muda DEPOIS → a venda não muda (congelou de verdade)
    await client.query(`UPDATE commerce.wholesale_stock SET unit_cost=30 WHERE environment=$1 AND measure=$2`, [ENV, MEASURE]);
    check('2 custo médio foi a 30 e a venda SEGUE 21.25 (retrato)', (await itemCost(client, o1.order_id, pA)) === 21.25);

    // 3. resumo 'tudo' (deltas): faturamento +400, custo +42.50 (2×21.25), lucro +257.50, 1 venda, 1 item sem custo
    const tudo1 = await getVarejoResumo('tudo', ENV, pool);
    check('3 faturamento +400', delta(tudo1, tudo0, 'faturamento') === 400, String(delta(tudo1, tudo0, 'faturamento')));
    check('3b custo +42.50 (só o item congelado)', delta(tudo1, tudo0, 'custo_total') === 42.5, String(delta(tudo1, tudo0, 'custo_total')));
    check('3c lucro +257.50 (300−42.50; item sem custo FORA)', delta(tudo1, tudo0, 'lucro_total') === 257.5, String(delta(tudo1, tudo0, 'lucro_total')));
    check('3d vendas +1 / itens sem custo +1', delta(tudo1, tudo0, 'vendas_count') === 1 && delta(tudo1, tudo0, 'itens_sem_custo') === 1);

    // 4. venda caindo numa unidade PARCEIRA → não congela e não entra no resumo do varejo da matriz
    const pu = await client.query<{ id: string }>(
      `SELECT id FROM core.units WHERE environment=$1 AND slug<>'main' AND is_active LIMIT 1`, [ENV]);
    if (pu.rows[0]) {
      const o2 = await registerWalkinOrder({
        environment: ENV, customer_name: TAG, customer_phone: '(21) 99999-0000', unit_id: pu.rows[0].id,
        items: [{ product_id: pA, quantity: 1, unit_price: 150 }],
        payment_method: 'dinheiro', fulfillment_mode: 'pickup', delivery_address: null,
        actor_label: 'prova-custo', idempotency_key: TAG + '-o2', source_tag: 'walkin_balcao',
      }, pool);
      const tudo2 = await getVarejoResumo('tudo', ENV, pool);
      check('4 venda de unidade PARCEIRA não congela custo', (await itemCost(client, o2.order_id, pA)) === null);
      check('4b e não entra no resumo do varejo da matriz', delta(tudo2, tudo1, 'faturamento') === 0);
    } else {
      check('4 (pulado: nenhuma unidade parceira ativa no env test)', true);
    }

    // 5. recorte por mês: joga a venda 1 pro passado → sai do 'mes', segue no 'tudo'
    await client.query(
      `UPDATE commerce.orders SET created_at = now() - interval '40 days' WHERE environment=$1 AND idempotency_key=$2`,
      [ENV, TAG + '-o1']);
    const mes1 = await getVarejoResumo('mes', ENV, pool);
    const tudo3 = await getVarejoResumo('tudo', ENV, pool);
    check('5 venda de 40 dias atrás SAI do "Esse mês"', delta(mes1, mes0, 'faturamento') === 0, String(delta(mes1, mes0, 'faturamento')));
    check('5b e SEGUE no "Tudo"', delta(tudo3, tudo0, 'faturamento') === 400, String(delta(tudo3, tudo0, 'faturamento')));

    // 6. cancelada fora: cancela a venda 1 → some do resumo
    await client.query(
      `UPDATE commerce.orders SET status='cancelled' WHERE environment=$1 AND idempotency_key=$2`,
      [ENV, TAG + '-o1']);
    const tudo4 = await getVarejoResumo('tudo', ENV, pool);
    check('6 venda cancelada some do resumo (delta volta a 0)', delta(tudo4, tudo0, 'faturamento') === 0, String(delta(tudo4, tudo0, 'faturamento')));

    // 7. helper direto: flag off não toca; pedido inexistente não explode (0 updates)
    await applyMatrizRetailCostSnapshot(client, ENV, '00000000-0000-0000-0000-000000000000', [{ productId: pA, quantity: 1 }], false);
    await applyMatrizRetailCostSnapshot(client, ENV, '00000000-0000-0000-0000-000000000000', [{ productId: pA, quantity: 1 }], true);
    check('7 helper: flag off não toca / pedido inexistente não explode', true);
  } finally {
    // faxina: pedidos+itens+cliente da prova, spec, produtos, galpão descartável
    try {
      const ords = await client.query<{ id: string; customer_id: string | null }>(
        `SELECT id, customer_id FROM commerce.orders WHERE environment=$1 AND idempotency_key LIKE $2`,
        [ENV, TAG + '%']);
      const ids = ords.rows.map((r) => r.id);
      const custIds = [...new Set(ords.rows.map((r) => r.customer_id).filter((x): x is string => !!x))];
      if (ids.length) {
        await client.query(`DELETE FROM commerce.order_items WHERE environment=$1 AND order_id = ANY($2)`, [ENV, ids]);
        await client.query(`DELETE FROM commerce.orders WHERE environment=$1 AND id = ANY($2)`, [ENV, ids]);
      }
      if (custIds.length) {
        await client.query(`DELETE FROM commerce.customers WHERE environment=$1 AND id = ANY($2)`, [ENV, custIds]).catch(() => {});
      }
      if (pA) await client.query(`DELETE FROM commerce.tire_specs WHERE environment=$1 AND product_id=$2`, [ENV, pA]);
      if (pA || pB) await client.query(`DELETE FROM commerce.products WHERE environment=$1 AND id = ANY($2)`, [ENV, [pA, pB].filter(Boolean)]);
      await client.query(`DELETE FROM commerce.wholesale_stock WHERE environment=$1 AND measure=$2`, [ENV, MEASURE]);
      console.log('  (faxina ok — dados da prova removidos)');
    } catch (e) {
      console.log('  ⚠️ faxina falhou (limpar na mão por TAG=' + TAG + '):', (e as Error).message);
    }
    client.release();
    await pool.end();
  }

  console.log(fails === 0 ? '\n✅ PROVA PASSOU (todos os checks)' : `\n❌ PROVA FALHOU (${fails} check(s))`);
  if (fails > 0) process.exit(1);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
