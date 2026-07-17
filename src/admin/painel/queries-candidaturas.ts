import type { Pool } from 'pg';
import { randomBytes } from 'node:crypto';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import {
  beginIntegrityOperation, completeIntegrityOperation, integrityResult,
  operationFingerprint, recordIntegrityEvent,
} from './stage5-integrity.js';
import { createPartnerUnitWithClient, type CreatePartnerResult } from './queries-parceiros.js';

export interface PartnerApplicationInput {
  environment?: 'prod' | 'test';
  trade_name: string;
  responsible_name?: string | null;
  whatsapp_phone?: string | null;
  email?: string | null;
  address?: string | null;
  municipios?: string | null;
  message?: string | null;
}

export async function createPartnerApplication(
  input: PartnerApplicationInput,
  dbPool: Pool = defaultPool,
): Promise<{ id: string }> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const r = await dbPool.query<{ id: string }>(
    `INSERT INTO network.partner_applications
       (environment,trade_name,responsible_name,whatsapp_phone,email,address,municipios,message)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [environment, input.trade_name.trim(), input.responsible_name?.trim() || null,
     input.whatsapp_phone?.trim() || null, input.email?.trim() || null,
     input.address?.trim() || null, input.municipios?.trim() || null,
     input.message?.trim() || null],
  );
  return { id: r.rows[0]!.id };
}

export async function listPartnerApplications(
  status: 'pending' | 'approved' | 'rejected' | 'all' = 'pending',
  dbPool: Pool = defaultPool,
): Promise<unknown[]> {
  const r = await dbPool.query(
    `SELECT id,trade_name,responsible_name,whatsapp_phone,email,address,municipios,message,
            status,created_at,reviewed_by,reviewed_at,review_notes,created_partner_unit_id
       FROM network.partner_applications
      WHERE environment=$1 AND ($2='all' OR status=$2)
      ORDER BY created_at DESC LIMIT 100`,
    [env.FAREJADOR_ENV, status],
  );
  return r.rows;
}

export interface ApproveApplicationInput {
  application_id: string;
  actor_label: string;
  idempotency_key: string;
  municipios: string[];
  commission_percent?: number | null;
  monthly_fee?: number | null;
  commercial_model?: string | null;
  slug?: string | null;
}

interface ApplicationRow {
  environment: 'prod' | 'test'; trade_name: string; responsible_name: string | null;
  whatsapp_phone: string | null; email: string | null; address: string | null;
  status: string; created_partner_unit_id: string | null;
}

type StableApproval = CreatePartnerResult & {
  application_id: string; replayed?: boolean; credential_reissue_required?: boolean;
};

export async function approvePartnerApplication(
  input: ApproveApplicationInput,
  dbPool: Pool = defaultPool,
): Promise<StableApproval> {
  const client = await dbPool.connect();
  const environment = env.FAREJADOR_ENV;
  const operation = {
    environment,
    domain: 'partner_application.approve',
    idempotencyKey: input.idempotency_key,
    fingerprint: operationFingerprint({ application_id: input.application_id,
      municipios: input.municipios, commission_percent: input.commission_percent ?? null,
      monthly_fee: input.monthly_fee ?? null, commercial_model: input.commercial_model ?? null,
      slug: input.slug ?? null }),
  };
  try {
    await client.query('BEGIN');
    const appRes = await client.query<ApplicationRow>(
      `SELECT environment,trade_name,responsible_name,whatsapp_phone,email,address,
              status,created_partner_unit_id
         FROM network.partner_applications
        WHERE id=$1 AND environment=$2 FOR UPDATE`,
      [input.application_id, environment],
    );
    const app = appRes.rows[0];
    if (!app) throw new Error('application_not_found');

    const replay = await beginIntegrityOperation<StableApproval>(client, operation);
    if (replay.replayed) {
      await client.query('COMMIT');
      return { ...replay.result, replayed: true, credential_reissue_required: true };
    }

    if (app.status === 'approved' && app.created_partner_unit_id) {
      const linked = await client.query<{
        partner_unit_id: string; unit_id: string; partner_id: string; slug: string;
      }>(
        `SELECT pu.id AS partner_unit_id,pu.unit_id,pu.partner_id,pu.slug
           FROM network.partner_units pu
          WHERE pu.environment=$1 AND pu.id=$2`,
        [environment, app.created_partner_unit_id],
      );
      if (!linked.rows[0]) throw new Error('approved_application_unit_missing');
      const stable = integrityResult({ already_exists: false, ...linked.rows[0],
        application_id: input.application_id, replayed: true,
        credential_reissue_required: true });
      await completeIntegrityOperation(client, operation, 'network.partner_applications',
        input.application_id, stable);
      await client.query('COMMIT');
      return stable;
    }
    if (app.status !== 'pending') throw new Error('application_not_pending');

    const created = await createPartnerUnitWithClient({
      environment: app.environment, trade_name: app.trade_name,
      responsible_name: app.responsible_name, whatsapp_phone: app.whatsapp_phone,
      email: app.email, address: app.address,
      commission_percent: input.commission_percent ?? null,
      monthly_fee: input.monthly_fee ?? null,
      commercial_model: input.commercial_model ?? null,
      municipios: input.municipios, slug: input.slug ?? null,
      actor_label: input.actor_label,
    }, client, { sourceApplicationId: input.application_id });
    if (created.already_exists || !created.partner_unit_id || !created.partner_id || !created.unit_id) {
      throw new Error('slug_already_exists');
    }

    const updated = await client.query(
      `UPDATE network.partner_applications
          SET status='approved',reviewed_by=$1,reviewed_at=now(),created_partner_unit_id=$2
        WHERE id=$3 AND environment=$4 AND status='pending'`,
      [input.actor_label, created.partner_unit_id, input.application_id, environment],
    );
    if (updated.rowCount !== 1) throw new Error('application_transition_conflict');

    const stable = integrityResult({ already_exists: false, partner_id: created.partner_id,
      unit_id: created.unit_id, partner_unit_id: created.partner_unit_id,
      slug: created.slug, application_id: input.application_id });
    await recordIntegrityEvent(client, { environment, domain: 'network',
      entityTable: 'network.partner_applications', entityId: input.application_id,
      eventType: 'partner_application_approved', actorLabel: input.actor_label,
      idempotencyKey: input.idempotency_key, before: { status: 'pending' },
      after: { status: 'approved', partner_id: created.partner_id,
        partner_unit_id: created.partner_unit_id, unit_id: created.unit_id } });
    await completeIntegrityOperation(client, operation, 'network.partner_applications',
      input.application_id, stable);
    await client.query('COMMIT');
    return { ...stable, token: created.token };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function rejectPartnerApplication(
  applicationId: string,
  actorLabel: string,
  notes: string | null,
  dbPool: Pool = defaultPool,
): Promise<{ rejected: boolean }> {
  const client = await dbPool.connect();
  const environment = env.FAREJADOR_ENV;
  try {
    await client.query('BEGIN');
    const app = await client.query<{ status: string }>(
      `SELECT status FROM network.partner_applications
        WHERE id=$1 AND environment=$2 FOR UPDATE`, [applicationId, environment]);
    if (!app.rows[0] || app.rows[0].status !== 'pending') {
      await client.query('COMMIT');
      return { rejected: false };
    }
    await client.query(
      `UPDATE network.partner_applications
          SET status='rejected',reviewed_by=$1,reviewed_at=now(),review_notes=$2
        WHERE id=$3 AND environment=$4 AND status='pending'`,
      [actorLabel, notes, applicationId, environment]);
    await recordIntegrityEvent(client, { environment, domain: 'network',
      entityTable: 'network.partner_applications', entityId: applicationId,
      eventType: 'partner_application_rejected', actorLabel,
      idempotencyKey: `reject-${applicationId}`, before: { status: 'pending' },
      after: { status: 'rejected', notes } });
    await client.query('COMMIT');
    return { rejected: true };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function reissuePartnerCredential(
  input: { partner_unit_id: string; actor_label: string; reason: string;
    idempotency_key: string; environment?: 'prod' | 'test' },
  dbPool: Pool = defaultPool,
): Promise<{ partner_unit_id: string; token_id: string; slug: string; token?: string;
  replayed?: boolean; credential_reissue_required?: boolean }> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const operation = { environment,domain: 'partner.credential.reissue',
    idempotencyKey: input.idempotency_key,
    fingerprint: operationFingerprint({ partner_unit_id: input.partner_unit_id,
      reason: input.reason }) };
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const replay = await beginIntegrityOperation<{
      partner_unit_id: string; token_id: string; slug: string;
    }>(client,operation);
    if (replay.replayed) {
      await client.query('COMMIT');
      return { ...replay.result,replayed: true,credential_reissue_required: true };
    }
    const unit = await client.query<{ id: string; slug: string }>(
      `SELECT id,slug FROM network.partner_units
        WHERE environment=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE`,
      [environment,input.partner_unit_id]);
    if (!unit.rows[0]) throw new Error('partner_unit_not_found');
    const revoked = await client.query(
      `UPDATE network.partner_access_tokens SET revoked_at=now()
        WHERE environment=$1 AND partner_unit_id=$2 AND revoked_at IS NULL
          AND last_used_at IS NULL`, [environment,input.partner_unit_id]);
    const token = randomBytes(32).toString('hex');
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO network.partner_access_tokens
        (environment,partner_unit_id,token_hash,label,created_by,role)
       VALUES ($1,$2,network.hash_partner_token($3),$4,$5,'owner') RETURNING id`,
      [environment,input.partner_unit_id,token,
       `reissue_${new Date().toISOString().slice(0,10)}`,input.actor_label]);
    const result = integrityResult({ partner_unit_id: input.partner_unit_id,
      token_id: inserted.rows[0]!.id,slug: unit.rows[0].slug });
    await recordIntegrityEvent(client,{ environment,domain: 'network',
      entityTable: 'network.partner_units',entityId: input.partner_unit_id,
      eventType: 'partner_credential_reissued',actorLabel: input.actor_label,
      idempotencyKey: input.idempotency_key,before: { unused_tokens_revoked: revoked.rowCount ?? 0 },
      after: { ...result,reason: input.reason } });
    await completeIntegrityOperation(client,operation,'network.partner_units',
      input.partner_unit_id,result);
    await client.query('COMMIT');
    return { ...result,token };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
