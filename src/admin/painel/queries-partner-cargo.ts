import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { applyWholesaleStockReturn } from './wholesale-stock.js';
import {
  beginIntegrityOperation, completeIntegrityOperation, operationFingerprint,
  recordIntegrityEvent,
} from './stage5-integrity.js';
import { postCargoReturnLedger } from './partner-transfer-arrival-ledger.js';

type Environment = 'prod' | 'test';

export interface CargoLotRow {
  id: string;
  measure: string;
  brand: string;
  tire_condition: string;
  unit_cost: string;
  quantity_loaded: number;
  quantity_available: number;
  source_order_id: string;
  source_buyer_name: string;
  created_at: string;
}

export async function listMatrixPartnerCargo(
  environment: Environment = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<CargoLotRow[]> {
  const result = await dbPool.query<CargoLotRow>(
    `SELECT lot.id,lot.measure,lot.brand,lot.tire_condition,lot.unit_cost,
            lot.quantity_loaded,lot.quantity_available,source_order.id AS source_order_id,
            buyer.name AS source_buyer_name,lot.created_at
       FROM commerce.matrix_partner_cargo_lots lot
       JOIN commerce.wholesale_order_items source_item
         ON source_item.environment=lot.environment
        AND source_item.id=lot.source_wholesale_order_item_id
       JOIN commerce.wholesale_orders source_order
         ON source_order.environment=source_item.environment
        AND source_order.id=source_item.order_id
       JOIN commerce.wholesale_customers buyer
         ON buyer.environment=source_order.environment AND buyer.id=source_order.buyer_id
      WHERE lot.environment=$1 AND lot.quantity_available>0 AND lot.status='open'
      ORDER BY lot.created_at,lot.id`,
    [environment],
  );
  return result.rows;
}

export async function returnPartnerCargoToMatrix(
  input: { cargo_lot_id: string; reason: string; idempotency_key: string;
    actor_label: string; environment?: Environment },
  dbPool: Pool = defaultPool,
): Promise<Record<string, unknown>> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const client = await dbPool.connect();
  const operation = { environment, domain: 'matrix_partner.cargo_return',
    idempotencyKey: input.idempotency_key, fingerprint: operationFingerprint({
      cargo_lot_id: input.cargo_lot_id, reason: input.reason.trim(),
    }) };
  try {
    await client.query('BEGIN');
    const started = await beginIntegrityOperation<Record<string, unknown>>(client, operation);
    if (started.replayed) {
      await client.query('COMMIT');
      return started.result;
    }
    const lot = await client.query<{
      id: string; measure: string; brand: string;
      tire_condition: 'meia_vida' | 'novo' | 'remold';
      unit_cost: string; quantity_available: number;
    }>(
      `SELECT id,measure,brand,tire_condition,unit_cost,quantity_available
         FROM commerce.matrix_partner_cargo_lots
        WHERE environment=$1 AND id=$2 AND status='open' AND quantity_available>0
        FOR UPDATE`,
      [environment, input.cargo_lot_id],
    );
    const row = lot.rows[0];
    if (!row) throw new Error('matrix_partner_cargo_not_found');
    await client.query(`SELECT set_config('app.matrix_partner_arrival','on',true)`);
    const quantity = Number(row.quantity_available);
    await applyWholesaleStockReturn(client, environment, [{
      measure: row.measure, brand: row.brand,
      tire_condition: row.tire_condition, quantity,
    }], true, row.id, 'retorno_carga_parceiro');
    await client.query(
      `UPDATE commerce.matrix_partner_cargo_lots
          SET quantity_available=0,status='returned'
        WHERE environment=$1 AND id=$2`,
      [environment, row.id],
    );
    await client.query(
      `INSERT INTO commerce.matrix_partner_cargo_events (
         environment,cargo_lot_id,event_type,quantity,actor_label,reason,idempotency_key
       ) VALUES ($1,$2,'returned',$3,$4,$5,$6)`,
      [environment, row.id, quantity, input.actor_label, input.reason.trim(), input.idempotency_key],
    );
    await postCargoReturnLedger(client, {
      environment, cargo_lot_id: row.id, quantity, unit_cost: row.unit_cost,
      actor_label: input.actor_label, reason: input.reason.trim(),
    });
    const result = { cargo_lot_id: row.id, returned_quantity: quantity,
      measure: row.measure, brand: row.brand, tire_condition: row.tire_condition };
    await recordIntegrityEvent(client, { environment, domain: 'matrix_partner_cargo',
      entityTable: 'commerce.matrix_partner_cargo_lots', entityId: row.id,
      eventType: 'returned_to_matrix', actorLabel: input.actor_label,
      idempotencyKey: input.idempotency_key, after: result });
    await completeIntegrityOperation(
      client, operation, 'commerce.matrix_partner_cargo_lots', row.id, result,
    );
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
