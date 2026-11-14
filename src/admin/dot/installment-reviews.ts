import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { pool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { changeInstallmentInTransaction, readOpenInstallment } from '../painel/sale-installment-due-date.js';
import { dotConfig, DOT_SCOPE } from './config.js';
import type { DotIdentity } from './token-store.js';

export const proposalSchema = z.object({
  order_id: z.string().uuid(), number: z.number().int().min(1).max(120),
  expected_due_date: z.string().date(), due_date: z.string().date(),
}).strict();
type Proposal = z.infer<typeof proposalSchema>;

export async function transact<T>(work: (db: PoolClient) => Promise<T>) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const result = await work(db);
    await db.query('COMMIT');
    return result;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally { db.release(); }
}

const activeGrant = `SELECT g.installment_reviews_enabled,
     COALESCE((to_jsonb(g)->>'finance_operations_enabled')::boolean,false) finance_operations_enabled,
     COALESCE((to_jsonb(g)->>'installment_chat_confirmation')::boolean,false) installment_chat_confirmation
   FROM network.dot_oauth_grants g
   JOIN network.matriz_collaborators c ON c.id=g.collaborator_id AND c.environment=g.environment
     AND c.person_id=g.person_id AND c.panel_role='owner' AND c.revoked_at IS NULL
   JOIN network.partner_people p ON p.id=g.person_id AND p.environment=g.environment AND p.revoked_at IS NULL
   WHERE g.environment=$1 AND g.person_id=$2 AND g.id=$3 AND g.revoked_at IS NULL
     AND g.expires_at>clock_timestamp() AND g.code_used_at IS NOT NULL
     AND g.client_id=$4 AND g.resource=$5 AND g.scope=$6 FOR UPDATE OF g`;

export async function lockGrant(db: PoolClient, person: string, grant: string) {
  const config=dotConfig();
  if (!config) throw new Error('dot_grant_unavailable');
  const row = (await db.query<{finance_operations_enabled:boolean;installment_reviews_enabled:boolean;installment_chat_confirmation:boolean}>(activeGrant,
    [env.FAREJADOR_ENV,person,grant,config.clientId,config.resource,DOT_SCOPE])).rows[0];
  if (!row) throw new Error('dot_grant_unavailable');
  return row;
}

export async function setInstallmentPermission(person: string, grant: string, enabled: boolean, chatConfirmation = false) {
  return transact(async db => {
    await lockGrant(db,person,grant);
    await db.query(`UPDATE network.dot_oauth_grants SET installment_reviews_enabled=$4, installment_chat_confirmation=$5
      WHERE environment=$1 AND person_id=$2 AND id=$3`,[env.FAREJADOR_ENV,person,grant,enabled,enabled && chatConfirmation]);
    if (!enabled) await db.query(`DELETE FROM network.dot_installment_reviews
      WHERE environment=$1 AND grant_id=$2 AND confirmed_at IS NULL`,[env.FAREJADOR_ENV,grant]);
    return { enabled };
  });
}

export async function proposeInstallment(identity: DotIdentity, proposal: Proposal) {
  return transact(async db => {
    const grant = await lockGrant(db,identity.person_id,identity.grant_id);
    if (!grant.installment_reviews_enabled) throw new Error('dot_review_disabled');
    const { order_id, number, due_date, expected_due_date } = proposal;
    const { current, buyerName } = await readOpenInstallment(db,order_id,number,due_date);
    if (current.due_date !== expected_due_date || due_date === expected_due_date) throw new Error('sale_installment_changed');
    const args = [env.FAREJADOR_ENV, identity.grant_id, order_id, number, expected_due_date, due_date, current.balance];
    await db.query(`DELETE FROM network.dot_installment_reviews WHERE environment=$1 AND grant_id=$2
      AND expires_at<=now() AND confirmed_at IS NULL`,args.slice(0,2));
    const existing = await db.query(`SELECT id,expires_at FROM network.dot_installment_reviews
      WHERE environment=$1 AND grant_id=$2 AND order_id=$3 AND installment_number=$4
        AND old_due=$5 AND new_due=$6 AND balance=$7 AND confirmed_at IS NULL AND expires_at>now() LIMIT 1`,args);
    const row = existing.rows[0] ?? (await db.query(`INSERT INTO network.dot_installment_reviews
      (environment,grant_id,order_id,installment_number,old_due,new_due,balance) VALUES ($1,$2,$3,$4,$5,$6,$7)
      RETURNING id,expires_at`,args)).rows[0];
    return { status:'aguardando_confirmacao', proposta:row.id, cliente:buyerName, parcela:number, saldo:current.balance,
      vencimento_atual:expected_due_date, novo_vencimento:due_date, expires_at:row.expires_at,
      confirmacao:grant.installment_chat_confirmation?'conversa':'painel',
      ...(grant.installment_chat_confirmation
        ? {ferramenta_confirmacao:'confirmar_alteracao_vencimento'}
        : {confirm_url:installmentReviewUrl(row.id)}) };
  });
}

