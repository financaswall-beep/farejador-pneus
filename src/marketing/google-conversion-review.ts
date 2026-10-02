import type { Pool } from 'pg';
import { pool } from '../persistence/db.js';
import { env } from '../shared/config/env.js';
import { googleDataManager } from './google-data-manager.js';
import { REALIZED_ORDERS_CTE } from './reporting.js';

const SAFE_REJECTIONS = new Set(['data_manager_rejected','data_manager_quota',
  'data_manager_auth_failed','invalid_conversion']);
type Transport = Pick<Awaited<ReturnType<typeof googleDataManager>>,'status'>;

export async function listGoogleConversionReviews(dbPool:Pool=pool) {
  const result=await dbPool.query(`SELECT q.id,q.order_id,q.status,q.last_error_code,
      q.attempts,q.updated_at,q.request_id IS NOT NULL can_check,c.name campaign_name
    FROM marketing.google_conversion_outbox q
    JOIN marketing.google_order_attributions a ON a.environment=q.environment AND a.id=q.attribution_id
    JOIN marketing.google_clicks g ON g.environment=a.environment AND g.id=a.click_id
    JOIN marketing.google_campaigns c ON c.environment=g.environment AND c.account_id=g.account_id AND c.campaign_id=g.campaign_id
    WHERE q.environment=$1 AND g.account_id=$2 AND q.action_id=$3
      AND q.status IN ('review','dead_letter')
    ORDER BY q.updated_at DESC,q.id LIMIT 100`,
  [env.FAREJADOR_ENV,env.GOOGLE_ADS_CUSTOMER_ID??'',env.GOOGLE_ADS_CONVERSION_ACTION_ID??'']);
  return {rows:result.rows};
}

export async function reviewGoogleConversion(input: {
  id:string;action:'check'|'retry'|'close';reason:string;actor:string;idempotencyKey:string;
},options:{dbPool?:Pool;transport?:Transport}={}) {
  const client=await (options.dbPool??pool).connect();
  try {
    await client.query('BEGIN');
    const found=await client.query<{id:string;order_id:string;status:string;request_id:string|null;
      last_error_code:string|null;attempts:number;eligible:boolean}>(`${REALIZED_ORDERS_CTE}
      SELECT q.id,q.order_id,q.status,q.request_id,q.last_error_code,q.attempts,
        (a.status='active' AND a.superseded_by IS NULL AND c.owned AND g.consent_ad_user_data
          AND EXISTS(SELECT 1 FROM realized r WHERE r.id=q.order_id)) eligible
      FROM marketing.google_conversion_outbox q
      JOIN marketing.google_order_attributions a ON a.environment=q.environment AND a.id=q.attribution_id
      JOIN marketing.google_clicks g ON g.environment=a.environment AND g.id=a.click_id
      JOIN marketing.google_campaigns c ON c.environment=g.environment AND c.account_id=g.account_id AND c.campaign_id=g.campaign_id
      WHERE q.environment=$1 AND q.id=$2 AND g.account_id=$3 AND q.action_id=$4 FOR UPDATE OF q`,
    [env.FAREJADOR_ENV,input.id,env.GOOGLE_ADS_CUSTOMER_ID??'',env.GOOGLE_ADS_CONVERSION_ACTION_ID??'']);
    const row=found.rows[0];
    if(!row)throw new Error('google_conversion_not_found');
    if(!['review','dead_letter'].includes(row.status))throw new Error('google_conversion_not_reviewable');
    let status=row.status, requestId=row.request_id, code=row.last_error_code;
    if(input.action==='close') {status='closed';code='operator_closed';}
    else {
      let remote:'processing'|'sent'|'failed'|'review'|null=null;
      if(requestId) {
        if(!options.transport && (!env.GOOGLE_ADS_SERVICE_ACCOUNT_JSON || !env.GOOGLE_ADS_CUSTOMER_ID
          || !env.GOOGLE_ADS_CONVERSION_ACTION_ID))throw new Error('google_review_not_configured');
        const transport=options.transport??await googleDataManager({serviceAccountJson:env.GOOGLE_ADS_SERVICE_ACCOUNT_JSON!,
          accountId:env.GOOGLE_ADS_CUSTOMER_ID!,actionId:env.GOOGLE_ADS_CONVERSION_ACTION_ID!,loginId:env.GOOGLE_ADS_LOGIN_CUSTOMER_ID});
        remote=await transport.status(requestId);
      }
      if(input.action==='check') {
        if(!requestId)throw new Error('google_request_missing');
        status=remote==='processing'?'accepted':remote==='failed'?'dead_letter':remote!;
        code=remote==='failed'?'data_manager_processing_failed':remote==='review'?'data_manager_partial_result':null;
        if(remote==='sent'&&!row.eligible) {status='review';code='sent_sale_cancelled';}
      } else {
        if(!row.eligible)throw new Error('google_sale_not_eligible');
        if(!env.GOOGLE_ADS_CONVERSIONS_ENABLED)throw new Error('google_conversions_disabled');
        // Absence of a publication is not proof of rejection. Never reopen
        // an ambiguous POST, partial ingestion or confirmed conversion.
        if(requestId ? remote!=='failed' : !SAFE_REJECTIONS.has(code??''))throw new Error('google_retry_not_proven_safe');
        status='pending';requestId=null;code=null;
      }
    }
    await client.query(`UPDATE marketing.google_conversion_outbox SET status=$3,request_id=$4,
      last_error_code=$5,not_before=now(),locked_at=NULL,updated_at=now(),
      attempts=CASE WHEN $6='retry' OR ($6='check' AND $3='accepted') THEN 0 ELSE attempts END,
      sent_at=CASE WHEN $3='sent' THEN COALESCE(sent_at,now()) ELSE sent_at END
      WHERE environment=$1 AND id=$2`,[env.FAREJADOR_ENV,row.id,status,requestId,code,input.action]);
    await client.query(`INSERT INTO audit.events(environment,domain,entity_table,entity_id,event_type,
      actor_label,idempotency_key,payload_before,payload_after)
      VALUES($1,'marketing','marketing.google_conversion_outbox',$2,'marketing_google_conversion_reviewed',
        $3,$4,$5::jsonb,$6::jsonb)`,[env.FAREJADOR_ENV,row.id,input.actor,input.idempotencyKey,
      JSON.stringify({status:row.status,attempts:row.attempts,last_error_code:row.last_error_code}),
      JSON.stringify({status,action:input.action,reason:input.reason.trim(),last_error_code:code})]);
    await client.query('COMMIT');
    return {status,queued:status==='pending'};
  } catch(error) {await client.query('ROLLBACK');throw error;}
  finally {client.release();}
}
