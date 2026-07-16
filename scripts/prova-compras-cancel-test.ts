/**
 * Prova real da Etapa 5 para compra: pendência sem estoque, confirmação única,
 * reversão exata e bloqueio integral depois de qualquer consumo.
 *
 * Uso: npx tsx --env-file=.env.pooler scripts/prova-compras-cancel-test.ts
 */
import { randomUUID } from 'node:crypto';

process.env.WHOLESALE_FINANCE = 'true';

const ENV = 'test' as const;
const MEASURE = '99/99-99';
const CREATED_BY = 'prova-compra-etapa5';
const SUPPLIER = `PROVA-COMPRA-ET5-${Date.now()}`;

async function main(): Promise<void> {
  const { pool } = await import('../src/persistence/db.js');
  const { env } = await import('../src/shared/config/env.js');
  const {
    registerWholesaleSupplier, registerWholesalePurchase, confirmWholesalePurchase,
    cancelWholesalePurchase, listWholesaleStock,
  } = await import('../src/admin/painel/queries.js');
  if (env.FAREJADOR_ENV !== ENV) throw new Error('ABORTADO: esta prova só roda em test.');

  const client = await pool.connect();
  const keys: string[] = [];
  let supplierId = '';
  let fails = 0;
  const key = () => { const value = randomUUID(); keys.push(value); return value; };
  const check = (name: string, ok: boolean, extra = '') => {
    if (!ok) fails += 1;
    console.log(`  [${ok ? 'OK ' : 'XX '}] ${name}${extra ? ` — ${extra}` : ''}`);
  };
  const stock = async () => (await listWholesaleStock(ENV, pool)).find((row) => row.measure === MEASURE);

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
       VALUES ($1,$2,5,10)`, [ENV, MEASURE]);
    const supplier = await registerWholesaleSupplier({ environment: ENV, name: SUPPLIER,
      document: '12.345.678/0001-90', phone: '(21) 99999-0101' }, pool);
    supplierId = supplier.id;

    const createKey = key();
    const pendingInput = { environment: ENV, supplier_id: supplier.id, created_by: CREATED_BY,
      receipt_status: 'pending' as const, idempotency_key: createKey,
      items: [{ measure: MEASURE, quantity: 2, unit_cost: 20 }] };
    const pending = await registerWholesalePurchase(pendingInput, pool);
    const pendingReplay = await registerWholesalePurchase(pendingInput, pool);
    check('compra pendente repete o mesmo cabeçalho', pending.purchase_id === pendingReplay.purchase_id);
    check('compra pendente não mexe no galpão', (await stock())?.quantity_on_hand === 5);

    const confirmInput = { purchase_id: pending.purchase_id, confirmed_by: CREATED_BY,
      environment: ENV, idempotency_key: key() };
    const confirmed = await confirmWholesalePurchase(confirmInput, pool);
    const confirmedReplay = await confirmWholesalePurchase(confirmInput, pool);
    check('confirmação repete o mesmo instante', confirmed.confirmed_at === confirmedReplay.confirmed_at);
    check('confirmação aplica exatamente uma entrada',
      (await stock())?.quantity_on_hand === 7 && Number((await stock())?.unit_cost) === 12.86,
      `${(await stock())?.quantity_on_hand}un @${(await stock())?.unit_cost}`);

    const cancelInput = { purchase_id: pending.purchase_id, cancelled_by: CREATED_BY,
      reason: 'registro duplicado', environment: ENV, idempotency_key: key() };
    const cancelled = await cancelWholesalePurchase(cancelInput, pool);
    const cancelledReplay = await cancelWholesalePurchase(cancelInput, pool);
    check('cancelamento idempotente devolve o mesmo instante', cancelled.cancelled_at === cancelledReplay.cancelled_at);
    check('cancelamento restaura saldo e custo anteriores exatos',
      (await stock())?.quantity_on_hand === 5 && Number((await stock())?.unit_cost) === 10,
      `${(await stock())?.quantity_on_hand}un @${(await stock())?.unit_cost}`);

    const unsafe = await registerWholesalePurchase({ environment: ENV, supplier_id: supplier.id,
      created_by: CREATED_BY, receipt_status: 'received', idempotency_key: key(),
      items: [{ measure: MEASURE, quantity: 3, unit_cost: 20 }] }, pool);
    await client.query(
      `UPDATE commerce.wholesale_stock SET quantity_on_hand=quantity_on_hand-1
        WHERE environment=$1 AND measure=$2`, [ENV, MEASURE]);
    let blocked = false;
    try {
      await cancelWholesalePurchase({ purchase_id: unsafe.purchase_id, cancelled_by: CREATED_BY,
        reason: 'tentativa após consumo', environment: ENV, idempotency_key: key() }, pool);
    } catch (error) { blocked = (error as Error).message.startsWith('purchase_stock_consumed:'); }
    const unsafeState = await client.query<{ status: string }>(
      `SELECT status FROM commerce.wholesale_purchases WHERE id=$1`, [unsafe.purchase_id]);
    check('consumo posterior bloqueia sem cancelar a compra', blocked && unsafeState.rows[0]?.status === 'confirmed');
    check('bloqueio não fabrica nem remove unidades', (await stock())?.quantity_on_hand === 7);

    const pendingCancel = await registerWholesalePurchase({ environment: ENV, supplier_id: supplier.id,
      created_by: CREATED_BY, receipt_status: 'pending', idempotency_key: key(),
      items: [{ measure: MEASURE, quantity: 9, unit_cost: 30 }] }, pool);
    await cancelWholesalePurchase({ purchase_id: pendingCancel.purchase_id, cancelled_by: CREATED_BY,
      reason: 'pendência não recebida', environment: ENV, idempotency_key: key() }, pool);
    check('cancelar pendência também não toca estoque', (await stock())?.quantity_on_hand === 7);

    let duplicate = false;
    try {
      await registerWholesaleSupplier({ environment: ENV, name: SUPPLIER.toLowerCase().replaceAll('-', ' '),
        document: '98.765.432/0001-10', phone: '21999990202' }, pool);
    } catch (error) { duplicate = (error as { code?: string }).code === '23505'; }
    check('fornecedor equivalente é recusado', duplicate);

    console.log(`\n${fails === 0 ? '✅ ETAPA 5: COMPRAS/CANCELAMENTO PROVADOS' : `❌ ${fails} CASO(S) FALHARAM`}`);
  } finally {
    await client.query(`DELETE FROM audit.events WHERE environment=$1 AND actor_label=$2`, [ENV, CREATED_BY]);
    await client.query(`DELETE FROM audit.operation_idempotency WHERE environment=$1 AND idempotency_key=ANY($2)`, [ENV, keys]);
    await client.query(`DELETE FROM commerce.wholesale_purchases WHERE environment=$1 AND created_by=$2`, [ENV, CREATED_BY]);
    if (supplierId) await client.query(`DELETE FROM commerce.wholesale_suppliers WHERE id=$1`, [supplierId]);
    await client.query(`DELETE FROM commerce.wholesale_stock WHERE environment=$1 AND measure=$2`, [ENV, MEASURE]);
    await client.query(`DELETE FROM commerce.wholesale_stock_movements WHERE environment=$1 AND measure=$2`, [ENV, MEASURE]);
    await client.query(`DELETE FROM commerce.tire_specs WHERE environment=$1 AND tire_size=$2`, [ENV, MEASURE]);
    client.release();
    await pool.end();
  }
  process.exit(fails > 0 ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
