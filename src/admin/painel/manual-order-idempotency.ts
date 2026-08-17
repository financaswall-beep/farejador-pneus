import type { PoolClient } from 'pg';
import type { RegisterManualOrderInput } from './queries-pedidos.js';
import { operationFingerprint } from './stage5-integrity.js';

interface ExistingManualOrder {
  id: string;
  environment: 'prod' | 'test';
  source: string;
  request_fingerprint: string | null;
}

export interface ManualOrderIdempotency {
  fingerprint: string;
  replayOrderId: string | null;
}

export async function beginManualOrderIdempotency(
  client: PoolClient,
  environment: 'prod' | 'test',
  input: RegisterManualOrderInput,
): Promise<ManualOrderIdempotency> {
  const source = input.source_tag
    ?? (input.draft_id ? 'chatwoot_com_bot' : 'chatwoot_sem_bot');
  const fingerprint = operationFingerprint({
    contact_id: input.contact_id ?? null, conversation_id: input.conversation_id,
    draft_id: input.draft_id ?? null, unit_id: input.unit_id ?? null,
    items: input.items.map((item) => ({
      product_id: item.product_id, quantity: item.quantity, unit_price: item.unit_price,
      discount_amount: item.discount_amount ?? 0,
    })),
    payment_method: input.payment_method, payment_due_on: input.payment_due_on ?? null,
    fulfillment_mode: input.fulfillment_mode,
    delivery_address: input.delivery_address?.trim() || null,
    seller_collaborator_id: input.seller_collaborator_id ?? null, source,
  });
  // O indice legado de commerce.orders ainda e global. O lock impede que um
  // retry de outro ambiente reaproveite silenciosamente o pedido.
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `manual-order:${input.idempotency_key}`,
  ]);
  const existing = await client.query<ExistingManualOrder>(
    `SELECT o.id,o.environment::text AS environment,o.source,
            (SELECT a.payload_after->>'request_fingerprint' FROM audit.events a
              WHERE a.environment=o.environment AND a.entity_id=o.id
                AND a.event_type='manual_order_request_fingerprint'
              ORDER BY a.created_at DESC LIMIT 1) AS request_fingerprint
       FROM commerce.orders o WHERE o.idempotency_key=$1 LIMIT 1`,
    [input.idempotency_key],
  );
  const row = existing.rows[0];
  if (!row) return { fingerprint, replayOrderId: null };
  if (row.environment !== environment || row.source !== source
    || (row.request_fingerprint && row.request_fingerprint !== fingerprint)) {
    throw new Error('manual_order_idempotency_conflict');
  }
  return { fingerprint, replayOrderId: row.id };
}

export async function recordManualOrderFingerprint(
  client: PoolClient,
  environment: 'prod' | 'test',
  orderId: string,
  input: RegisterManualOrderInput,
  fingerprint: string,
): Promise<void> {
  await client.query(
    `INSERT INTO audit.events (
       environment,domain,entity_table,entity_id,event_type,
       actor_label,idempotency_key,payload_after
     ) VALUES ($1,'orders','commerce.orders',$2,'manual_order_request_fingerprint',
               $3,$4,$5::jsonb)`,
    [environment, orderId, input.actor_label, input.idempotency_key,
     JSON.stringify({ request_fingerprint: fingerprint })],
  );
}
