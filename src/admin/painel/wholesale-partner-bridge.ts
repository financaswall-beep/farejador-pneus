import type { PoolClient } from 'pg';

export type Environment = 'prod' | 'test';

export interface ResolvedPartnerUnit {
  partner_unit_id: string;
  unit_id: string;
  display_name: string;
}

export async function resolveWholesalePartnerUnit(
  client: PoolClient,
  environment: Environment,
  partnerId: string | null,
  requestedPartnerUnitId?: string | null,
): Promise<ResolvedPartnerUnit | null> {
  if (!partnerId) {
    if (requestedPartnerUnitId) throw new Error('partner_unit_not_allowed');
    return null;
  }
  const result = await client.query<ResolvedPartnerUnit>(
    `SELECT id AS partner_unit_id,unit_id,display_name
       FROM network.partner_units
      WHERE environment=$1 AND partner_id=$2 AND status='active' AND deleted_at IS NULL
        AND ($3::uuid IS NULL OR id=$3::uuid)
      ORDER BY created_at,id
      FOR SHARE`,
    [environment, partnerId, requestedPartnerUnitId ?? null],
  );
  if (requestedPartnerUnitId) {
    if (!result.rows[0]) throw new Error('partner_unit_not_found');
    return result.rows[0];
  }
  if (result.rows.length === 0) throw new Error('partner_unit_not_found');
  if (result.rows.length > 1) throw new Error('partner_unit_required');
  return result.rows[0]!;
}

export async function createLinkedPartnerPurchase(
  client: PoolClient,
  environment: Environment,
  orderId: string,
  actorLabel: string,
): Promise<{ purchase_id: string; unit_id: string } | null> {
  const source = await client.query<{
    order_id: string;
    partner_unit_id: string | null;
    unit_id: string | null;
    sold_at: string;
    total_amount: string;
    payment_status: 'paid' | 'pending';
    partner_payment_terms: 'cash_on_arrival' | 'credit';
    due_date: string | null;
    parent_order_id: string | null;
  }>(
    `SELECT o.id AS order_id,o.partner_unit_id,pu.unit_id,o.sold_at,o.total_amount,
            o.payment_status,o.partner_payment_terms,o.due_date,o.parent_order_id
       FROM commerce.wholesale_orders o
       LEFT JOIN network.partner_units pu
         ON pu.environment=o.environment AND pu.id=o.partner_unit_id
      WHERE o.environment=$1 AND o.id=$2
      FOR UPDATE OF o`,
    [environment, orderId],
  );
  const order = source.rows[0];
  if (!order) throw new Error('sale_not_found');
  if (!order.partner_unit_id) return null;
  if (!order.unit_id) throw new Error('partner_unit_not_found');

  const purchase = await client.query<{ id: string }>(
    `INSERT INTO commerce.partner_purchases (
       environment,unit_id,supplier_name,purchased_at,total_amount,payment_method,
       notes,created_by,idempotency_key,payment_status,payable_due_date,
       receipt_status,source_wholesale_order_id
     )
      SELECT o.environment,pu.unit_id,'Matriz 2W Pneus',o.sold_at,o.total_amount,
             CASE WHEN o.partner_payment_terms='cash_on_arrival'
                  THEN 'À vista no acerto' ELSE 'A pagar à Matriz' END,
            CASE WHEN o.parent_order_id IS NOT NULL
                 THEN 'Acréscimo da venda da Matriz '||o.parent_order_id::text
                 ELSE 'Venda da Matriz '||o.id::text END,
            $3,$4,
             'payable',COALESCE(o.due_date,
               (o.sold_at AT TIME ZONE 'America/Sao_Paulo')::date),
            'pending',o.id
       FROM commerce.wholesale_orders o
       JOIN network.partner_units pu
         ON pu.environment=o.environment AND pu.id=o.partner_unit_id
      WHERE o.environment=$1 AND o.id=$2
     RETURNING id`,
    [
      environment, order.order_id, `matrix:${actorLabel}`,
      `matrix-wholesale:${order.order_id}`,
    ],
  );
  const purchaseId = purchase.rows[0]!.id;

  const inserted = await client.query(
    `INSERT INTO commerce.partner_purchase_items (
       environment,purchase_id,product_id,item_name,quantity,unit_cost,
       tire_condition,tire_size,brand,sale_price,source_wholesale_order_item_id,
       confirmed_quantity
     )
     SELECT i.environment,$3,NULL,i.measure,i.quantity,i.unit_price,
            i.tire_condition,i.measure,i.brand,NULL,i.id,NULL
       FROM commerce.wholesale_order_items i
      WHERE i.environment=$1 AND i.order_id=$2
      ORDER BY i.created_at,i.id`,
    [environment, orderId, purchaseId],
  );
  if (!inserted.rowCount) throw new Error('linked_partner_purchase_items_missing');

  await client.query(
    `INSERT INTO finance.partner_payables (
       environment,unit_id,counterparty_name,description,category,amount,
       due_date,status,notes,created_by,idempotency_key,source_purchase_id
     ) VALUES (
       $1,$2,'Matriz 2W Pneus',$3,'supplier',$4,
       COALESCE($5::date,($6::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date),
       'open',$7,$8,$9,$10
     )`,
    [
      environment, order.unit_id,
      `Compra da Matriz ${order.order_id.slice(0, 8)}`,
      order.total_amount, order.due_date, order.sold_at,
      `Gerada automaticamente pela venda de atacado ${order.order_id}`,
      `matrix:${actorLabel}`, `purchase:${purchaseId}:payable`, purchaseId,
    ],
  );

  await client.query(
    `INSERT INTO audit.events (
       environment,domain,entity_table,entity_id,event_type,actor_label,payload_after
     ) VALUES ($1,'stock','commerce.partner_purchases',$2,
               'matrix_partner_receipt_created',$3,$4::jsonb)`,
    [environment, purchaseId, `matrix:${actorLabel}`, JSON.stringify({
      wholesale_order_id: orderId,
      parent_order_id: order.parent_order_id,
      partner_unit_id: order.partner_unit_id,
      unit_id: order.unit_id,
      total_amount: order.total_amount,
      payment_status: order.payment_status,
    })],
  );
  return { purchase_id: purchaseId, unit_id: order.unit_id };
}

