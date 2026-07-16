import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';

export type MatrizEnvironment = 'prod' | 'test';

type JsonObject = Record<string, unknown>;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const source = value as JsonObject;
    const out: JsonObject = {};
    for (const key of Object.keys(source).sort()) {
      if (source[key] !== undefined) out[key] = canonicalize(source[key]);
    }
    return out;
  }
  if (typeof value === 'number' && Object.is(value, -0)) return 0;
  return value;
}

export function operationFingerprint(payload: unknown): string {
  const canonical = JSON.stringify(canonicalize(payload));
  return createHash('sha256').update(canonical).digest('hex');
}

export function moneyCents(value: number): number {
  return Math.round((value + Number.EPSILON) * 100);
}

/** O primeiro retorno e o replay persistido precisam ter o mesmo formato.
 * Datas do driver viram ISO como aconteceria ao atravessar JSON na API. */
export function integrityResult<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export interface IntegrityOperation {
  environment: MatrizEnvironment;
  domain: string;
  idempotencyKey: string;
  fingerprint: string;
}

function integrityOperationKey(operation: Pick<IntegrityOperation, 'idempotencyKey'>): string {
  const key = operation.idempotencyKey.trim();
  if (key.length < 8 || key.length > 200) throw new Error('idempotency_key_required');
  return key;
}

async function lockIntegrityOperation(
  client: PoolClient,
  operation: Pick<IntegrityOperation, 'environment' | 'domain' | 'idempotencyKey'>,
): Promise<string> {
  const key = integrityOperationKey(operation);
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
    [`stage5:${operation.environment}:${operation.domain}:${key}`],
  );
  return key;
}

export async function beginIntegrityOperation<T>(
  client: PoolClient,
  operation: IntegrityOperation,
): Promise<{ replayed: false } | { replayed: true; result: T }> {
  const key = await lockIntegrityOperation(client, operation);
  const existing = await client.query<{
    request_fingerprint: string;
    result: T | null;
    completed_at: string | null;
  }>(
    `SELECT request_fingerprint, result, completed_at
       FROM audit.operation_idempotency
      WHERE environment=$1 AND domain=$2 AND idempotency_key=$3`,
    [operation.environment, operation.domain, key],
  );
  if (existing.rows[0]) {
    if (existing.rows[0].request_fingerprint !== operation.fingerprint) {
      throw new Error('idempotency_conflict');
    }
    if (!existing.rows[0].completed_at || existing.rows[0].result === null) {
      throw new Error('idempotency_incomplete');
    }
    return { replayed: true, result: existing.rows[0].result };
  }

  await client.query(
    `INSERT INTO audit.operation_idempotency
       (environment, domain, idempotency_key, request_fingerprint)
     VALUES ($1,$2,$3,$4)`,
    [operation.environment, operation.domain, key, operation.fingerprint],
  );
  return { replayed: false };
}

export type IntegrityOperationResolution<T = unknown> =
  | { status: 'missing' }
  | { status: 'incomplete' }
  | {
      status: 'completed';
      entity_table: string | null;
      entity_id: string | null;
      result: T;
      completed_at: string;
    };

/** Consulta segura usada pelo navegador depois de um reload ou resposta perdida.
 * O mesmo advisory lock faz a leitura esperar uma operacao ainda em voo terminar. */
export async function resolveIntegrityOperation<T>(
  client: PoolClient,
  operation: Pick<IntegrityOperation, 'environment' | 'domain' | 'idempotencyKey'>,
): Promise<IntegrityOperationResolution<T>> {
  const key = await lockIntegrityOperation(client, operation);
  const existing = await client.query<{
    entity_table: string | null;
    entity_id: string | null;
    result: T | null;
    completed_at: string | null;
  }>(
    `SELECT entity_table,entity_id,result,completed_at
       FROM audit.operation_idempotency
      WHERE environment=$1 AND domain=$2 AND idempotency_key=$3`,
    [operation.environment, operation.domain, key],
  );
  const row = existing.rows[0];
  if (!row) return { status: 'missing' };
  if (!row.completed_at || row.result === null) return { status: 'incomplete' };
  return {
    status: 'completed', entity_table: row.entity_table, entity_id: row.entity_id,
    result: row.result, completed_at: row.completed_at,
  };
}

export async function completeIntegrityOperation(
  client: PoolClient,
  operation: IntegrityOperation,
  entityTable: string,
  entityId: string,
  result: unknown,
): Promise<void> {
  const completed = await client.query(
    `UPDATE audit.operation_idempotency
        SET entity_table=$5, entity_id=$6, result=$7::jsonb, completed_at=now()
      WHERE environment=$1 AND domain=$2 AND idempotency_key=$3
        AND request_fingerprint=$4 AND completed_at IS NULL
      RETURNING idempotency_key`,
    [operation.environment, operation.domain, operation.idempotencyKey.trim(),
     operation.fingerprint, entityTable, entityId, JSON.stringify(result)],
  );
  if (!completed.rows[0]) throw new Error('idempotency_complete_failed');
}

export interface IntegrityAuditEvent {
  environment: MatrizEnvironment;
  domain: string;
  entityTable: string;
  entityId: string;
  eventType: string;
  actorLabel?: string | null;
  idempotencyKey: string;
  before?: unknown;
  after?: unknown;
}

export async function recordIntegrityEvent(
  client: PoolClient,
  event: IntegrityAuditEvent,
): Promise<void> {
  await client.query(
    `INSERT INTO audit.events
       (environment,domain,entity_table,entity_id,event_type,actor_label,
        idempotency_key,payload_before,payload_after)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)`,
    [event.environment, event.domain, event.entityTable, event.entityId, event.eventType,
     event.actorLabel ?? null, event.idempotencyKey.trim(),
     event.before === undefined ? null : JSON.stringify(event.before),
     event.after === undefined ? null : JSON.stringify(event.after)],
  );
}
