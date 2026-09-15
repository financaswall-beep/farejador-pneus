import type { PoolClient } from 'pg';
import type { PurchaseLotInput } from './lot-purchase-money.js';
import { postWholesalePurchaseReceipt, type WholesalePurchaseLedgerState } from './matriz-ledger-purchases.js';

export async function insertPurchaseLot(client: PoolClient, environment: string,
  purchaseId: string, lot: PurchaseLotInput, allocatedCost: number) {
  const result = await client.query<{ id: string; lot_code: string }>(
    `INSERT INTO commerce.tire_lots
      (environment,purchase_id,description,ordered_quantity,products_amount,allocated_cost)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,'LT-'||lpad(lot_number::text,6,'0') lot_code`,
    [environment, purchaseId, lot.description.trim(), lot.quantity, lot.total_cost, allocatedCost]);
  return result.rows[0]!;
}

export async function receivePurchaseLot(client: PoolClient, environment: string,
  purchaseId: string, actor: string, receivedAt: string) {
  const result = await client.query<{ id: string; ordered_quantity: number; allocated_cost: string }>(
    `UPDATE commerce.tire_lots SET accepted_quantity=ordered_quantity,
       quantity_on_hand=ordered_quantity,remaining_cost=allocated_cost
     WHERE environment=$1 AND purchase_id=$2 AND accepted_quantity IS NULL
     RETURNING id,ordered_quantity,allocated_cost`, [environment, purchaseId]);
  const lot = result.rows[0];
  if (!lot) throw new Error('purchase_already_confirmed');
  await client.query(`INSERT INTO commerce.tire_lot_movements
    (environment,lot_id,source,quantity_delta,cost_delta,occurred_at,created_by)
    VALUES ($1,$2,'purchase_receipt',$3,$4,$5,$6)`,
  [environment, lot.id, lot.ordered_quantity, lot.allocated_cost, receivedAt, actor]);
  return lot;
}

export async function confirmLotPurchaseStock(client: PoolClient, purchase: WholesalePurchaseLedgerState,
  actor: string, items?: Array<{ item_id: string; accepted_quantity: number }>) {
  const current = await client.query<{ id: string; ordered_quantity: number }>(
    `SELECT id,ordered_quantity FROM commerce.tire_lots
     WHERE environment=$1 AND purchase_id=$2 FOR UPDATE`, [purchase.environment, purchase.purchaseId]);
  const lot = current.rows[0];
  if (!lot) throw new Error('purchase_not_found');
  // A closed-price lot is received in full; changing its quantity/price requires a corrected purchase.
  if (items && (items.length !== 1 || items[0]!.item_id !== lot.id
    || items[0]!.accepted_quantity !== lot.ordered_quantity)) throw new Error('lot_receipt_quantity_mismatch');
  const at = new Date().toISOString();
  await receivePurchaseLot(client, purchase.environment, purchase.purchaseId, actor, at);
  await client.query(`UPDATE commerce.wholesale_purchases SET status='confirmed',stock_applied=true,
    stock_applied_at=$3,stock_applied_by=$4 WHERE environment=$1 AND id=$2`,
  [purchase.environment, purchase.purchaseId, at, actor]);
  await postWholesalePurchaseReceipt(client, { ...purchase, stockApplied: false }, at, actor);
  return { purchase_id: purchase.purchaseId, confirmed_at: at,
    stock_applied: true as const, catalog_blockers: [] };
}

export async function reverseLotPurchaseStock(client: PoolClient, environment: string,
  purchaseId: string, actor: string) {
  const result = await client.query<{ id: string; quantity_on_hand: number; remaining_cost: string }>(
    `UPDATE commerce.tire_lots SET quantity_on_hand=0,remaining_cost=0
      WHERE environment=$1 AND purchase_id=$2
        AND accepted_quantity IS NOT NULL AND quantity_on_hand=accepted_quantity
        AND quantity_reserved=0 AND remaining_cost=allocated_cost
      RETURNING id,accepted_quantity quantity_on_hand,allocated_cost remaining_cost`, [environment, purchaseId]);
  const lot = result.rows[0];
  if (!lot) throw new Error('purchase_stock_consumed:lot');
  await client.query(`INSERT INTO commerce.tire_lot_movements
    (environment,lot_id,source,quantity_delta,cost_delta,occurred_at,created_by)
    VALUES ($1,$2,'purchase_cancel',$3,$4,now(),$5)`,
  [environment, lot.id, -lot.quantity_on_hand, -Number(lot.remaining_cost), actor]);
  return lot;
}
