import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { buildPortabilityPackage, type PortabilityPackage } from './customer-portability.js';
import { inventoryCustomerPrivacy, type PrivacyInventoryItem } from './customer-privacy-inventory.js';

export interface PrivacyRequestRow {
  id: string; environment: 'prod' | 'test'; identity_id: string;
  request_type: 'portability' | 'anonymization';
  status: 'requested' | 'identity_verified' | 'scope_ready' | 'approved' | 'executing'
    | 'completed' | 'partially_completed' | 'rejected';
  verification_method: string | null; verification_result: 'passed' | 'failed' | null;
  verification_operator: string | null; approved_by: string | null; approval_reason: string | null;
  legal_hold: boolean; pending_scopes: string[]; result_summary: Record<string,unknown>;
  created_by: string; created_at: string; updated_at: string; completed_at: string | null;
}

async function event(
  client: PoolClient, request: PrivacyRequestRow, type: string, actor: string,
  before: string | null, after: string | null, details: Record<string,unknown> = {},
): Promise<void> {
  await client.query(
    `INSERT INTO ops.privacy_request_events(environment,privacy_request_id,event_type,actor_label,
       status_before,status_after,details) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,
    [request.environment,request.id,type,actor,before,after,JSON.stringify(details)]);
}

function fingerprint(identityId: string, requestType: string): string {
  return createHash('sha256').update(`${identityId}:${requestType}`).digest('hex');
}

export async function createPrivacyRequest(
  input: { environment: 'prod' | 'test'; identityId: string; requestType: 'portability' | 'anonymization';
    idempotencyKey: string; actor: string }, dbPool: Pool = defaultPool,
): Promise<PrivacyRequestRow> {
  if (input.idempotencyKey.trim().length < 8) throw new Error('idempotency_key_required');
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const expected = fingerprint(input.identityId,input.requestType);
    const identity = await client.query(
      `SELECT 1 FROM commerce.customer_identities WHERE environment=$1 AND id=$2 AND status='active'`,
      [input.environment,input.identityId]);
    if (!identity.rows[0]) throw new Error('identity_not_found');
    const inserted = await client.query<PrivacyRequestRow>(
      `INSERT INTO ops.privacy_requests(environment,identity_id,request_type,idempotency_key,
         request_fingerprint,created_by) VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT(environment,idempotency_key) DO NOTHING RETURNING *`,
      [input.environment,input.identityId,input.requestType,input.idempotencyKey.trim(),expected,input.actor]);
    let request = inserted.rows[0];
    if (!request) {
      const existing = await client.query<PrivacyRequestRow & { request_fingerprint: string }>(
        `SELECT * FROM ops.privacy_requests WHERE environment=$1 AND idempotency_key=$2 FOR UPDATE`,
        [input.environment,input.idempotencyKey.trim()]);
      request = existing.rows[0];
      if (!request) throw new Error('privacy_request_insert_failed');
      if (existing.rows[0]?.request_fingerprint !== expected) throw new Error('idempotency_conflict');
    } else {
      await event(client,request,'privacy_request_created',input.actor,null,'requested',
        { request_type:input.requestType });
    }
    await client.query('COMMIT'); return request;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export async function getPrivacyRequest(
  environment: 'prod' | 'test', requestId: string, dbPool: Pool = defaultPool,
): Promise<PrivacyRequestRow | null> {
  const result = await dbPool.query<PrivacyRequestRow>(
    `SELECT id,environment,identity_id,request_type,status,verification_method,verification_result,
       verification_operator,approved_by,approval_reason,legal_hold,pending_scopes,result_summary,
       created_by,created_at::text,updated_at::text,completed_at::text
       FROM ops.privacy_requests WHERE environment=$1 AND id=$2`,[environment,requestId]);
  return result.rows[0] ?? null;
}

export async function verifyPrivacyRequest(
  input: { environment: 'prod' | 'test'; requestId: string; actor: string;
    registeredChannelConfirmed: boolean; transactionEvidenceConfirmed: boolean },
  dbPool: Pool = defaultPool,
): Promise<PrivacyRequestRow> {
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`privacy:${input.requestId}`]);
    const found = await client.query<PrivacyRequestRow>(
      `SELECT * FROM ops.privacy_requests WHERE environment=$1 AND id=$2 FOR UPDATE`,[input.environment,input.requestId]);
    const request = found.rows[0];
    if (!request) throw new Error('privacy_request_not_found');
    if (request.status !== 'requested') {
      if (request.verification_result) { await client.query('COMMIT'); return request; }
      throw new Error('privacy_request_invalid_state');
    }
    const passed = input.registeredChannelConfirmed && input.transactionEvidenceConfirmed;
    const status = passed ? 'identity_verified' : 'rejected';
    const updated = await client.query<PrivacyRequestRow>(
      `UPDATE ops.privacy_requests SET status=$1,verification_method='registered_channel_plus_transaction',
         verification_result=$2,verification_operator=$3,verified_at=now()
       WHERE id=$4 RETURNING *`,[status,passed?'passed':'failed',input.actor,request.id]);
    await event(client,request,'privacy_identity_verification',input.actor,'requested',status,
      { method:'registered_channel_plus_transaction',result:passed?'passed':'failed' });
    await client.query('COMMIT'); return updated.rows[0] ?? request;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export async function previewPrivacyRequest(
  environment: 'prod' | 'test', requestId: string, actor: string, dbPool: Pool = defaultPool,
): Promise<{ request: PrivacyRequestRow; inventory: PrivacyInventoryItem[]; has_pending: boolean }> {
  const current = await getPrivacyRequest(environment,requestId,dbPool);
  if (!current) throw new Error('privacy_request_not_found');
  if (!['identity_verified','scope_ready','approved'].includes(current.status)) throw new Error('privacy_request_invalid_state');
  const inventory = await inventoryCustomerPrivacy(environment,current.identity_id,current.request_type,dbPool);
  const pending = inventory.items.filter((entry) => entry.count>0 && entry.disposition==='pending').map((entry) => entry.surface);
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const updated = await client.query<PrivacyRequestRow>(
      `UPDATE ops.privacy_requests SET status=CASE WHEN status='identity_verified' THEN 'scope_ready' ELSE status END,
         pending_scopes=$1,result_summary=$2::jsonb WHERE id=$3 AND environment=$4 RETURNING *`,
      [pending,JSON.stringify({ mode:'dry_run',surfaces:inventory.items.map((entry) => ({
        surface:entry.surface,count:entry.count,disposition:entry.disposition })) }),requestId,environment]);
    const request = updated.rows[0] ?? current;
    await event(client,request,'privacy_scope_previewed',actor,current.status,request.status,
      { mode:'dry_run',surface_count:inventory.items.length,pending_count:pending.length });
    await client.query('COMMIT');
    return { request,inventory:inventory.items,has_pending:inventory.has_pending };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export async function approvePrivacyRequest(
  environment: 'prod' | 'test', requestId: string, actor: string, reason: string, dbPool: Pool = defaultPool,
): Promise<PrivacyRequestRow> {
  if (reason.trim().length < 5) throw new Error('reason_required');
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query<PrivacyRequestRow>(
      `SELECT * FROM ops.privacy_requests WHERE environment=$1 AND id=$2 FOR UPDATE`,[environment,requestId]);
    const request = found.rows[0];
    if (!request) throw new Error('privacy_request_not_found');
    if (request.status === 'approved') { await client.query('COMMIT'); return request; }
    if (request.status !== 'scope_ready' || request.verification_result !== 'passed') throw new Error('privacy_request_invalid_state');
    const updated = await client.query<PrivacyRequestRow>(
      `UPDATE ops.privacy_requests SET status='approved',approved_by=$1,approval_reason=$2,approved_at=now()
        WHERE id=$3 RETURNING *`,[actor,reason.trim(),request.id]);
    await event(client,request,'privacy_request_approved',actor,'scope_ready','approved',{ reason_recorded:true });
    await client.query('COMMIT'); return updated.rows[0] ?? request;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export async function executePrivacyRequest(
  environment: 'prod' | 'test', requestId: string, actor: string, confirmation: string,
  dbPool: Pool = defaultPool,
): Promise<{ request: PrivacyRequestRow; portability_package: PortabilityPackage }> {
  const startClient = await dbPool.connect();
  let current: PrivacyRequestRow;
  let terminal = false;
  try {
    await startClient.query('BEGIN');
    await startClient.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`privacy-execute:${requestId}`]);
    const found = await startClient.query<PrivacyRequestRow>(
      `SELECT * FROM ops.privacy_requests WHERE environment=$1 AND id=$2 FOR UPDATE`,[environment,requestId]);
    const locked = found.rows[0];
    if (!locked) throw new Error('privacy_request_not_found');
    if (locked.request_type === 'anonymization') throw new Error('anonymization_execution_disabled');
    if (confirmation !== 'EXECUTAR PORTABILIDADE') throw new Error('explicit_confirmation_required');
    if (!['approved','executing','completed','partially_completed'].includes(locked.status)) {
      throw new Error('privacy_request_invalid_state');
    }
    terminal = ['completed','partially_completed'].includes(locked.status);
    if (locked.status === 'executing' && Date.now()-new Date(locked.updated_at).getTime()<60_000) {
      throw new Error('privacy_request_processing');
    }
    if (!terminal) {
      const updated = await startClient.query<PrivacyRequestRow>(
        `UPDATE ops.privacy_requests SET status='executing' WHERE id=$1 RETURNING *`,[requestId]);
      current = updated.rows[0] ?? locked;
      await event(startClient,current,locked.status==='approved'?'privacy_execution_started':'privacy_execution_retried',
        actor,locked.status,'executing',{ operation:'portability' });
    } else current = locked;
    await startClient.query('COMMIT');
  } catch (error) { await startClient.query('ROLLBACK'); throw error; }
  finally { startClient.release(); }
  const portabilityPackage = await buildPortabilityPackage(environment,current.identity_id,dbPool);
  if (terminal) return { request:current,portability_package:portabilityPackage };
  const inventory = await inventoryCustomerPrivacy(environment,current.identity_id,'portability',dbPool);
  const pending = inventory.items.filter((entry) => entry.count>0 && entry.disposition==='pending').map((entry) => entry.surface);
  const finalStatus = pending.length ? 'partially_completed' : 'completed';
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const updated = await client.query<PrivacyRequestRow>(
      `UPDATE ops.privacy_requests SET status=$1,pending_scopes=$2,completed_at=now(),
         result_summary=$3::jsonb WHERE id=$4 AND environment=$5 AND status='executing' RETURNING *`,
      [finalStatus,pending,JSON.stringify({ package_generated:true,pending_count:pending.length }),requestId,environment]);
    const request = updated.rows[0];
    if (!request) throw new Error('privacy_request_invalid_state');
    await event(client,request,'privacy_portability_generated',actor,'executing',finalStatus,
      { package_generated:true,pending_count:pending.length });
    await client.query('COMMIT'); return { request,portability_package:portabilityPackage };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
