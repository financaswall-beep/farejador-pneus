/**
 * Prova real da Etapa 5 no ambiente test: baixa estrita, replay idempotente e
 * concorrência pela última unidade. Escreve fixtures descartáveis e limpa tudo.
 *
 * Uso: npx tsx --env-file=.env.pooler scripts/prova-venda-atacado-baixa-test.ts
 */
import { randomUUID } from 'node:crypto';

process.env.WHOLESALE_STOCK_DECREMENT = 'true';

const ENV = 'test' as const;
const MEASURE = '99/99-99';
const CREATED_BY = 'prova-venda-baixa-etapa5';

async function main(): Promise<void> {
  const { pool } = await import('../src/persistence/db.js');
  const { env } = await import('../src/shared/config/env.js');
  const { registerWholesaleSale } = await import('../src/admin/painel/queries.js');
  if (env.FAREJADOR_ENV !== ENV) throw new Error('ABORTADO: esta prova só roda em test.');

  const client = await pool.connect();
  const keys: string[] = [];
  let buyerId = '';
  let fails = 0;
  const key = () => { const value = randomUUID(); keys.push(value); return value; };
  const check = (name: string, ok: boolean, extra = '') => {
    if (!ok) fails += 1;
    console.log(`  [${ok ? 'OK ' : 'XX '}] ${name}${extra ? ` — ${extra}` : ''}`);
  };
  const stock = async () => Number((await client.query<{ quantity_on_hand: number }>(
    `SELECT quantity_on_hand FROM commerce.wholesale_stock
      WHERE environment=$1 AND measure=$2`, [ENV, MEASURE])).rows[0]?.quantity_on_hand ?? 0);

  try {
    const product = await client.query<{ id: string }>(
      `SELECT id FROM commerce.products
        WHERE environment=$1 AND product_code='FAKE-REDE-PNEU'`, [ENV]);
    if (!product.rows[0]) throw new Error('FAKE-REDE-PNEU não existe no test.');
    await client.query(`DELETE FROM commerce.tire_specs WHERE environment=$1 AND tire_size=$2`, [ENV, MEASURE]);
    await client.query(
      `INSERT INTO commerce.tire_specs
         (environment,product_id,tire_size,width_mm,aspect_ratio,rim_diameter)
       VALUES ($1,$2,$3,99,99,99)`, [ENV, product.rows[0].id, MEASURE]);
    await client.query(`DELETE FROM commerce.wholesale_stock WHERE environment=$1 AND measure=$2`, [ENV, MEASURE]);
    await client.query(
      `INSERT INTO commerce.wholesale_stock (environment,measure,quantity_on_hand,unit_cost)
       VALUES ($1,$2,1,21.25)`, [ENV, MEASURE]);
    buyerId = (await client.query<{ id: string }>(
      `INSERT INTO commerce.wholesale_customers (environment,name)
       VALUES ($1,$2) RETURNING id`, [ENV, `PROVA-VENDA-ET5-${Date.now()}`])).rows[0]!.id;

    const replayKey = key();
    const input = { environment: ENV, customer_id: buyerId, created_by: CREATED_BY,
      items: [{ measure: MEASURE, quantity: 1, unit_price: 50.01 }],
      idempotency_key: replayKey };
    const first = await registerWholesaleSale(input, pool);
    const replay = await registerWholesaleSale(input, pool);
    check('replay devolve a mesma venda', replay.order_id === first.order_id);
    check('replay não baixa duas vezes', await stock() === 0, `${await stock()}un`);
    let conflict = false;
    try {
      await registerWholesaleSale({ ...input,
        items: [{ measure: MEASURE, quantity: 1, unit_price: 51.01 }] }, pool);
    } catch (error) { conflict = (error as Error).message === 'idempotency_conflict'; }
    check('mesma chave com payload diferente conflita', conflict);

    await client.query(
      `UPDATE commerce.wholesale_stock SET quantity_on_hand=1
        WHERE environment=$1 AND measure=$2`, [ENV, MEASURE]);
    const attempts = await Promise.allSettled([key(), key()].map((idempotency_key) =>
      registerWholesaleSale({ environment: ENV, customer_id: buyerId, created_by: CREATED_BY,
        items: [{ measure: MEASURE, quantity: 1, unit_price: 60 }], idempotency_key }, pool)));
    check('corrida da última unidade: uma venda passa', attempts.filter((r) => r.status === 'fulfilled').length === 1);
    check('corrida da última unidade: uma recebe oversell', attempts.filter((r) =>
      r.status === 'rejected' && String(r.reason).includes('oversell')).length === 1);
    check('saldo final nunca fica negativo', await stock() === 0, `${await stock()}un`);

    let forceBlocked = false;
    try {
      await registerWholesaleSale({ environment: ENV, customer_id: buyerId, created_by: CREATED_BY,
        items: [{ measure: MEASURE, quantity: 100, unit_price: 1 }],
        idempotency_key: key(), ...({ allow_oversell: true } as object) }, pool);
    } catch (error) { forceBlocked = (error as Error).message.startsWith('oversell:'); }
    check('não existe bypass allow_oversell', forceBlocked && await stock() === 0);

    console.log(`\n${fails === 0 ? '✅ ETAPA 5: VENDA/ESTOQUE PROVADOS' : `❌ ${fails} CASO(S) FALHARAM`}`);
  } finally {
    await client.query(`DELETE FROM audit.events WHERE environment=$1 AND actor_label=$2`, [ENV, CREATED_BY]);
    await client.query(`DELETE FROM audit.operation_idempotency WHERE environment=$1 AND idempotency_key=ANY($2)`, [ENV, keys]);
    await client.query(
      `DELETE FROM commerce.wholesale_order_items WHERE environment=$1 AND order_id IN
         (SELECT id FROM commerce.wholesale_orders WHERE environment=$1 AND created_by=$2)`, [ENV, CREATED_BY]);
    await client.query(`DELETE FROM commerce.wholesale_orders WHERE environment=$1 AND created_by=$2`, [ENV, CREATED_BY]);
    if (buyerId) await client.query(`DELETE FROM commerce.wholesale_customers WHERE id=$1`, [buyerId]);
    await client.query(`DELETE FROM commerce.wholesale_stock WHERE environment=$1 AND measure=$2`, [ENV, MEASURE]);
    await client.query(`DELETE FROM commerce.wholesale_stock_movements WHERE environment=$1 AND measure=$2`, [ENV, MEASURE]);
    await client.query(`DELETE FROM commerce.tire_specs WHERE environment=$1 AND tire_size=$2`, [ENV, MEASURE]);
    client.release();
    await pool.end();
  }
  process.exit(fails > 0 ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
