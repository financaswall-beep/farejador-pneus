import type { PoolClient } from 'pg';
import { env } from '../../shared/config/env.js';
import { operationFingerprint } from '../painel/stage5-integrity.js';
import { lockGrant, transact } from './installment-reviews.js';
import type { DotIdentity } from './token-store.js';

// Assinaturas de download e bytes do comprovante não são persistidos na proposta.
function reviewDetails(data:Record<string,unknown>) {
  const {idempotency_key,arquivo,imagem_base64,...fields}=data;
  if(arquivo) {
    const {file_id,file_name}=arquivo as {file_id:string;file_name?:string};
    return {...fields,arquivo:{file_id,file_name}};
  }
  return imagem_base64?{...fields,imagem_base64:'Foto anexada na conversa'}:fields;
}

/** Chamado sob a trava do grant, antes de reservar a chave financeira. */
export async function requireOperationReview(db:PoolClient,identity:DotIdentity,name:string,key:string,data:Record<string,unknown>) {
  const scope=[env.FAREJADOR_ENV,identity.grant_id,name,key];
  // Replays da operação já concluída passam pelo validador original de chave e fingerprint.
  const completed=await db.query(`SELECT 1 FROM audit.operation_idempotency
    WHERE environment=$1 AND domain=$2 AND idempotency_key=$3 AND completed_at IS NOT NULL`,
  [env.FAREJADOR_ENV,'dot.'+name,key]);
  if(completed.rowCount) return null;
  await db.query(`DELETE FROM network.dot_operation_reviews WHERE environment=$1 AND grant_id=$2 AND expires_at<=clock_timestamp()`,scope.slice(0,2));
  const fingerprint=operationFingerprint(data);
  let row=(await db.query(`SELECT id,fingerprint,decision,expires_at FROM network.dot_operation_reviews
    WHERE environment=$1 AND grant_id=$2 AND tool_name=$3 AND operation_key=$4`,scope)).rows[0];
  if(row && row.fingerprint!==fingerprint) throw Error('dados_da_proposta_mudaram_use_nova_chave');
  if(row?.decision==='autorizada') return null;
  if(row?.decision==='recusada') return {status:'recusada',executada:false};
  if(!row) row=(await db.query(`INSERT INTO network.dot_operation_reviews
    (environment,grant_id,tool_name,operation_key,fingerprint,details) VALUES ($1,$2,$3,$4,$5,$6)
    RETURNING id,expires_at`,[...scope,fingerprint,reviewDetails(data)])).rows[0];
  return {status:'aguardando_autorizacao',executada:false,expires_at:row.expires_at,
    confirm_url:env.DOT_MCP_PUBLIC_ORIGIN+'/admin/dot/connections?operacao='+row.id};
}

export async function ownerReview(person:string,id:string,decision?:'autorizada'|'recusada') {
  return transact(async db=>{
    const scope=[env.FAREJADOR_ENV,id];
    const grant=(await db.query(`SELECT grant_id FROM network.dot_operation_reviews WHERE environment=$1 AND id=$2`,scope)).rows[0];
    if(!grant) throw Error('dot_review_missing');
    const permission=await lockGrant(db,person,grant.grant_id);
    if(!permission.finance_operations_enabled || !permission.monitor_owner_approval) throw Error('dot_grant_unavailable');
    const row=(await db.query(`SELECT r.tool_name,r.operation_key,r.details,r.decision,r.executed_at,
      r.expires_at<=clock_timestamp() AS expired,g.collaborator_id FROM network.dot_operation_reviews r
      JOIN network.dot_oauth_grants g ON g.environment=r.environment AND g.id=r.grant_id
      WHERE r.environment=$1 AND r.id=$2 AND r.grant_id=$3 FOR UPDATE OF r`,[...scope,grant.grant_id])).rows[0];
    if(!row || row.expired) throw Error('dot_review_expired');
    if(decision && row.decision && row.decision!==decision) throw Error('dot_review_decided');
    if(decision && !row.decision) {
      await db.query('UPDATE network.dot_operation_reviews SET decision=$3 WHERE environment=$1 AND id=$2',[...scope,decision]);
    }
    return {operacao:row.tool_name as string,dados:row.details as Record<string,unknown>,
      status:(row.executed_at?'executada':row.decision??decision??'pendente') as string,
      key:row.operation_key as string,identity:{person_id:person,collaborator_id:row.collaborator_id,grant_id:grant.grant_id} as DotIdentity};
  });
}
