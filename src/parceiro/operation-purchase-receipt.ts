import { withPartnerContext } from './db.js';
import type { PartnerContext } from './auth.js';
import {
  applyPurchaseReceiptStock,
  type PurchaseReceiptItem,
  type PurchaseReceiptMove,
} from './purchase-receipt-stock.js';

export interface OperationPurchaseReceiptInput {
  idempotency_key: string;
  items: Array<{ item_id: string; received_quantity: number }>;
}

export class OperationPurchaseReceiptError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly details?: Record<string, unknown>,
  ) {
    super(code);
  }
}

interface PendingPurchaseRow {
  purchase_id: string;
  supplier_name: string | null;
  purchased_at: string;
  created_at: string;
  item_id: string;
  item_name: string;
  tire_size: string | null;
  brand: string | null;
  tire_condition: string | null;
  expected_quantity: number;
}

export async function getOperationPendingPurchases(ctx: PartnerContext): Promise<{ rows: unknown[] }> {
  return withPartnerContext(ctx.partnerUnitId, async (client) => {
    const result = await client.query<PendingPurchaseRow>(
      `SELECT p.id AS purchase_id, p.supplier_name, p.purchased_at, p.created_at,
              i.id AS item_id, i.item_name, i.tire_size, i.brand, i.tire_condition,
              i.quantity AS expected_quantity
         FROM commerce.partner_purchases p
         JOIN commerce.partner_purchase_items i
           ON i.purchase_id=p.id AND i.environment=p.environment
        WHERE p.environment=$1 AND p.unit_id=$2
          AND p.receipt_status='pending' AND p.deleted_at IS NULL
        ORDER BY p.created_at, i.created_at`,
      [ctx.environment, ctx.unitId],
    );
    const purchases = new Map<string, Record<string, unknown> & { items: unknown[] }>();
    for (const row of result.rows) {
      let purchase = purchases.get(row.purchase_id);
      if (!purchase) {
        purchase = {
          purchase_id: row.purchase_id,
          supplier_name: row.supplier_name,
          purchased_at: row.purchased_at,
          created_at: row.created_at,
          items: [],
        };
        purchases.set(row.purchase_id, purchase);
      }
      purchase.items.push({
        item_id: row.item_id,
        item_name: row.item_name,
        tire_size: row.tire_size,
        brand: row.brand,
        tire_condition: row.tire_condition,
        expected_quantity: Number(row.expected_quantity),
      });
    }
    return { rows: [...purchases.values()] };
  });
}

function sameItemSet(expected: PurchaseReceiptItem[], received: OperationPurchaseReceiptInput['items']): boolean {
  if (expected.length !== received.length) return false;
  const ids = new Set(received.map((item) => item.item_id));
  return ids.size === received.length && expected.every((item) => ids.has(item.id));
}

export async function receiveOperationPurchase(
  ctx: PartnerContext,
  actorLabel: string,
  purchaseId: string,
  input: OperationPurchaseReceiptInput,
): Promise<Record<string, unknown>> {
  return withPartnerContext(ctx.partnerUnitId, async (client) => {
    const purchase = await client.query<{
      id: string;
      supplier_name: string | null;
      receipt_status: 'pending' | 'received';
      receipt_idempotency_key: string | null;
      received_at: string | null;
    }>(
      `SELECT id, supplier_name, receipt_status, receipt_idempotency_key, received_at
         FROM commerce.partner_purchases
        WHERE id=$1 AND environment=$2 AND unit_id=$3 AND deleted_at IS NULL
        FOR UPDATE`,
      [purchaseId, ctx.environment, ctx.unitId],
    );
    const purchaseRow = purchase.rows[0];
    if (!purchaseRow) throw new OperationPurchaseReceiptError('purchase_not_found', 404);
    if (purchaseRow.receipt_status === 'received') {
      if (purchaseRow.receipt_idempotency_key === input.idempotency_key) {
        return { purchase_id: purchaseId, received: true, idempotent: true, received_at: purchaseRow.received_at };
      }
      throw new OperationPurchaseReceiptError('purchase_already_received', 409);
    }

    const itemsResult = await client.query<PurchaseReceiptItem>(
      `SELECT id, product_id, item_name, quantity, unit_cost, tire_size,
              tire_width_mm, tire_aspect_ratio, tire_rim_diameter, brand,
              sale_price, tire_condition
         FROM commerce.partner_purchase_items
        WHERE purchase_id=$1 AND environment=$2
        ORDER BY created_at
        FOR UPDATE`,
      [purchaseId, ctx.environment],
    );
    if (!itemsResult.rows.length || !sameItemSet(itemsResult.rows, input.items)) {
      throw new OperationPurchaseReceiptError('purchase_items_mismatch', 409);
    }

    const receivedById = new Map(input.items.map((item) => [item.item_id, item.received_quantity]));
    const actor = `operation:${ctx.tokenId}:${actorLabel}`;
    const moves: PurchaseReceiptMove[] = [];
    const evidence: Array<Record<string, unknown>> = [];
    for (const item of itemsResult.rows) {
      const receivedQuantity = Number(receivedById.get(item.id));
      const expectedQuantity = Number(item.quantity);
      await client.query(
        `UPDATE commerce.partner_purchase_items
            SET received_quantity=$4
          WHERE id=$1 AND purchase_id=$2 AND environment=$3`,
        [item.id, purchaseId, ctx.environment, receivedQuantity],
      );
      const move = await applyPurchaseReceiptStock(
        client, ctx, item, receivedQuantity, purchaseRow.supplier_name, actor,
      );
      if (move) moves.push(move);
      evidence.push({
        item_id: item.id,
        item_name: item.item_name,
        expected_quantity: expectedQuantity,
        received_quantity: receivedQuantity,
        difference: receivedQuantity - expectedQuantity,
      });
    }

    const updated = await client.query<{ received_at: string }>(
      `UPDATE commerce.partner_purchases
          SET receipt_status='received', received_at=now(), received_by_token_id=$4,
              received_by_label=$5, receipt_idempotency_key=$6
        WHERE id=$1 AND environment=$2 AND unit_id=$3 AND receipt_status='pending'
        RETURNING received_at`,
      [purchaseId, ctx.environment, ctx.unitId, ctx.tokenId, actorLabel, input.idempotency_key],
    );
    if (!updated.rows[0]) throw new OperationPurchaseReceiptError('purchase_already_received', 409);

    const hasDivergence = evidence.some((item) => Number(item.difference) !== 0);
    await client.query(
      `INSERT INTO audit.events (
         environment, domain, entity_table, entity_id, event_type, actor_label, payload_after
       ) VALUES ($1,'stock','commerce.partner_purchases',$2,'stock_increment_purchase',$3,$4::jsonb)`,
      [ctx.environment, purchaseId, actor, JSON.stringify({
        purchase_id: purchaseId, unit_id: ctx.unitId, received_by: actorLabel,
        has_divergence: hasDivergence, items: evidence, moves,
      })],
    );

    return {
      purchase_id: purchaseId,
      received: true,
      idempotent: false,
      received_at: updated.rows[0].received_at,
      has_divergence: hasDivergence,
      expected_units: evidence.reduce((sum, item) => sum + Number(item.expected_quantity), 0),
      received_units: evidence.reduce((sum, item) => sum + Number(item.received_quantity), 0),
    };
  });
}
