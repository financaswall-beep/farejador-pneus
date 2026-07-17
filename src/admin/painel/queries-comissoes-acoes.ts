import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import {
  beginIntegrityOperation,completeIntegrityOperation,integrityResult,
  operationFingerprint,recordIntegrityEvent,
} from './stage5-integrity.js';

export interface SettleCommissionInput {
  partner_id: string;
  settled_by: string;
  idempotency_key: string;
  reason: string;
  environment?: 'prod' | 'test';
}

export async function settleCommissionEntries(
  input: SettleCommissionInput,
  dbPool: Pool = defaultPool,
): Promise<{ settled_count: number; settled_total: string; replayed?: boolean }> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const operation = { environment,domain: 'commission.settle',
    idempotencyKey: input.idempotency_key,
    fingerprint: operationFingerprint({ partner_id: input.partner_id,reason: input.reason }) };
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const replay = await beginIntegrityOperation<{
      settled_count: number; settled_total: string;
    }>(client,operation);
    if (replay.replayed) {
      await client.query('COMMIT');
      return { ...replay.result,replayed: true };
    }
    const rows = await client.query<{
      id: string; partner_order_id: string; commission_amount: string;
    }>(
      `UPDATE network.commission_entries
          SET status='settled',settled_at=now(),settled_by=$3,settlement_operation_key=$4
        WHERE environment=$1 AND partner_id=$2 AND status='open'
      RETURNING id,partner_order_id,commission_amount`,
      [environment,input.partner_id,input.settled_by,input.idempotency_key],
    );
    if (rows.rowCount === 0) throw new Error('nothing_open');
    for (const row of rows.rows) {
      await client.query(
        `INSERT INTO network.commission_entry_events
          (environment,commission_entry_id,partner_order_id,event_type,previous_status,
           new_status,actor_label,reason,idempotency_key,payload)
         VALUES ($1,$2,$3,'settled','open','settled',$4,$5,$6,$7::jsonb)`,
        [environment,row.id,row.partner_order_id,input.settled_by,input.reason,
         input.idempotency_key,JSON.stringify({ commission_amount: row.commission_amount })],
      );
    }
    const total = rows.rows.reduce((sum,row) => sum+Number(row.commission_amount),0);
    const result = integrityResult({ settled_count: rows.rowCount ?? 0,
      settled_total: total.toFixed(2) });
    await recordIntegrityEvent(client,{ environment,domain: 'network',
      entityTable: 'network.partners',entityId: input.partner_id,
      eventType: 'partner_commissions_settled',actorLabel: input.settled_by,
      idempotencyKey: input.idempotency_key,before: { status: 'open' },
      after: { ...result,reason: input.reason } });
    await completeIntegrityOperation(client,operation,'network.partners',input.partner_id,result);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export interface UpdateCommercialTermsInput {
  partner_id: string;
  commercial_model: 'commission' | 'monthly' | 'hybrid';
  commission_percent: number | null;
  monthly_fee: number | null;
  actor_label: string;
  idempotency_key: string;
  environment?: 'prod' | 'test';
}

export async function updatePartnerCommercialTerms(
  input: UpdateCommercialTermsInput,
  dbPool: Pool = defaultPool,
): Promise<{ updated: true; replayed?: boolean }> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  if (input.commission_percent !== null
    && (input.commission_percent<0 || input.commission_percent>100)) throw new Error('invalid_percent');
  if (input.monthly_fee !== null && input.monthly_fee<0) throw new Error('invalid_fee');
  const operation = { environment,domain: 'partner.terms.update',
    idempotencyKey: input.idempotency_key,
    fingerprint: operationFingerprint({ partner_id: input.partner_id,
      commercial_model: input.commercial_model,commission_percent: input.commission_percent,
      monthly_fee: input.monthly_fee }) };
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const replay = await beginIntegrityOperation<{ updated: true }>(client,operation);
    if (replay.replayed) {
      await client.query('COMMIT');
      return { ...replay.result,replayed: true };
    }
    const before = await client.query(
      `SELECT commercial_model,commission_percent,monthly_fee FROM network.partners
        WHERE id=$1 AND environment=$2 AND deleted_at IS NULL FOR UPDATE`,
      [input.partner_id,environment]);
    if (!before.rows[0]) throw new Error('partner_not_found');
    await client.query(
      `UPDATE network.partners SET commercial_model=$3,commission_percent=$4,
          monthly_fee=$5,updated_at=now() WHERE id=$1 AND environment=$2 AND deleted_at IS NULL`,
      [input.partner_id,environment,input.commercial_model,input.commission_percent,input.monthly_fee]);
    const result = integrityResult({ updated: true as const });
    await recordIntegrityEvent(client,{ environment,domain: 'network',
      entityTable: 'network.partners',entityId: input.partner_id,
      eventType: 'partner_terms_updated',actorLabel: input.actor_label,
      idempotencyKey: input.idempotency_key,before: before.rows[0],
      after: { commercial_model: input.commercial_model,
        commission_percent: input.commission_percent,monthly_fee: input.monthly_fee } });
    await completeIntegrityOperation(client,operation,'network.partners',input.partner_id,result);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