export function installmentReviewUrl(id: string) {
  return env.DOT_MCP_PUBLIC_ORIGIN + '/admin/dot/connections?proposta=' + id;
}

const reviewSql = `SELECT r.id,r.grant_id,r.order_id,r.installment_number,r.old_due::text,r.new_due::text,
    r.balance::text,c.name buyer_name,r.confirmed_at,r.restored_at,r.expires_at<=clock_timestamp() expired
  FROM network.dot_installment_reviews r JOIN network.dot_oauth_grants g
    ON g.environment=r.environment AND g.id=r.grant_id
  JOIN commerce.wholesale_orders o ON o.environment=r.environment AND o.id=r.order_id
  JOIN commerce.wholesale_customers c ON c.environment=o.environment AND c.id=o.buyer_id
  WHERE r.environment=$1 AND g.person_id=$2 AND r.id=$3`;

type ReviewCaller = { person: string; action: 'view' | 'confirm' | 'restore' }
  | { person: string; action: 'confirm-in-chat'; grantId: string };

export async function reviewInstallment(id: string, caller: ReviewCaller) {
  return transact(async db => {
    const {person,action}=caller;
    // Mesma ordem de travas de desativar: conexão, proposta e depois venda.
    // A chamada por voz já traz a conexão autenticada; só o link do painel precisa localizá-la.
    const grantId = caller.action==='confirm-in-chat' ? caller.grantId :
      (await db.query<{grant_id:string}>(`SELECT grant_id FROM network.dot_installment_reviews
        WHERE environment=$1 AND id=$2`,[env.FAREJADOR_ENV,id])).rows[0]?.grant_id;
    if (!grantId) throw new Error('dot_review_missing');
    const permission = await lockGrant(db,person,grantId);
    const row = (await db.query(reviewSql+' AND r.grant_id=$4 FOR UPDATE OF r',
      [env.FAREJADOR_ENV,person,id,grantId])).rows[0];
    if (!row) throw new Error('dot_review_missing');
    if (action==='confirm-in-chat' && !(permission.installment_reviews_enabled && permission.installment_chat_confirmation))
      throw new Error('dot_review_disabled');
    if (row.restored_at) return { ...row, status:'restaurado' };
    if (action === 'restore') {
      if (!row.confirmed_at) throw new Error('dot_review_missing');
      await changeInstallmentInTransaction(db,{order_id:row.order_id,number:row.installment_number,
        expected_due_date:row.new_due,due_date:row.old_due,idempotency_key:randomUUID()},'Dono · reversão da Milly '+person);
      await db.query('UPDATE network.dot_installment_reviews SET restored_at=now() WHERE environment=$1 AND id=$2',
        [env.FAREJADOR_ENV,id]);
      return { ...row, status:'restaurado' };
    }
    if (row.confirmed_at) return { ...row, status:'confirmado' };
    if (!permission.installment_reviews_enabled || row.expired) throw new Error('dot_review_expired');
    if (action === 'view') return { ...row, status:'pendente', confirmacao:permission.installment_chat_confirmation?'conversa':'painel' };
    await changeInstallmentInTransaction(db,{order_id:row.order_id,number:row.installment_number,
      expected_due_date:row.old_due,due_date:row.new_due,idempotency_key:id},
      action==='confirm-in-chat'?'Milly · autorização na conversa · dono '+person:'Milly · dono '+person,Number(row.balance));
    await db.query(`UPDATE network.dot_installment_reviews SET confirmed_at=now() WHERE environment=$1 AND id=$2`,
      [env.FAREJADOR_ENV,id]);
    return { ...row, status:'confirmado' };
  });
}