export async function cancelLinkedPartnerPurchase(
  client: PoolClient,
  environment: Environment,
  orderId: string,
  actorLabel: string,
  reason: string,
): Promise<string | null> {
  const linked = await client.query<{
    purchase_id: string;
    receipt_status: 'pending' | 'received';
    payment_status: 'paid' | 'pending';
  }>(
    `SELECT p.id AS purchase_id,p.receipt_status,o.payment_status
       FROM commerce.partner_purchases p
       JOIN commerce.wholesale_orders o
         ON o.environment=p.environment AND o.id=p.source_wholesale_order_id
      WHERE p.environment=$1 AND p.source_wholesale_order_id=$2 AND p.deleted_at IS NULL
      FOR UPDATE OF p,o`,
    [environment, orderId],
  );
  const row = linked.rows[0];
  if (!row) return null;
  if (row.receipt_status === 'received') throw new Error('partner_receipt_already_confirmed');
  if (row.payment_status === 'paid') throw new Error('matrix_partner_sale_paid_locked');
  const payable = await client.query<{ payable_id: string }>(
    `SELECT id AS payable_id FROM finance.partner_payables
      WHERE environment=$1 AND source_purchase_id=$2 AND deleted_at IS NULL
        AND status='open' FOR UPDATE`,
    [environment, row.purchase_id],
  );
  if (!payable.rows[0]) {
    throw new Error('matrix_partner_payable_not_open');
  }

  await client.query(`SELECT set_config('app.matrix_partner_bridge','on',true)`);
  await client.query(
    `UPDATE finance.partner_payables
        SET status='cancelled',deleted_at=now(),deleted_by=$3
      WHERE environment=$1 AND id=$2 AND status='open'`,
    [environment, payable.rows[0].payable_id, `matrix:${actorLabel}`],
  );
  await client.query(
    `UPDATE commerce.partner_purchases
        SET deleted_at=now(),deleted_by=$3
      WHERE environment=$1 AND id=$2 AND receipt_status='pending'`,
    [environment, row.purchase_id, `matrix:${actorLabel}`],
  );
  await client.query(
    `INSERT INTO audit.events (
       environment,domain,entity_table,entity_id,event_type,actor_label,payload_after
     ) VALUES ($1,'stock','commerce.partner_purchases',$2,
               'matrix_partner_receipt_cancelled',$3,$4::jsonb)`,
    [environment, row.purchase_id, `matrix:${actorLabel}`, JSON.stringify({
      wholesale_order_id: orderId, reason,
    })],
  );
  return row.purchase_id;
}

