import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { env } from '../../shared/config/env.js';
import { operationFingerprint } from '../painel/stage5-integrity.js';
import { lockGrant, transact } from './installment-reviews.js';
import type { DotIdentity } from './token-store.js';
import { operationAllowed, operationReviewMode, type OperationDomain, type OperationPermission } from './operation-policy.js';

export function reviewDetails(data: Record<string, unknown>) {
  const { idempotency_key, arquivo, imagem_base64, ...fields } = data;
  if (arquivo) {
    const { file_id, file_name } = arquivo as { file_id: string; file_name?: string };
    return { ...fields, arquivo: { file_id, file_name } };
  }
  return imagem_base64 ? { ...fields, imagem_base64: 'Foto anexada na conversa' } : fields;
}
export function reviewFingerprint(data: Record<string, unknown>) {
  return operationFingerprint({ ...reviewDetails(data),
    ...(data.imagem_base64 ? { imagem_sha256: createHash('sha256').update(String(data.imagem_base64)).digest('hex') } : {}) });
}

/** Executado sob a trava da conexão, na mesma transação da operação. */
export async function requireOperationReview(db: PoolClient, identity: DotIdentity, name: string, key: string,
  data: Record<string, unknown>, permission?: OperationPermission, domain: OperationDomain = 'finance') {
  const grant = permission ?? await lockGrant(db, identity.person_id, identity.grant_id);
  if (!operationAllowed(grant, domain)) throw Error('dot_operation_disabled');
  const mode = operationReviewMode(grant, domain);
  if (!mode) return null;
  const scope = [env.FAREJADOR_ENV, identity.grant_id, name, key];
  const completed = await db.query(`SELECT 1 FROM audit.operation_idempotency
    WHERE environment=$1 AND domain=$2 AND idempotency_key=$3 AND completed_at IS NOT NULL`,
  [env.FAREJADOR_ENV, 'dot.' + name, key]);
  // O validador de idempotência ainda compara conexão e dados antes de retornar o resultado.
  if (completed.rowCount) return null;
  const fingerprint = reviewFingerprint(data);
  let row = (await db.query(`SELECT id,fingerprint,decision,decision_channel,expires_at,
    expires_at<=clock_timestamp() AS expired FROM network.dot_operation_reviews
    WHERE environment=$1 AND grant_id=$2 AND tool_name=$3 AND operation_key=$4 FOR UPDATE`, scope)).rows[0];
  if (row && row.fingerprint !== fingerprint) throw Error('dados_da_proposta_mudaram_use_nova_chave');
  // Não recriar uma proposta recusada ou expirada ao repetir o mesmo comando.
  if (row?.decision === 'recusada') return { status: 'recusada', executada: false, proposta: row.id };
  if (row?.expired) return { status: 'expirada', executada: false, proposta: row.id };
  if (row?.decision === 'autorizada' && (row.decision_channel ?? 'painel') === mode) return null;
  if (row?.decision === 'autorizada') throw Error('modo_de_confirmacao_mudou_prepare_nova_proposta');
  if (!row) row = (await db.query(`INSERT INTO network.dot_operation_reviews
    (environment,grant_id,tool_name,operation_key,fingerprint,details,permission_domain)
    VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id,expires_at`,
  [...scope, fingerprint, reviewDetails(data), domain])).rows[0];
  return { status: 'aguardando_autorizacao', executada: false, proposta: row.id, fingerprint,
    operacao: name, dados: reviewDetails(data), expires_at: row.expires_at, confirmacao: mode,
    ...(mode === 'conversa' ? { ferramenta_confirmacao: 'confirmar_operacao_milly' }
      : { confirm_url: env.DOT_MCP_PUBLIC_ORIGIN + '/admin/dot/connections?operacao=' + row.id }) };
}

export async function markOperationExecuted(db: PoolClient, identity: DotIdentity, name: string, key: string) {
  await db.query(`UPDATE network.dot_operation_reviews SET executed_at=now()
    WHERE environment=$1 AND grant_id=$2 AND tool_name=$3 AND operation_key=$4 AND decision='autorizada'`,
  [env.FAREJADOR_ENV, identity.grant_id, name, key]);
}

export async function ownerReview(person: string, id: string, decision?: 'autorizada' | 'recusada',
  conversation?: { grantId: string; fingerprint?: string }) {
  return transact(async db => {
    const scope = [env.FAREJADOR_ENV, id];
    const grantId = conversation?.grantId ?? (await db.query(`SELECT grant_id FROM network.dot_operation_reviews
      WHERE environment=$1 AND id=$2`, scope)).rows[0]?.grant_id;
    if (!grantId) throw Error('dot_review_missing');
    const permission = await lockGrant(db, person, grantId);
    const row = (await db.query(`SELECT r.tool_name,r.operation_key,r.details,r.decision,r.decision_channel,
      r.fingerprint,r.permission_domain,r.executed_at,r.expires_at,
      r.expires_at<=clock_timestamp() AS expired,g.collaborator_id FROM network.dot_operation_reviews r
      JOIN network.dot_oauth_grants g ON g.environment=r.environment AND g.id=r.grant_id
      WHERE r.environment=$1 AND r.id=$2 AND r.grant_id=$3 FOR UPDATE OF r`, [...scope, grantId])).rows[0];
    if (!row) throw Error('dot_review_missing');
    if (!operationAllowed(permission, row.permission_domain)) throw Error('dot_operation_disabled');
    const mode = operationReviewMode(permission, row.permission_domain);
    if (decision && (conversation ? mode !== 'conversa' : mode !== 'painel')) throw Error('dot_confirmation_channel_disabled');
    if (conversation?.fingerprint && conversation.fingerprint !== row.fingerprint) throw Error('dot_review_changed');
    if (decision && row.decision && row.decision !== decision) throw Error('dot_review_decided');
    if (decision && row.expired && !row.executed_at) throw Error('dot_review_expired');
    const channel = conversation ? 'conversa' : 'painel';
    if (decision && !row.decision) await db.query(`UPDATE network.dot_operation_reviews
      SET decision=$3,decision_channel=$4,decided_at=clock_timestamp() WHERE environment=$1 AND id=$2`, [...scope, decision, channel]);
    return { operacao: row.tool_name as string, dados: row.details as Record<string, unknown>,
      proposta: id, fingerprint: row.fingerprint as string, expires_at: row.expires_at, confirmacao: mode,
      status: (row.executed_at ? 'executada' : row.decision === 'recusada' ? 'recusada'
        : row.expired ? 'expirada' : row.decision ?? decision ?? 'pendente') as string,
      key: row.operation_key as string,
      identity: { person_id: person, collaborator_id: row.collaborator_id, grant_id: grantId } as DotIdentity };
  });
}
