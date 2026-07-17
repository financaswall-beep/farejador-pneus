import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import {
  beginIntegrityOperation, completeIntegrityOperation, integrityResult, moneyCents,
  operationFingerprint, recordIntegrityEvent,
} from './stage5-integrity.js';

export interface PartnerPendingCost {
  item_id: string;
  order_id: string;
  partner_unit_id: string;
  partner_name: string;
  item_name: string;
  quantity: number;
  realized_at: string | null;
  current_stock_average_cost: string | null;
  cost_source: string | null;
}

export async function listPartnerPendingCosts(
  dbPool: Pool = defaultPool,
): Promise<PartnerPendingCost[]> {
  const rows = await dbPool.query<PartnerPendingCost>(
    `SELECT oi.id AS item_id,po.id AS order_id,pu.id AS partner_unit_id,
            pu.display_name AS partner_name,oi.item_name,oi.quantity,
            CASE WHEN po.fulfillment_mode='delivery' THEN po.delivered_at
                 ELSE COALESCE(po.retrieved_at,po.created_at) END AS realized_at,
            ps.average_cost AS current_stock_average_cost,oi.cost_source
       FROM commerce.partner_order_items oi
       JOIN commerce.partner_orders po
         ON po.environment=oi.environment AND po.id=oi.order_id
       JOIN network.partner_units pu
         ON pu.environment=po.environment AND pu.unit_id=po.unit_id
       LEFT JOIN commerce.partner_stock_levels ps
         ON ps.environment=oi.environment AND ps.id=oi.partner_stock_id
      WHERE oi.environment=$1 AND oi.cost_status='pending'
      ORDER BY po.created_at,oi.created_at LIMIT 200`,
    [env.FAREJADOR_ENV],
  );
  return rows.rows;
}

export interface ReconcilePartnerCostInput {
  item_id: string;
  unit_cost: number;
  reason: string;
  evidence?: string | null;
  actor_label: string;
  idempotency_key: string;
  environment?: 'prod' | 'test';
}

export async function reconcilePartnerItemCost(
  input: ReconcilePartnerCostInput,
  dbPool: Pool = defaultPool,
): Promise<{ item_id: string; unit_cost_snapshot: string; cost_status: 'known'; replayed?: boolean }> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const unitCost = moneyCents(input.unit_cost) / 100;
  if (!Number.isFinite(unitCost) || unitCost < 0) throw new Error('cost_invalid');
  const reason = input.reason.trim();
  const evidence = input.evidence?.trim() || null;
  if (reason.length < 5 || !input.actor_label.trim()) throw new Error('cost_evidence_required');
  const operation = { environment, domain: 'partner.cost.reconcile',
    idempotencyKey: input.idempotency_key,
    fingerprint: operationFingerprint({ item_id: input.item_id, unit_cost: unitCost,
      reason, evidence }) };
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const replay = await beginIntegrityOperation<{
      item_id: string; unit_cost_snapshot: string; cost_status: 'known';
    }>(client, operation);
    if (replay.replayed) {
      await client.query('COMMIT');
      return { ...replay.result, replayed: true };
    }
    const before = await client.query<{
      id: string; order_id: string; cost_status: string;
      unit_cost_snapshot: string | null; cost_source: string | null;
    }>(
      `SELECT oi.id,oi.order_id,oi.cost_status,oi.unit_cost_snapshot,oi.cost_source
         FROM commerce.partner_order_items oi
        WHERE oi.environment=$1 AND oi.id=$2 FOR UPDATE`,
      [environment,input.item_id],
    );
    if (!before.rows[0]) throw new Error('partner_order_item_not_found');
    if (before.rows[0].cost_status !== 'pending') throw new Error('cost_already_known');

    await client.query("SELECT set_config('app.partner_cost_reconciliation','on',true)");
    const updated = await client.query<{
      id: string; unit_cost_snapshot: string; cost_status: 'known';
    }>(
      `UPDATE commerce.partner_order_items
          SET unit_cost_snapshot=$3,cost_status='known',cost_captured_at=now(),
              cost_source='manual_reconciliation'
        WHERE environment=$1 AND id=$2 AND cost_status='pending'
      RETURNING id,unit_cost_snapshot,cost_status`,
      [environment,input.item_id,unitCost],
    );
    if (!updated.rows[0]) throw new Error('cost_reconciliation_conflict');
    const result = integrityResult({ item_id: updated.rows[0].id,
      unit_cost_snapshot: updated.rows[0].unit_cost_snapshot, cost_status: 'known' as const });
    await recordIntegrityEvent(client,{ environment,domain: 'network',
      entityTable: 'commerce.partner_order_items',entityId: input.item_id,
      eventType: 'partner_item_cost_reconciled',actorLabel: input.actor_label,
      idempotencyKey: input.idempotency_key,before: before.rows[0],
      after: { ...result,reason,evidence,
        order_id: before.rows[0].order_id } });
    await completeIntegrityOperation(client,operation,'commerce.partner_order_items',
      input.item_id,result);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

// O guard da 0137 só aceita reconciliação quando a conexão é a DONA física da
// tabela (current_user == owner), não bastando a variável de sessão. Se a
// blindagem futura trocar a role do app, a reconciliação para de funcionar —
// esta checagem existe para o boot GRITAR nesse dia, em vez de falhar em
// silêncio na primeira tentativa de reconciliar.
export async function costReconciliationOwnershipOk(
  dbPool: Pool = defaultPool,
): Promise<boolean> {
  const r = await dbPool.query<{ ok: boolean }>(
    `SELECT current_user = pg_catalog.pg_get_userbyid(c.relowner) AS ok
       FROM pg_catalog.pg_class c
      WHERE c.oid = 'commerce.partner_order_items'::regclass`,
  );
  return r.rows[0]?.ok === true;
}
