/**
 * Prova real e reversivel da 0184: recusa parcial, redirecionamento da carga,
 * retorno fisico, recebimento do parceiro, financeiro e conservacao de pneus.
 * Uso: npx tsx --env-file=.env.pooler scripts/prova-acerto-chegada-parceiro-0184.ts
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Pool, PoolClient } from 'pg';
import type { PartnerContext } from '../src/parceiro/auth.js';
import type { PurchaseReceiptItem } from '../src/parceiro/purchase-receipt-stock.js';

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
        const savepoint = `proof_0184_${++sequence}`;
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

async function createPartner(client: PoolClient, suffix: string, label: string) {
  const unit = await client.query<{ id: string }>(
    `INSERT INTO core.units(environment,slug,name,is_active)
     VALUES ('test',$1,$2,true) RETURNING id`,
    [`proof-0184-${label}-${suffix}`, `Unidade ${label} ${suffix}`],
  );
  const partner = await client.query<{ id: string }>(
    `INSERT INTO network.partners(
       environment,legal_name,trade_name,document_number,status,commercial_model
     ) VALUES ('test',$1,$1,$2,'active','commission') RETURNING id`,
    [`Parceiro ${label} ${suffix}`, `proof-0184-${label}-${suffix}`],
  );
  const partnerUnit = await client.query<{ id: string }>(
    `INSERT INTO network.partner_units(
       environment,partner_id,unit_id,slug,display_name,status
     ) VALUES ('test',$1,$2,$3,$4,'active') RETURNING id`,
    [partner.rows[0]!.id, unit.rows[0]!.id,
      `proof-0184-${label}-${suffix}`, `Loja ${label} ${suffix}`],
  );
  const context: PartnerContext = {
    environment: 'test', partnerId: partner.rows[0]!.id,
    partnerUnitId: partnerUnit.rows[0]!.id, unitId: unit.rows[0]!.id,
    tokenId: randomUUID(), slug: `proof-${label}-${suffix}`,
    partnerName: `Parceiro ${label}`, unitName: `Loja ${label}`, role: 'funcionario',
  };
  return { partnerId: partner.rows[0]!.id, partnerUnitId: partnerUnit.rows[0]!.id,
    unitId: unit.rows[0]!.id, context };
}

async function receivePurchase(
  client: PoolClient, purchaseId: string, context: PartnerContext,
  applyStock: typeof import('../src/parceiro/purchase-receipt-stock.js').applyPurchaseReceiptStock,
): Promise<void> {
  const rows = await client.query<PurchaseReceiptItem & { confirmed_quantity: number }>(
    `SELECT id,product_id,item_name,quantity,unit_cost,tire_size,tire_width_mm,
            tire_aspect_ratio,tire_rim_diameter,brand,sale_price,tire_condition,
            confirmed_quantity
       FROM commerce.partner_purchase_items
      WHERE environment='test' AND purchase_id=$1 ORDER BY created_at,id FOR UPDATE`,
    [purchaseId],
  );
  for (const item of rows.rows) {
    const received = Number(item.confirmed_quantity);
    const move = await applyStock(
      client, context, item, received, 'Matriz 2W Pneus', 'prova:0184',
    );
    await client.query(
      `UPDATE commerce.partner_purchase_items
          SET received_quantity=$2,received_stock_id=$3,
              received_stock_quantity_before=$4,received_stock_average_cost_before=$5,
              received_stock_quantity_after=$6,received_stock_average_cost_after=$7
        WHERE id=$1`,
      [item.id, received, move?.stock_id ?? null, move?.previous_qty ?? null,
        move?.previous_average_cost ?? null, move?.new_qty ?? null,
        move?.new_average_cost ?? null],
    );
  }
  await client.query(
    `UPDATE commerce.partner_purchases
        SET receipt_status='received',received_at=now(),received_by_label='prova 0184',
            receipt_idempotency_key=$2
      WHERE id=$1`,
    [purchaseId, `proof-receipt-${randomUUID()}`],
  );
}

async function main(): Promise<void> {
  if (process.env.FAREJADOR_ENV !== 'test') {
    throw new Error('ABORTADO: execute somente com FAREJADOR_ENV=test');
  }
  const { pool } = await import('../src/persistence/db.js');
  const { registerWholesaleSale, settlePartnerArrival, returnPartnerCargoToMatrix }
    = await import('../src/admin/painel/queries.js');
  const { applyPurchaseReceiptStock } = await import('../src/parceiro/purchase-receipt-stock.js');
  const client = await pool.connect();
  const proofPool = transactionalPool(client);
  try {
    await client.query('BEGIN');
    for (const migration of [
      '0182_stock_end_to_end_integrity.sql',
      '0183_matrix_partner_stock_transfer.sql',
      '0184_partner_arrival_item_adjustments.sql',
    ]) await client.query(readFileSync(`db/migrations/${migration}`, 'utf8'));
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    check('migrations 0182, 0183 e 0184 aplicam juntas', true);

    const suffix = randomUUID().slice(0, 8);
    const measure = '93/93-19';
    const brand = `Usado Prova 0184 ${suffix}`;
    const partnerA = await createPartner(client, suffix, 'a');
    const partnerB = await createPartner(client, suffix, 'b');
    const product = await client.query<{ id: string }>(
      `INSERT INTO commerce.products(
         environment,product_code,product_name,product_type,brand,tire_condition
       ) VALUES ('test',$1,$2,'tire',$3,'meia_vida') RETURNING id`,
      [`PROOF-0184-${suffix}`, `Pneu usado ${suffix}`, brand],
    );
    await client.query(
      `INSERT INTO commerce.tire_specs(
         environment,product_id,tire_size,width_mm,aspect_ratio,rim_diameter
       ) VALUES ('test',$1,$2,93,93,19)`,
      [product.rows[0]!.id, measure],
    );
    await client.query(
      `SELECT set_config('app.galpao_source','entrada',true),
              set_config('app.galpao_nature','opening_balance',true),
              set_config('app.galpao_reason','prova 0184',true),
              set_config('app.galpao_actor','prova:0184',true)`,
    );
    await client.query(
      `INSERT INTO commerce.wholesale_stock(
         environment,measure,brand,tire_condition,quantity_on_hand,quantity_reserved,unit_cost
       ) VALUES ('test',$1,$2,'meia_vida',31,0,100)`,
      [measure, brand],
    );
    check('cenário começa com 31 pneus usados na Matriz', true);

    const due = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    const saleA = await registerWholesaleSale({
      environment: 'test', partner_id: partnerA.partnerId,
      partner_unit_id: partnerA.partnerUnitId,
      items: [{ measure, brand, tire_condition: 'meia_vida', quantity: 30, unit_price: 150 }],
      payment_status: 'pending', due_date: due, created_by: 'prova:0184',
      idempotency_key: `proof-a-${randomUUID()}`,
    }, proofPool);
    const itemA = await client.query<{ id: string }>(
      `SELECT id FROM commerce.wholesale_order_items WHERE order_id=$1`, [saleA.order_id],
    );
    const settledA = await settlePartnerArrival({
      environment: 'test', order_id: saleA.order_id,
      items: [{ order_item_id: itemA.rows[0]!.id, accepted_quantity: 27 }],
      idempotency_key: `proof-arrival-a-${randomUUID()}`, actor_label: 'prova:0184',
    }, proofPool);
    const cargoId = String((settledA.rejected_cargo as Array<{ cargo_lot_id: string }>)[0]!.cargo_lot_id);
    check('de 30 pneus, parceiro A aceita 27 e recusa individualmente 3',
      settledA.accepted_units === 27 && settledA.total_amount === '4050.00');

    const afterRefusal = await client.query<{ matrix_qty: number; cargo_qty: number; payable: string }>(
      `SELECT stock.quantity_on_hand AS matrix_qty,lot.quantity_available AS cargo_qty,
              payable.amount::text AS payable
         FROM commerce.wholesale_stock stock
         JOIN commerce.matrix_partner_cargo_lots lot ON lot.id=$3
         JOIN finance.partner_payables payable ON payable.source_purchase_id=$4
        WHERE stock.environment='test' AND stock.measure=$1 AND stock.brand=$2`,
      [measure, brand, cargoId, saleA.linked_partner_purchase_id],
    );
    check('3 recusados ficam no carro e não voltam falsamente ao estoque da Matriz',
      Number(afterRefusal.rows[0]!.matrix_qty) === 1
      && Number(afterRefusal.rows[0]!.cargo_qty) === 3);
    check('conta do parceiro A cai de R$4.500 para R$4.050',
      afterRefusal.rows[0]!.payable === '4050.00');

    const saleB = await registerWholesaleSale({
      environment: 'test', partner_id: partnerB.partnerId,
      partner_unit_id: partnerB.partnerUnitId,
      items: [{ measure, brand, tire_condition: 'meia_vida', quantity: 1, unit_price: 160 }],
      payment_status: 'paid', created_by: 'prova:0184',
      idempotency_key: `proof-b-${randomUUID()}`,
    }, proofPool);
    const itemB = await client.query<{ id: string }>(
      `SELECT id FROM commerce.wholesale_order_items WHERE order_id=$1`, [saleB.order_id],
    );
    const settledB = await settlePartnerArrival({
      environment: 'test', order_id: saleB.order_id,
      items: [{ order_item_id: itemB.rows[0]!.id, accepted_quantity: 1 }],
      cargo_additions: [{ cargo_lot_id: cargoId, quantity: 2, unit_price: 170 }],
      idempotency_key: `proof-arrival-b-${randomUUID()}`, actor_label: 'prova:0184',
    }, proofPool);
    check('parceiro B aceita 1 do pedido e inclui 2 vindos da recusa anterior',
      settledB.accepted_units === 3 && settledB.total_amount === '500.00');
    const redirected = await client.query<{ matrix_qty: number; cargo_qty: number }>(
      `SELECT stock.quantity_on_hand AS matrix_qty,lot.quantity_available AS cargo_qty
         FROM commerce.wholesale_stock stock
         JOIN commerce.matrix_partner_cargo_lots lot ON lot.id=$3
        WHERE stock.environment='test' AND stock.measure=$1 AND stock.brand=$2`,
      [measure, brand, cargoId],
    );
    check('redirecionar 2 não baixa a Matriz de novo; sobra 1 no carro',
      Number(redirected.rows[0]!.matrix_qty) === 0
      && Number(redirected.rows[0]!.cargo_qty) === 1);

    await client.query('SAVEPOINT invalid_receipt');
    try {
      await client.query(
        `UPDATE commerce.partner_purchases SET receipt_status='received'
          WHERE id=$1`, [saleB.linked_partner_purchase_id],
      );
      throw new Error('banco_aceitou_recebimento_sem_quantidade_exata');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await client.query('ROLLBACK TO SAVEPOINT invalid_receipt');
      check('banco bloqueia confirmar recebimento antes da conferência exata',
        message.includes('matrix_shipment_requires_arrival_adjustment'));
    }

    await receivePurchase(client, saleA.linked_partner_purchase_id!, partnerA.context,
      applyPurchaseReceiptStock);
    await receivePurchase(client, saleB.linked_partner_purchase_id!, partnerB.context,
      applyPurchaseReceiptStock);
    const returned = await returnPartnerCargoToMatrix({
      environment: 'test', cargo_lot_id: cargoId, reason: 'carro retornou ao galpão',
      idempotency_key: `proof-return-${randomUUID()}`, actor_label: 'prova:0184',
    }, proofPool);
    check('o último recusado só volta ao saldo após o retorno físico',
      returned.returned_quantity === 1);

    const final = await client.query<{
      matrix_qty: number; partner_a_qty: number; partner_b_qty: number;
      status_a: string; status_b: string; ledger_a_credit: string; ledger_b_extra: string;
    }>(
      `SELECT stock.quantity_on_hand AS matrix_qty,
              COALESCE((SELECT sum(quantity_on_hand)::int FROM commerce.partner_stock_levels
                WHERE environment='test' AND unit_id=$3 AND brand=$2),0) AS partner_a_qty,
              COALESCE((SELECT sum(quantity_on_hand)::int FROM commerce.partner_stock_levels
                WHERE environment='test' AND unit_id=$4 AND brand=$2),0) AS partner_b_qty,
              oa.partner_transfer_status AS status_a,ob.partner_transfer_status AS status_b,
              (SELECT amount::text FROM finance.matriz_ledger_transactions
                WHERE environment='test' AND source_id=$5::text
                  AND source_type='commerce.wholesale_order.arrival_revenue_decrease') AS ledger_a_credit,
              (SELECT amount::text FROM finance.matriz_ledger_transactions
                WHERE environment='test' AND source_id=$6::text
                  AND source_type='commerce.wholesale_order.arrival_revenue_increase') AS ledger_b_extra
         FROM commerce.wholesale_stock stock
         JOIN commerce.wholesale_orders oa ON oa.id=$5
         JOIN commerce.wholesale_orders ob ON ob.id=$6
        WHERE stock.environment='test' AND stock.measure=$1 AND stock.brand=$2`,
      [measure, brand, partnerA.unitId, partnerB.unitId, saleA.order_id, saleB.order_id],
    );
    const row = final.rows[0]!;
    check('ambos os recebimentos terminam conciliados',
      row.status_a === 'received' && row.status_b === 'received');
    check('financeiro lança R$450 de recusa e R$340 de pneus extras',
      row.ledger_a_credit === '450.00' && row.ledger_b_extra === '340.00');
    check('conservação física fecha: Matriz 1 + A 27 + B 3 = 31',
      Number(row.matrix_qty) === 1 && Number(row.partner_a_qty) === 27
      && Number(row.partner_b_qty) === 3);
    console.log('PROVA 0184 APROVADA; toda a transação será revertida.');
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
