import type { Pool, PoolClient } from 'pg';
import { pool } from '../persistence/db.js';
import { env } from '../shared/config/env.js';
import { REALIZED_ORDERS_CTE } from './reporting.js';
import { META_BUSINESS_ACCOUNTS } from '../shared/meta-business-accounts.js';

/** Backfill apenas de referencia explicita na mensagem do cliente ou atributo do widget. */
export async function captureGoogleConversations(client: PoolClient, environment = env.FAREJADOR_ENV): Promise<number> {
  const result = await client.query(`INSERT INTO marketing.google_click_conversations(environment,click_id,conversation_id,source,observed_at)
    SELECT DISTINCT ON (g.id) g.environment,g.id,c.id,'message_reference',m.sent_at
    FROM core.messages m
    CROSS JOIN LATERAL regexp_matches(m.content,
      '(?<![a-zA-Z0-9])(2W-G[a-f0-9]{32})(?![a-zA-Z0-9])','g') reference_match
    JOIN marketing.google_clicks g ON g.environment=m.environment AND g.reference=reference_match[1]
      AND m.sent_at>=g.captured_at AND m.sent_at<g.captured_at+interval '7 days'
    JOIN core.conversations c ON c.id=m.conversation_id AND c.environment=m.environment
    WHERE g.environment=$1 AND g.destination='whatsapp'
      AND m.sender_type='contact' AND m.message_type=0 AND NOT m.is_private
      AND NOT EXISTS(SELECT 1 FROM marketing.google_click_conversations b
        WHERE b.environment=g.environment AND b.click_id=g.id)
      AND c.channel_type='whatsapp'
    ORDER BY g.id,m.sent_at,c.id ON CONFLICT DO NOTHING`,[environment]);
  const web = await client.query(`INSERT INTO marketing.google_click_conversations(environment,click_id,conversation_id,source,observed_at)
    SELECT DISTINCT ON(g.id) g.environment,g.id,c.id,'web_custom_attribute',c.last_event_at
    FROM marketing.google_clicks g JOIN core.conversations c ON c.environment=g.environment
      AND c.custom_attributes->>'farejador_google_click_ref'=g.reference
    WHERE g.environment=$1 AND g.destination='web' AND c.channel_type='web'
      AND c.last_event_at>=g.captured_at AND c.last_event_at<g.captured_at+interval '7 days'
    ORDER BY g.id,c.last_event_at,c.id ON CONFLICT DO NOTHING`,[environment]);
  return (result.rowCount ?? 0)+(web.rowCount ?? 0);
}

