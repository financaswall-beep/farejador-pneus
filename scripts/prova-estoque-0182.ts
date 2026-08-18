/**
 * Prova transacional da migration 0182 em PostgreSQL real.
 * Aplica schema, cria dados descartáveis, força violações e encerra com ROLLBACK.
 * Uso: npx tsx --env-file=.env.pooler scripts/prova-estoque-0182.ts
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { PoolClient } from 'pg';
import { pool } from '../src/persistence/db.js';
import type { PartnerContext } from '../src/parceiro/auth.js';
import { reversePurchaseStockCost } from '../src/parceiro/partner-stock-cost.js';
import { applyPurchaseReceiptStock } from '../src/parceiro/purchase-receipt-stock.js';

function check(label: string, condition: boolean): void {
  if (!condition) throw new Error(`PROVA_FALHOU: ${label}`);
  console.log(`[OK] ${label}`);
}

async function expectDatabaseRejection(
  client: PoolClient,
  label: string,
  action: () => Promise<unknown>,
  expected: string,
): Promise<void> {
  await client.query('SAVEPOINT stock_expected_failure');
  try {
    await action();
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    throw new Error(`NAO_REJEITOU:${label}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await client.query('ROLLBACK TO SAVEPOINT stock_expected_failure');
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    if (!message.includes(expected)) {
      throw new Error(`PROVA_FALHOU: ${label}; banco respondeu: ${message}`);
    }
    check(label, true);
  }
}

async function main(): Promise<void> {
  if (process.env.FAREJADOR_ENV !== 'test') throw new Error('ABORTADO: execute somente com FAREJADOR_ENV=test');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const migration = readFileSync('db/migrations/0182_stock_end_to_end_integrity.sql', 'utf8');
    await client.query(migration);
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    check('migration 0182 aplica dentro da transação', true);

    const units = await client.query<{ id: string }>(
      `SELECT id FROM core.units WHERE environment='test' ORDER BY id LIMIT 2`,
    );
    check('há duas unidades de teste para provar isolamento', units.rows.length === 2);
    const unitA = units.rows[0]!.id;
    const unitB = units.rows[1]!.id;
    const itemName = `PROVA-0182-${randomUUID()}`;
    const sharedKey = `prova-0182-${randomUUID()}`;

    const stockA = await client.query<{ id: string }>(
      `INSERT INTO commerce.partner_stock_levels (
         environment,unit_id,item_name,tire_size,brand,supplier_name,tire_condition,
         quantity_on_hand,average_cost,is_tracked,stock_status,updated_by
       ) VALUES ('test',$1,$2,'90/90-18','Marca prova','Fornecedor prova','novo',
                 3,100.000000,true,'in_stock','prova:0182') RETURNING id`,
      [unitA, itemName],
    );
    await expectDatabaseRejection(client, 'identidade física duplicada é recusada', async () => {
      await client.query(
        `INSERT INTO commerce.partner_stock_levels (
           environment,unit_id,item_name,tire_size,brand,supplier_name,tire_condition,
           quantity_on_hand,average_cost,is_tracked,stock_status
         ) VALUES ('test',$1,$2,'90/90-18','Marca prova','Fornecedor prova','novo',
                   1,100,true,'in_stock')`,
        [unitA, itemName.toLowerCase()],
      );
    }, 'partner_stock_natural_key_uniq');
    await expectDatabaseRejection(client, 'estoque positivo não pode ser escondido', async () => {
      await client.query(
        `UPDATE commerce.partner_stock_levels SET deleted_at=now() WHERE id=$1`,
        [stockA.rows[0]!.id],
      );
    }, 'stock_positive_cannot_delete');

    await expectDatabaseRejection(client, 'compra futura é recusada pelo banco', async () => {
      await client.query(
        `INSERT INTO commerce.partner_purchases (
           environment,unit_id,total_amount,idempotency_key,purchased_at,receipt_status
         ) VALUES ('test',$1,0,$2,now()+interval '1 day','pending')`,
        [unitA, `future-${randomUUID()}`],
      );
    }, 'partner_purchased_at_future');

    const purchaseA = await client.query<{ id: string }>(
      `INSERT INTO commerce.partner_purchases (
         environment,unit_id,supplier_name,total_amount,idempotency_key,receipt_status
       ) VALUES ('test',$1,'Fornecedor prova',400,$2,'pending') RETURNING id`,
      [unitA, sharedKey],
    );
    const itemA = await client.query<{ id: string }>(
      `INSERT INTO commerce.partner_purchase_items (
         environment,purchase_id,item_name,quantity,unit_cost,tire_size,brand,tire_condition
       ) VALUES ('test',$1,$2,2,200,'90/90-18','Marca prova','novo') RETURNING id`,
      [purchaseA.rows[0]!.id, itemName],
    );
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    check('total da compra igual à soma dos itens é aceito', true);

    const context: PartnerContext = {
      environment: 'test', unitId: unitA, partnerUnitId: randomUUID(),
      partnerId: randomUUID(), tokenId: randomUUID(), slug: 'prova-0182',
      partnerName: 'Prova', unitName: 'Unidade prova', role: 'funcionario',
    };
    const move = await applyPurchaseReceiptStock(client, context, {
      id: itemA.rows[0]!.id, product_id: null, item_name: itemName, quantity: 2,
      unit_cost: '200.00', tire_size: '90/90-18', tire_width_mm: 90,
      tire_aspect_ratio: 90, tire_rim_diameter: 18, brand: 'Marca prova',
      sale_price: null, tire_condition: 'novo',
    }, 2, 'Fornecedor prova', 'prova:0182');
    check('recebimento soma 3 + 2 = 5', move?.new_qty === 5);
    check('custo médio calcula (3×100 + 2×200) ÷ 5 = 140', move?.new_average_cost === '140.000000');

    await client.query(
      `UPDATE commerce.partner_purchase_items
          SET received_quantity=2,received_stock_id=$2,
              received_stock_quantity_before=3,received_stock_average_cost_before=100,
              received_stock_quantity_after=5,received_stock_average_cost_after=140
        WHERE id=$1`,
      [itemA.rows[0]!.id, stockA.rows[0]!.id],
    );
    check('snapshot causal do recebimento é aceito', true);

    const stockB = await client.query<{ id: string }>(
      `INSERT INTO commerce.partner_stock_levels (
         environment,unit_id,item_name,tire_size,brand,supplier_name,tire_condition,
         quantity_on_hand,average_cost,is_tracked,stock_status
       ) VALUES ('test',$1,$2,'80/100-14','Outra marca','Outro fornecedor','novo',
                 1,50,true,'in_stock') RETURNING id`,
      [unitB, `${itemName}-outra-loja`],
    );
    await expectDatabaseRejection(client, 'recebimento não pode apontar para estoque de outra loja', async () => {
      await client.query(
        `UPDATE commerce.partner_purchase_items SET received_stock_id=$2 WHERE id=$1`,
        [itemA.rows[0]!.id, stockB.rows[0]!.id],
      );
    }, 'partner_purchase_received_stock_unit_mismatch');

    await expectDatabaseRejection(client, 'cabeçalho divergente da soma dos itens é recusado', async () => {
      await client.query(`UPDATE commerce.partner_purchases SET total_amount=399 WHERE id=$1`, [purchaseA.rows[0]!.id]);
    }, 'partner_purchase_total_mismatch');

    await client.query(
      `INSERT INTO commerce.partner_purchases (
         environment,unit_id,supplier_name,total_amount,idempotency_key,receipt_status
       ) VALUES ('test',$1,'Outra loja',0,$2,'pending')`,
      [unitB, sharedKey],
    );
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    check('mesma idempotência em lojas diferentes não colide', true);

    const reversal = reversePurchaseStockCost({
      current_quantity: 5, current_average_cost: '140.000000',
      reversed_quantity: 2, purchase_unit_cost: '200.00',
    });
    check('cancelamento restaura quantidade 3', reversal.next_quantity === 3);
    check('cancelamento restaura custo médio 100', reversal.next_average_cost === '100.000000');

    const matrixMismatch = await client.query<{ count: string }>(
      `SELECT count(*)::text
         FROM commerce.wholesale_stock stock
        WHERE COALESCE((SELECT sum(m.qty_delta)
          FROM commerce.wholesale_stock_movements m
         WHERE m.environment=stock.environment AND m.measure=stock.measure
           AND m.brand=stock.brand AND m.tire_condition=stock.tire_condition),0)
          <>stock.quantity_on_hand`,
    );
    check('filme da Matriz recompõe todos os saldos atuais', Number(matrixMismatch.rows[0]!.count) === 0);
    console.log('PROVA 0182 APROVADA — nenhuma linha foi persistida (ROLLBACK).');
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
