import type { Pool } from 'pg';
import { pool } from '../persistence/db.js';
import { env } from '../shared/config/env.js';
import { clearMetaMarketingCache } from '../admin/painel/marketing-meta.js';
import { reconcileMatrizMarketingCampaign } from './matriz-ledger-spend.js';
import type { MetaAdIdentity } from './meta-ad-identity.js';

type DecisionScope = 'matrix' | 'external' | 'automatic';
interface Decision {
  ad_id: string; identity_fingerprint: string; scope: DecisionScope; decision_seq: string;
}

export async function resolveMetaIdentities(db: Pick<Pool,'query'>, environment: string,
  account: string, identities: MetaAdIdentity[]) {
  const result = await db.query<Decision>(`SELECT DISTINCT ON(ad_id)
      ad_id,identity_fingerprint,scope,decision_seq::text
    FROM marketing.meta_ad_identity_decisions WHERE environment=$1 AND ad_account_id=$2
    ORDER BY ad_id,decision_seq DESC`, [environment,account]);
  const decisions = new Map(result.rows.map(row => [row.ad_id,row]));
  const version = result.rows.reduce((value,row) => BigInt(row.decision_seq)>value ? BigInt(row.decision_seq) : value,0n).toString();
  return {version, identities:identities.map(ad => {
    const decision=decisions.get(ad.id);
    return decision && decision.scope!=='automatic' && decision.identity_fingerprint===ad.fingerprint
      ? {...ad,scope:decision.scope} : ad;
  })};
}

export async function listMetaIdentityReviews(dbPool: Pool = pool) {
  const rows = await dbPool.query(`SELECT d.ad_account_id,d.ad_id,d.campaign_id,d.facebook_page_id,
      d.instagram_user_id,d.scope,d.automatic_scope,d.verified_at,
      o.scope decision,o.reason,o.actor_label,o.created_at decision_at,
      (d.identity_fingerprint IS NOT NULL AND d.verified_at >= a.verified_at) can_decide
    FROM marketing.meta_ad_identities d
    JOIN marketing.meta_identity_accounts a USING(environment,ad_account_id)
    LEFT JOIN LATERAL (SELECT scope,reason,actor_label,created_at
      FROM marketing.meta_ad_identity_decisions o
      WHERE o.environment=d.environment AND o.ad_account_id=d.ad_account_id AND o.ad_id=d.ad_id
      ORDER BY decision_seq DESC LIMIT 1) o ON true
    WHERE d.environment=$1 AND (d.scope='pending' OR o.scope IN ('matrix','external'))
    ORDER BY (d.scope='pending') DESC,d.ad_account_id,d.ad_id LIMIT 100`, [env.FAREJADOR_ENV]);
  const count = await dbPool.query<{pending:number}>(`SELECT count(*)::int pending
    FROM marketing.meta_ad_identities WHERE environment=$1 AND scope='pending'`,[env.FAREJADOR_ENV]);
  return {rows:rows.rows,pending:count.rows[0]?.pending??0};
}

export async function setMetaIdentityDecision(input: {
  account:string;ad:string;scope:DecisionScope;reason:string;actor:string;idempotencyKey:string;
}, dbPool:Pool=pool) {
  const client=await dbPool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
      [`meta-identity:${env.FAREJADOR_ENV}:${input.account}`]);
    const found=await client.query<{campaign_id:string;scope:string;automatic_scope:string;identity_fingerprint:string|null;current_snapshot:boolean}>(
      `SELECT d.campaign_id,d.scope,d.automatic_scope,d.identity_fingerprint,
          d.verified_at >= a.verified_at current_snapshot
       FROM marketing.meta_ad_identities d JOIN marketing.meta_identity_accounts a USING(environment,ad_account_id)
       WHERE d.environment=$1 AND d.ad_account_id=$2 AND d.ad_id=$3 FOR UPDATE OF d`,
      [env.FAREJADOR_ENV,input.account,input.ad]);
    const ad=found.rows[0];
    if(!ad)throw new Error('meta_ad_not_found');
    if(!ad.identity_fingerprint || !ad.current_snapshot)throw new Error('meta_identity_sync_required');
    const decision=await client.query<{id:string}>(`INSERT INTO marketing.meta_ad_identity_decisions
      (environment,ad_account_id,ad_id,identity_fingerprint,scope,reason,actor_label)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [env.FAREJADOR_ENV,input.account,input.ad,ad.identity_fingerprint,input.scope,input.reason.trim(),input.actor]);
    const scope=input.scope==='automatic'?ad.automatic_scope:input.scope;
    await client.query(`UPDATE marketing.meta_ad_identities SET scope=$4
      WHERE environment=$1 AND ad_account_id=$2 AND ad_id=$3`,[env.FAREJADOR_ENV,input.account,input.ad,scope]);
    const reconciliation=await reconcileMatrizMarketingCampaign(client,{
      environment:env.FAREJADOR_ENV,adAccountId:input.account,campaignId:ad.campaign_id,
      reconciliationId:decision.rows[0]!.id,createdBy:input.actor});
    await client.query(`INSERT INTO audit.events(environment,domain,entity_table,entity_id,event_type,
      actor_label,idempotency_key,payload_before,payload_after)
      VALUES($1,'marketing','marketing.meta_ad_identity_decisions',$2,'marketing_meta_ad_identity_decided',
        $3,$4,$5::jsonb,$6::jsonb)`,[env.FAREJADOR_ENV,decision.rows[0]!.id,input.actor,input.idempotencyKey,
      JSON.stringify({scope:ad.scope}),JSON.stringify({account:input.account,ad:input.ad,scope,
        reason:input.reason.trim(),reconciliation})]);
    await client.query('COMMIT');
    clearMetaMarketingCache();
    return {scope,reconciliation,sync_required:true};
  } catch(error) {await client.query('ROLLBACK');throw error;}
  finally {client.release();}
}
