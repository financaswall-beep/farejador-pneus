import type { Pool, PoolClient } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import {
  beginIntegrityOperation, completeIntegrityOperation, integrityResult,
  operationFingerprint, recordIntegrityEvent,
} from './stage5-integrity.js';

export interface WholesalePurchaseOrderRow {
  id: string;
  order_number: string;
  order_code: string;
  supplier_id: string;
  supplier_name: string;
  status: 'open' | 'closed' | 'cancelled';
  purchases_count: number;
  total_amount: string;
  created_at: string;
}

export async function resolveWholesalePurchaseOrder(
  client: PoolClient,
  environment: 'prod' | 'test',
  supplierId: string,
  createdBy: string,
  requestedId?: string | null,
): Promise<{ id: string; order_number: string; order_code: string }> {
  const result = requestedId
    ? await client.query<{ id: string; order_number: string; order_code: string }>(
      `SELECT o.id,o.order_number::text,
              'OC-'||to_char(o.created_at AT TIME ZONE 'America/Sao_Paulo','YYYY')
                ||'-'||lpad(o.order_number::text,6,'0') order_code
         FROM commerce.wholesale_purchase_orders o
        WHERE o.environment=$1 AND o.id=$2 AND o.supplier_id=$3 AND o.status='open'
        FOR UPDATE`, [environment, requestedId, supplierId])
    : await client.query<{ id: string; order_number: string; order_code: string }>(
      `WITH created AS (
         INSERT INTO commerce.wholesale_purchase_orders
           (environment,supplier_id,created_by)
         VALUES ($1,$2,$3)
         RETURNING id,order_number,created_at
       )
       SELECT id,order_number::text,
              'OC-'||to_char(created_at AT TIME ZONE 'America/Sao_Paulo','YYYY')
                ||'-'||lpad(order_number::text,6,'0') order_code
         FROM created`, [environment, supplierId, createdBy]);
  if (!result.rows[0]) throw new Error('purchase_order_not_open');
  return result.rows[0];
}

export async function listWholesalePurchaseOrders(
  input: { supplier_id?: string; status?: 'open' | 'closed' | 'cancelled';
    environment?: 'prod' | 'test' } = {},
  dbPool: Pool = defaultPool,
): Promise<WholesalePurchaseOrderRow[]> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const result = await dbPool.query<WholesalePurchaseOrderRow>(
    `SELECT o.id,o.order_number::text,
            'OC-'||to_char(o.created_at AT TIME ZONE 'America/Sao_Paulo','YYYY')
              ||'-'||lpad(o.order_number::text,6,'0') order_code,
            o.supplier_id,s.name supplier_name,o.status,
            count(p.id)::int purchases_count,
            COALESCE(sum(p.total_amount) FILTER (WHERE p.status<>'cancelled'),0)
              ::numeric(12,2)::text total_amount,o.created_at
       FROM commerce.wholesale_purchase_orders o
       JOIN commerce.wholesale_suppliers s
         ON s.environment=o.environment AND s.id=o.supplier_id
       LEFT JOIN commerce.wholesale_purchases p
         ON p.environment=o.environment AND p.purchase_order_id=o.id
      WHERE o.environment=$1
        AND ($2::uuid IS NULL OR o.supplier_id=$2)
        AND ($3::text IS NULL OR o.status=$3)
      GROUP BY o.id,s.name
      ORDER BY (o.status='open') DESC,o.created_at DESC,o.id DESC`,
    [environment, input.supplier_id ?? null, input.status ?? null],
  );
  return result.rows;
}

export async function linkWholesalePurchaseOrder(
  input: { purchase_id: string; order_id: string; linked_by: string;
    idempotency_key: string; environment?: 'prod' | 'test' },
  dbPool: Pool = defaultPool,
): Promise<{ purchase_id: string; order_id: string; order_code: string }> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const operation = { environment, domain: 'wholesale_purchase.link_order',
    idempotencyKey: input.idempotency_key,
    fingerprint: operationFingerprint({ purchase_id: input.purchase_id,
      order_id: input.order_id }) };
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const started = await beginIntegrityOperation<{
      purchase_id: string; order_id: string; order_code: string;
    }>(client, operation);
    if (started.replayed) {
      await client.query('COMMIT');
      return started.result;
    }
    const purchase = await client.query<{ supplier_id: string; purchase_order_id: string | null }>(
      `SELECT supplier_id,purchase_order_id FROM commerce.wholesale_purchases
        WHERE environment=$1 AND id=$2 AND status<>'cancelled' FOR UPDATE`,
      [environment, input.purchase_id],
    );
    if (!purchase.rows[0]) throw new Error('purchase_not_found');
    const order = await resolveWholesalePurchaseOrder(
      client, environment, purchase.rows[0].supplier_id, input.linked_by, input.order_id,
    );
    if (purchase.rows[0].purchase_order_id
      && purchase.rows[0].purchase_order_id !== order.id) {
      throw new Error('purchase_already_linked');
    }
    await client.query(
      `UPDATE commerce.wholesale_purchases SET purchase_order_id=$3
        WHERE environment=$1 AND id=$2`, [environment, input.purchase_id, order.id],
    );
    const result = integrityResult({ purchase_id: input.purchase_id,
      order_id: order.id, order_code: order.order_code });
    await recordIntegrityEvent(client, { environment, domain: 'wholesale_purchase',
      entityTable: 'commerce.wholesale_purchases', entityId: input.purchase_id,
      eventType: 'purchase_order_linked', actorLabel: input.linked_by,
      idempotencyKey: operation.idempotencyKey,
      before: { purchase_order_id: purchase.rows[0].purchase_order_id },
      after: { purchase_order_id: order.id, order_code: order.order_code } });
    await completeIntegrityOperation(client, operation,
      'commerce.wholesale_purchases', input.purchase_id, result);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