export async function reconcileGoogleAttributions(options: {dbPool?: Pool; environment?: 'prod'|'test'} = {}) {
  const environment = options.environment ?? env.FAREJADOR_ENV;
  const client = await (options.dbPool ?? pool).connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('marketing-attribution:'||$1))",[environment]);
    const linked = await captureGoogleConversations(client,environment);
    const invalid = await client.query<{id:string;order_id:string;click_id:string;conversation_id:string;realized_at:string}>(
      `${REALIZED_ORDERS_CTE} SELECT a.* FROM marketing.google_order_attributions a
       WHERE a.environment=$1 AND a.status='active' AND a.superseded_by IS NULL
       AND NOT EXISTS(SELECT 1 FROM realized r WHERE r.id=a.order_id) FOR UPDATE OF a`,[environment]);
    for (const old of invalid.rows) {
      const next = await client.query<{id:string}>(`INSERT INTO marketing.google_order_attributions
        (environment,order_id,click_id,conversation_id,status,realized_at,truth_type,confidence_level,source_reference,extractor_version)
        VALUES($1,$2,$3,$4,'revoked',$5,'corrected',1,jsonb_build_object('reason','sale_not_realized','previous_id',$6::uuid),'google_last_click_7d_v1') RETURNING id`,
      [environment,old.order_id,old.click_id,old.conversation_id,old.realized_at,old.id]);
      await client.query('UPDATE marketing.google_order_attributions SET superseded_by=$3 WHERE environment=$1 AND id=$2',[environment,old.id,next.rows[0]!.id]);
    }
    const candidates = await client.query<{order_id:string;click_id:string;conversation_id:string;realized_at:string}>(
      `${REALIZED_ORDERS_CTE} SELECT r.id order_id,g.id click_id,r.source_conversation_id conversation_id,r.realized_at
       FROM realized r JOIN LATERAL (
         SELECT g.* FROM marketing.google_click_conversations b JOIN marketing.google_clicks g
           ON g.environment=b.environment AND g.id=b.click_id
         JOIN marketing.google_campaigns c ON c.environment=g.environment AND c.account_id=g.account_id AND c.campaign_id=g.campaign_id
         WHERE b.environment=$1 AND b.conversation_id=r.source_conversation_id AND c.owned
           AND g.account_id=$4 AND g.captured_at<=r.realized_at AND b.observed_at<=r.realized_at
           AND g.captured_at>r.realized_at-interval '7 days'
           AND NOT EXISTS(SELECT 1 FROM marketing.google_order_attributions a WHERE a.environment=$1 AND a.click_id=g.id
             AND a.status='active' AND a.superseded_by IS NULL)
         ORDER BY g.captured_at DESC,g.id DESC LIMIT 1
       ) g ON true
       WHERE NOT EXISTS(SELECT 1 FROM marketing.google_order_attributions a WHERE a.environment=$1 AND a.order_id=r.id AND a.status='active' AND a.superseded_by IS NULL)
         AND NOT EXISTS(SELECT 1 FROM marketing.order_attributions a WHERE a.environment=$1 AND a.order_id=r.id AND a.status='active' AND a.superseded_by IS NULL)
         AND NOT EXISTS(SELECT 1 FROM marketing.ad_referrals m WHERE m.environment=$1 AND m.conversation_id=r.source_conversation_id
           AND m.captured_at>=g.captured_at AND m.captured_at<=r.realized_at
           AND (m.channel='whatsapp' OR (m.channel='messenger' AND m.business_account_id=$2) OR (m.channel='instagram' AND m.business_account_id=$3)))
       ORDER BY r.realized_at,r.id`,[environment,META_BUSINESS_ACCOUNTS.facebook.id,META_BUSINESS_ACCOUNTS.instagram.id,env.GOOGLE_ADS_CUSTOMER_ID]);
    let created = 0;
    for (const row of candidates.rows) {
      const inserted = await client.query(`INSERT INTO marketing.google_order_attributions
        (environment,order_id,click_id,conversation_id,status,realized_at,truth_type,confidence_level,source_reference,extractor_version)
        VALUES($1,$2,$3,$4,'active',$5,'observed',1,jsonb_build_object('click_id',$3::uuid,'order_id',$2::uuid,'window_days',7),'google_last_click_7d_v1') ON CONFLICT DO NOTHING`,
      [environment,row.order_id,row.click_id,row.conversation_id,row.realized_at]);
      created += inserted.rowCount ?? 0;
    }
    await client.query('COMMIT');
    return {linked,created,revoked:invalid.rowCount ?? 0};
  } catch(error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

/** A Meta continua com seu motor. Apenas impede que a mesma venda entre nos dois canais. */
export async function googleOwnsLastTouch(client: PoolClient, order: {id:string;conversation_id:string;realized_at:string}, metaTime: string): Promise<boolean> {
  if (!env.GOOGLE_ADS_ENABLED) return false;
  const result = await client.query(`SELECT 1 FROM marketing.google_order_attributions
    WHERE environment=$1 AND order_id=$2 AND status='active' AND superseded_by IS NULL
    UNION ALL SELECT 1 FROM marketing.google_click_conversations b JOIN marketing.google_clicks g
      ON g.environment=b.environment AND g.id=b.click_id JOIN marketing.google_campaigns c ON c.environment=g.environment AND c.account_id=g.account_id AND c.campaign_id=g.campaign_id
    WHERE b.environment=$1 AND b.conversation_id=$3 AND c.owned AND g.account_id=$6
      AND g.captured_at>$4::timestamptz AND g.captured_at<=$5::timestamptz AND b.observed_at<=$5::timestamptz
      AND g.captured_at>$5::timestamptz-interval '7 days'
      AND NOT EXISTS(SELECT 1 FROM marketing.google_order_attributions a WHERE a.environment=$1 AND a.click_id=g.id
        AND a.status='active' AND a.superseded_by IS NULL) LIMIT 1`,
  [env.FAREJADOR_ENV,order.id,order.conversation_id,metaTime,order.realized_at,env.GOOGLE_ADS_CUSTOMER_ID]);
  return !!result.rowCount;
}
