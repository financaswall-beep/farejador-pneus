/**
 * Prova transacional da 0183 em PostgreSQL real.
 * Aplica 0182+0183, chama o código real e encerra com ROLLBACK externo.
 * Uso: npx tsx --env-file=.env.pooler scripts/prova-transferencia-matriz-parceiro-0183.ts
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Pool, PoolClient } from 'pg';
import type { PartnerContext } from '../src/parceiro/auth.js';

process.env.WHOLESALE_STOCK_DECREMENT = 'true';
process.env.WHOLESALE_FINANCE = 'true';
process.env.MATRIZ_CENTRAL_LEDGER = 'true';

function check(label: string, condition: boolean): void {
  if (!condition) throw new Error(`PROVA_FALHOU: ${label}`);
  console.log(`[OK] ${label}`);
}

function transactionalPool(client: PoolClient): Pool {
  let sequence = 0;
  const stack: string[] = [];
  const proxy = {
    query: async (sql: string, params?: unknown[]) => {
      const command = sql.trim().toUpperCase();
      if (command === 'BEGIN') {
        const savepoint = `proof_app_${++sequence}`;
        stack.push(savepoint);
        return client.query(`SAVEPOINT ${savepoint}`);
      }
      if (command === 'COMMIT') {
        const savepoint = stack.pop();
        if (!savepoint) throw new Error('proof_commit_without_savepoint');
        return client.query(`RELEASE SAVEPOINT ${savepoint}`);
      }
      if (command === 'ROLLBACK') {
        const savepoint = stack.pop();
        if (!savepoint) throw new Error('proof_rollback_without_savepoint');
        await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        return client.query(`RELEASE SAVEPOINT ${savepoint}`);
      }
      return client.query(sql, params);
    },
    release: () => undefined,
  };
  return { connect: async () => proxy } as unknown as Pool;
}

async function constraints(client: PoolClient): Promise<void> {
  await client.query('SET CONSTRAINTS ALL IMMEDIATE');
  await client.query('SET CONSTRAINTS ALL DEFERRED');
}

async function main(): Promise<void> {
  if (process.env.FAREJADOR_ENV !== 'test') {
    throw new Error('ABORTADO: execute somente com FAREJADOR_ENV=test');
  }
  const { pool } = await import('../src/persistence/db.js');
  const {
    registerWholesaleSale,
    cancelWholesaleSale,
    settleWholesaleOrderPayment,
  } = await import('../src/admin/painel/queries.js');
  const { applyPurchaseReceiptStock } = await import('../src/parceiro/purchase-receipt-stock.js');
  const client = await pool.connect();
  const proofPool = transactionalPool(client);
  try {
    await client.query('BEGIN');
    await client.query(readFileSync('db/migrations/0182_stock_end_to_end_integrity.sql', 'utf8'));
    await client.query(readFileSync('db/migrations/0183_matrix_partner_stock_transfer.sql', 'utf8'));
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    check('migrations 0182 e 0183 aplicam juntas', true);

    const suffix = randomUUID().slice(0, 8);
    const measure = '92/92-19';
    const brand = `Prova 0183 ${suffix}`;
    const unit = await client.query<{ id: string }>(
      `INSERT INTO core.units(environment,slug,name,is_active)
       VALUES ('test',$1,$2,true) RETURNING id`,
      [`proof-transfer-${suffix}`, `Unidade prova ${suffix}`],
    );
    const partner = await client.query<{ id: string }>(
      `INSERT INTO network.partners(
         environment,legal_name,trade_name,document_number,status,commercial_model
       ) VALUES ('test',$1,$2,$3,'active','commission') RETURNING id`,
      [`Parceiro prova ${suffix}`, `Parceiro prova ${suffix}`, `proof-${suffix}`],
    );
    const partnerUnit = await client.query<{ id: string }>(
      `INSERT INTO network.partner_units(
         environment,partner_id,unit_id,slug,display_name,status
       ) VALUES ('test',$1,$2,$3,$4,'active') RETURNING id`,
      [partner.rows[0]!.id, unit.rows[0]!.id,
        `proof-transfer-${suffix}`, `Loja prova ${suffix}`],
    );
    const product = await client.query<{ id: string }>(
      `INSERT INTO commerce.products(
         environment,product_code,product_name,product_type,brand,tire_condition
       ) VALUES ('test',$1,$2,'tire',$3,'novo') RETURNING id`,
      [`PROOF-0183-${suffix}`, `Pneu prova ${suffix}`, brand],
    );
    await client.query(
      `INSERT INTO commerce.tire_specs(
         environment,product_id,tire_size,width_mm,aspect_ratio,rim_diameter
       ) VALUES ('test',$1,$2,92,92,19)`,
      [product.rows[0]!.id, measure],
    );
    await client.query(
      `SELECT set_config('app.galpao_source','entrada',true),
              set_config('app.galpao_nature','opening_balance',true),
              set_config('app.galpao_reason','prova 0183',true),
              set_config('app.galpao_actor','prova:0183',true)`,
    );
    await client.query(
      `INSERT INTO commerce.wholesale_stock(
         environment,measure,brand,tire_condition,quantity_on_hand,quantity_reserved,unit_cost
       ) VALUES ('test',$1,$2,'novo',20,0,100)`,
      [measure, brand],
    );
    check('cenário isolado criado com 20 pneus na Matriz', true);

    const due = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    const original = await registerWholesaleSale({
      environment: 'test', partner_id: partner.rows[0]!.id,
      partner_unit_id: partnerUnit.rows[0]!.id,
      items: [{ measure, brand, tire_condition: 'novo', quantity: 2, unit_price: 150 }],
      payment_status: 'pending', due_date: due, created_by: 'prova:0183',
      idempotency_key: `proof-original-${randomUUID()}`,
    }, proofPool);
    await constraints(client);
    check('venda original fica vinculada à unidade parceira',
      original.partner_unit_id === partnerUnit.rows[0]!.id
      && original.linked_partner_purchase_id !== null);

    const originalState = await client.query<{
      matrix_qty: number; purchase_status: string; partner_total: string;
      partner_cost: string; payable_status: string; revenue: string; cogs: string;
    }>(
      `SELECT stock.quantity_on_hand AS matrix_qty,p.receipt_status AS purchase_status,
              p.total_amount::text AS partner_total,i.unit_cost::text AS partner_cost,
              payable.status AS payable_status,
              (SELECT amount::text FROM finance.matriz_ledger_transactions
                WHERE environment='test' AND source_type='commerce.wholesale_order.revenue'
                  AND source_id=$1) AS revenue,
              (SELECT amount::text FROM finance.matriz_ledger_transactions
                WHERE environment='test' AND source_type='commerce.wholesale_order.cogs'
                  AND source_id=$1) AS cogs
         FROM commerce.wholesale_stock stock
         JOIN commerce.partner_purchases p ON p.id=$2
         JOIN commerce.partner_purchase_items i ON i.purchase_id=p.id
         JOIN finance.partner_payables payable ON payable.source_purchase_id=p.id
        WHERE stock.environment='test' AND stock.measure=$3 AND stock.brand=$4
          AND stock.tire_condition='novo'`,
      [original.order_id, original.linked_partner_purchase_id, measure, brand],
    );
    const first = originalState.rows[0]!;
    check('2 pneus saem da Matriz: 20 - 2 = 18', Number(first.matrix_qty) === 18);
    check('parceiro recebe documento pendente por R$300 a custo unitário R$150',
      first.purchase_status === 'pending' && first.partner_total === '300.00'
      && first.partner_cost === '150.00');
    check('financeiro espelha R$300 a receber e R$300 a pagar',
      first.payable_status === 'open' && first.revenue === '300.00');
    check('CMV da Matriz congela 2 × R$100 = R$200', first.cogs === '200.00');

    const addition = await registerWholesaleSale({
      environment: 'test', parent_order_id: original.order_id,
      partner_unit_id: partnerUnit.rows[0]!.id,
      items: [{ measure, brand, tire_condition: 'novo', quantity: 1, unit_price: 160 }],
      payment_status: 'pending', due_date: due, created_by: 'prova:0183',
      idempotency_key: `proof-addition-${randomUUID()}`,
    }, proofPool);
    await constraints(client);
    check('acréscimo depois da saída aponta para o pedido original',
      addition.parent_order_id === original.order_id
      && addition.linked_partner_purchase_id !== null);
    const afterAddition = await client.query<{ qty: number; additions: number; linked: number }>(
      `SELECT stock.quantity_on_hand AS qty,
              (SELECT count(*)::int FROM commerce.wholesale_orders
                WHERE environment='test' AND parent_order_id=$3) AS additions,
              (SELECT count(*)::int FROM commerce.partner_purchases
                WHERE environment='test' AND source_wholesale_order_id=$4) AS linked
         FROM commerce.wholesale_stock stock
        WHERE stock.environment='test' AND stock.measure=$1 AND stock.brand=$2
          AND stock.tire_condition='novo'`,
      [measure, brand, original.order_id, addition.order_id],
    );
    check('extra também sai da Matriz: 18 - 1 = 17', Number(afterAddition.rows[0]!.qty) === 17);
    check('acréscimo tem lançamento e recebimento próprios',
      Number(afterAddition.rows[0]!.additions) === 1
      && Number(afterAddition.rows[0]!.linked) === 1);

    const purchaseItem = await client.query<{
      id: string; item_name: string; quantity: number; unit_cost: string;
      tire_size: string; brand: string; tire_condition: 'novo';
    }>(
      `SELECT id,item_name,quantity,unit_cost::text,tire_size,brand,tire_condition
         FROM commerce.partner_purchase_items
        WHERE environment='test' AND purchase_id=$1`,
      [original.linked_partner_purchase_id],
    );
    const context: PartnerContext = {
      environment: 'test', partnerId: partner.rows[0]!.id,
      partnerUnitId: partnerUnit.rows[0]!.id, unitId: unit.rows[0]!.id,
      tokenId: randomUUID(), slug: `proof-${suffix}`,
      partnerName: `Parceiro prova ${suffix}`, unitName: `Loja prova ${suffix}`,
      role: 'funcionario',
    };
    const item = purchaseItem.rows[0]!;
    const move = await applyPurchaseReceiptStock(client, context, {
      id: item.id,product_id: null,item_name:item.item_name,quantity:Number(item.quantity),
      unit_cost:item.unit_cost,tire_size:item.tire_size,tire_width_mm:92,
      tire_aspect_ratio:92,tire_rim_diameter:19,brand:item.brand,sale_price:null,
      tire_condition:item.tire_condition,
    }, 2, 'Matriz 2W Pneus', 'prova:0183');
    await client.query(
      `UPDATE commerce.partner_purchase_items
          SET received_quantity=2,received_stock_id=$2,
              received_stock_quantity_before=$3,received_stock_average_cost_before=$4,
              received_stock_quantity_after=$5,received_stock_average_cost_after=$6
        WHERE id=$1`,
      [item.id,move!.stock_id,move!.previous_qty,move!.previous_average_cost,
        move!.new_qty,move!.new_average_cost],
    );
    await client.query(
      `UPDATE commerce.partner_purchases
          SET receipt_status='received',received_at=now(),received_by_label='prova 0183',
              receipt_idempotency_key=$2
        WHERE id=$1`,
      [original.linked_partner_purchase_id, `proof-receipt-${randomUUID()}`],
    );
    await constraints(client);
    check('parceiro confirma 2 e passa a ter exatamente 2 pneus',
      move?.new_qty === 2 && move?.new_average_cost === '150.000000');

    await client.query('SAVEPOINT overreceipt');
    try {
      await client.query(
        `UPDATE commerce.partner_purchase_items SET received_quantity=3 WHERE id=$1`,
        [item.id],
      );
      throw new Error('PROVA_FALHOU: banco aceitou recebimento maior que o envio');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await client.query('ROLLBACK TO SAVEPOINT overreceipt');
      check('banco recusa receber mais que o enviado',
        message.includes('matrix_linked_purchase_item_values_mismatch'));
    }

    await settleWholesaleOrderPayment(original.order_id, 'test', proofPool, {
      idempotency_key: `proof-payment-${randomUUID()}`, actor_label: 'prova:0183',
      paid_at: new Date().toISOString(), payment_method: 'pix',
    });
    await constraints(client);
    const paid = await client.query<{ matrix: string; partner: string; payment_count: number }>(
      `SELECT o.payment_status AS matrix,payable.status AS partner,
              (SELECT count(*)::int FROM finance.matriz_ledger_transactions
                WHERE environment='test' AND source_type='commerce.wholesale_order.payment'
                  AND source_id=o.id::text) AS payment_count
         FROM commerce.wholesale_orders o
         JOIN commerce.partner_purchases p ON p.source_wholesale_order_id=o.id
         JOIN finance.partner_payables payable ON payable.source_purchase_id=p.id
        WHERE o.environment='test' AND o.id=$1`,
      [original.order_id],
    );
    check('pagamento na Matriz quita também a conta do parceiro',
      paid.rows[0]!.matrix === 'paid' && paid.rows[0]!.partner === 'paid'
      && Number(paid.rows[0]!.payment_count) === 1);

    await cancelWholesaleSale({
      order_id: addition.order_id,environment:'test',cancelled_by:'prova:0183',
      reason:'extra não comprado',idempotency_key:`proof-cancel-addition-${randomUUID()}`,
    }, proofPool);
    await constraints(client);
    const cancelledExtra = await client.query<{
      matrix_qty: number; purchase_deleted: boolean; payable_status: string;
    }>(
      `SELECT stock.quantity_on_hand AS matrix_qty,(p.deleted_at IS NOT NULL) AS purchase_deleted,
              payable.status AS payable_status
         FROM commerce.wholesale_stock stock
         JOIN commerce.partner_purchases p ON p.id=$3
         JOIN finance.partner_payables payable ON payable.source_purchase_id=p.id
        WHERE stock.environment='test' AND stock.measure=$1 AND stock.brand=$2
          AND stock.tire_condition='novo'`,
      [measure,brand,addition.linked_partner_purchase_id],
    );
    check('extra recusado volta à Matriz: 17 + 1 = 18',
      Number(cancelledExtra.rows[0]!.matrix_qty) === 18);
    check('cancelar extra pendente cancela documento e conta do parceiro',
      cancelledExtra.rows[0]!.purchase_deleted
      && cancelledExtra.rows[0]!.payable_status === 'cancelled');

    try {
      await cancelWholesaleSale({
        order_id: original.order_id,environment:'test',cancelled_by:'prova:0183',
        reason:'não pode após recebimento',idempotency_key:`proof-cancel-original-${randomUUID()}`,
      }, proofPool);
      throw new Error('PROVA_FALHOU: cancelou venda já recebida pelo parceiro');
    } catch (error) {
      check('venda já recebida não pode duplicar devolução na Matriz',
        error instanceof Error && error.message === 'partner_receipt_already_confirmed');
    }

    const conservation = await client.query<{ matrix_qty: number; partner_qty: number }>(
      `SELECT stock.quantity_on_hand AS matrix_qty,
              COALESCE((SELECT sum(quantity_on_hand)::int
                FROM commerce.partner_stock_levels
                WHERE environment='test' AND unit_id=$3 AND brand=$2),0) AS partner_qty
         FROM commerce.wholesale_stock stock
        WHERE stock.environment='test' AND stock.measure=$1 AND stock.brand=$2
          AND stock.tire_condition='novo'`,
      [measure,brand,unit.rows[0]!.id],
    );
    check('conservação física fecha: Matriz 18 + parceiro 2 = 20',
      Number(conservation.rows[0]!.matrix_qty) === 18
      && Number(conservation.rows[0]!.partner_qty) === 2);
    console.log('PROVA 0183 APROVADA; transação externa será revertida.');
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