export async function settleLinkedPartnerPayable(
  client: PoolClient,
  environment: Environment,
  orderId: string,
  paidAt: string,
  actorLabel: string,
  paymentMethod?: string | null,
  amount?: number | null,
  idempotencyKey?: string | null,
): Promise<string | null> {
  const purchase = await client.query<{ purchase_id: string; unit_id: string }>(
    `SELECT p.id AS purchase_id,p.unit_id
       FROM commerce.partner_purchases p
      WHERE p.environment=$1 AND p.source_wholesale_order_id=$2
        AND p.deleted_at IS NULL
      FOR UPDATE OF p`,
    [environment, orderId],
  );
  const row = purchase.rows[0];
  if (!row) return null;
  const payable = await client.query<{ payable_id: string; open_amount: string }>(
    `SELECT p.id AS payable_id,
            GREATEST(p.amount-COALESCE((SELECT sum(e.amount)
              FROM finance.partner_payable_events e
             WHERE e.environment=p.environment AND e.payable_id=p.id),0),0)::text open_amount
       FROM finance.partner_payables p
      WHERE environment=$1 AND source_purchase_id=$2 AND deleted_at IS NULL
        AND status='open' FOR UPDATE OF p`,
    [environment, row.purchase_id],
  );
  if (!payable.rows[0]) throw new Error('matrix_partner_payable_not_open');
  const openAmount = Number(payable.rows[0].open_amount);
  const paidAmount = amount == null ? openAmount : Math.round(amount * 100) / 100;
  if (!(paidAmount > 0) || paidAmount > openAmount + 0.001) {
    throw new Error('matrix_partner_payable_payment_invalid');
  }
  await client.query(`SELECT set_config('app.matrix_partner_bridge','on',true)`);
  const paid = await client.query<{ id: string }>(
    `INSERT INTO finance.partner_payable_events (
       environment,unit_id,payable_id,amount,paid_at,payment_method,
       idempotency_key,created_by
     ) VALUES ($1,$2,$3,$4,$5::timestamptz,$6,$7,$8)
     ON CONFLICT (environment,idempotency_key) DO UPDATE
       SET idempotency_key=EXCLUDED.idempotency_key
     RETURNING id`,
    [environment, row.unit_id, payable.rows[0].payable_id, paidAmount, paidAt,
     paymentMethod?.trim() || 'Nao informado',
     idempotencyKey?.trim() || `matrix-wholesale:${orderId}:payment`,
     `matrix:${actorLabel}`],
  );
  if (!paid.rows[0]) throw new Error('matrix_partner_payable_not_open');
  const full = Math.round((openAmount-paidAmount)*100) === 0;
  if (full) {
    await client.query(
      `UPDATE commerce.partner_purchases
          SET payment_status='paid_now',payable_due_date=NULL,
              payment_method=COALESCE($3,payment_method)
        WHERE environment=$1 AND id=$2 AND payment_status='payable'`,
      [environment, row.purchase_id, paymentMethod?.trim() || null],
    );
  }
  await client.query(
    `INSERT INTO audit.events (
       environment,domain,entity_table,entity_id,event_type,actor_label,payload_after
     ) VALUES ($1,'partner_finance','finance.partner_payables',$2,
               'matrix_linked_partner_payable_paid',$3,$4::jsonb)`,
    [environment, payable.rows[0].payable_id, `matrix:${actorLabel}`, JSON.stringify({
      wholesale_order_id: orderId, source_purchase_id: row.purchase_id,
      unit_id: row.unit_id, paid_at: paidAt, amount: paidAmount,
      remaining_balance: Math.max(0, openAmount-paidAmount), full,
    })],
  );
  return payable.rows[0].payable_id;
}
