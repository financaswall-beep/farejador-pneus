import type { Pool, PoolClient } from 'pg';
import { pool as defaultPool } from '../persistence/db.js';
import { env } from '../shared/config/env.js';

const ATTRIBUTION_MODEL = 'last_click_7d_one_sale';
const RULE_VERSION = 2;
const EXTRACTOR_VERSION = 'marketing_attribution_sql_v2_multichannel';

interface RealizedOrder {
  id: string;
  conversation_id: string;
  realized_at: string;
}

interface ReferralCandidate {
  id: string;
  captured_at: string;
  channel: 'whatsapp' | 'messenger' | 'instagram';
}

export interface AttributionReconcileResult {
  enabled: boolean;
  referrals_backfilled: number;
  realized_orders: number;
  orders_with_conversation: number;
  created: number;
  revoked: number;
}

export async function backfillAdReferrals(client: PoolClient): Promise<number> {
  const result = await client.query(
    `INSERT INTO marketing.ad_referrals (
       environment,conversation_id,source_message_id,source_message_sent_at,
       channel,referral_key,ctwa_clid,source_id,source_url,source_type,headline,
       referral_payload,captured_at
     )
     SELECT DISTINCT ON (m.environment,m.content_attributes #>> '{referral,ctwa_clid}')
       m.environment,m.conversation_id,m.id,m.sent_at,
       'whatsapp',
       'whatsapp:'||(m.content_attributes #>> '{referral,ctwa_clid}'),
       m.content_attributes #>> '{referral,ctwa_clid}',
       NULLIF(m.content_attributes #>> '{referral,source_id}',''),
       NULLIF(m.content_attributes #>> '{referral,source_url}',''),
       NULLIF(m.content_attributes #>> '{referral,source_type}',''),
       NULLIF(m.content_attributes #>> '{referral,headline}',''),
       m.content_attributes,
       m.sent_at
     FROM core.messages m
     WHERE m.environment=$1 AND m.sender_type='contact' AND m.is_private=false
       AND COALESCE(m.content_attributes #>> '{referral,ctwa_clid}','')<>''
     ORDER BY m.environment,m.content_attributes #>> '{referral,ctwa_clid}',m.sent_at
     ON CONFLICT DO NOTHING`,
    [env.FAREJADOR_ENV],
  );
  return result.rowCount ?? 0;
}

async function loadRealizedOrders(client: PoolClient): Promise<{
  total: number;
  withConversation: RealizedOrder[];
}> {
  const result = await client.query<RealizedOrder & { total_realized: number }>(
    `WITH realized AS (
       SELECT o.id,o.source_conversation_id AS conversation_id,
         CASE
           WHEN po.id IS NOT NULL AND po.fulfillment_mode='delivery'
             THEN COALESCE(po.delivered_at,po.created_at)
           WHEN po.id IS NOT NULL
             THEN COALESCE(po.retrieved_at,po.created_at)
           WHEN o.fulfillment_mode='delivery'
             THEN COALESCE(o.delivered_at,o.closed_at,o.created_at)
           ELSE o.created_at
         END AS realized_at
       FROM commerce.orders o
       LEFT JOIN commerce.partner_orders po
         ON po.environment=o.environment AND po.id=o.partner_order_id
       WHERE o.environment=$1 AND o.status<>'cancelled'
         AND (
           (po.id IS NOT NULL AND po.status<>'cancelled' AND po.deleted_at IS NULL
             AND NOT (po.fulfillment_mode='delivery' AND po.delivery_status<>'delivered')
             AND NOT po.awaiting_pickup)
           OR
           (po.id IS NULL
             AND NOT (o.fulfillment_mode='delivery' AND o.delivery_status<>'delivered'))
         )
     )
     SELECT id,conversation_id,realized_at::text,
            count(*) OVER()::int AS total_realized
     FROM realized
     WHERE conversation_id IS NOT NULL
     ORDER BY realized_at,id`,
    [env.FAREJADOR_ENV],
  );
  const totalResult = await client.query<{ total: number }>(
    `SELECT count(*)::int AS total
       FROM commerce.orders o
       LEFT JOIN commerce.partner_orders po
         ON po.environment=o.environment AND po.id=o.partner_order_id
      WHERE o.environment=$1 AND o.status<>'cancelled'
        AND (
          (po.id IS NOT NULL AND po.status<>'cancelled' AND po.deleted_at IS NULL
            AND NOT (po.fulfillment_mode='delivery' AND po.delivery_status<>'delivered')
            AND NOT po.awaiting_pickup)
          OR
          (po.id IS NULL
            AND NOT (o.fulfillment_mode='delivery' AND o.delivery_status<>'delivered'))
        )`,
    [env.FAREJADOR_ENV],
  );
  return {
    total: Number(totalResult.rows[0]?.total ?? 0),
    withConversation: result.rows,
  };
}

async function revokeInvalidAttributions(client: PoolClient): Promise<number> {
  const invalid = await client.query<{
    id: string;
    order_id: string;
    referral_id: string;
    conversation_id: string;
    realized_at: string;
  }>(
    `SELECT a.id,a.order_id,a.referral_id,a.conversation_id,a.realized_at::text
       FROM marketing.order_attributions a
       JOIN commerce.orders o ON o.id=a.order_id AND o.environment=a.environment
       LEFT JOIN commerce.partner_orders po
         ON po.environment=o.environment AND po.id=o.partner_order_id
      WHERE a.environment=$1 AND a.status='active' AND a.superseded_by IS NULL
        AND (
          o.status='cancelled'
          OR (po.id IS NOT NULL AND
              (po.status='cancelled' OR po.deleted_at IS NOT NULL
               OR (po.fulfillment_mode='delivery' AND po.delivery_status<>'delivered')
               OR po.awaiting_pickup))
          OR (po.id IS NULL AND o.fulfillment_mode='delivery'
              AND o.delivery_status<>'delivered')
        )
      FOR UPDATE OF a`,
    [env.FAREJADOR_ENV],
  );
  for (const row of invalid.rows) {
    const replacement = await client.query<{ id: string }>(
      `INSERT INTO marketing.order_attributions (
         environment,order_id,referral_id,conversation_id,status,attribution_model,
         rule_version,source_type,truth_type,confidence_level,source_reference,
         extractor_version,realized_at
       ) VALUES (
         $1,$2,$3,$4,'revoked',$5,$6,'deterministic_meta_messaging','corrected',1.00,
         jsonb_build_object('reason','sale_not_realized','previous_attribution_id',$7),
         $8,$9
       ) RETURNING id`,
      [
        env.FAREJADOR_ENV, row.order_id, row.referral_id, row.conversation_id,
        ATTRIBUTION_MODEL, RULE_VERSION, row.id, EXTRACTOR_VERSION, row.realized_at,
      ],
    );
    await client.query(
      `UPDATE marketing.order_attributions SET superseded_by=$2
        WHERE environment=$1 AND id=$3`,
      [env.FAREJADOR_ENV, replacement.rows[0]?.id, row.id],
    );
  }
  return invalid.rowCount ?? 0;
}

async function findReferral(
  client: PoolClient,
  order: RealizedOrder,
  used: Set<string>,
): Promise<ReferralCandidate | null> {
  const result = await client.query<ReferralCandidate>(
    `SELECT r.id,r.captured_at::text,r.channel
       FROM marketing.ad_referrals r
      WHERE r.environment=$1 AND r.conversation_id=$2
        AND r.captured_at<=$3::timestamptz
        AND r.captured_at>$3::timestamptz-interval '7 days'
      ORDER BY r.captured_at DESC,r.id DESC`,
    [env.FAREJADOR_ENV, order.conversation_id, order.realized_at],
  );
  return result.rows.find((row) => !used.has(row.id)) ?? null;
}

export async function reconcileMarketingAttributions(options: {
  dbPool?: Pool;
  enabled?: boolean;
} = {}): Promise<AttributionReconcileResult> {
  const enabled = options.enabled ?? env.MARKETING_ATTRIBUTION;
  if (!enabled) {
    return {
      enabled: false,
      referrals_backfilled: 0,
      realized_orders: 0,
      orders_with_conversation: 0,
      created: 0,
      revoked: 0,
    };
  }
  const client = await (options.dbPool ?? defaultPool).connect();
  try {
    await client.query('BEGIN');
    const referralsBackfilled = await backfillAdReferrals(client);
    const revoked = await revokeInvalidAttributions(client);
    const orders = await loadRealizedOrders(client);
    const active = await client.query<{ referral_id: string; order_id: string }>(
      `SELECT referral_id,order_id FROM marketing.order_attributions
        WHERE environment=$1 AND status='active' AND superseded_by IS NULL`,
      [env.FAREJADOR_ENV],
    );
    const usedReferrals = new Set(active.rows.map((row) => row.referral_id));
    const attributedOrders = new Set(active.rows.map((row) => row.order_id));
    let created = 0;
    for (const order of orders.withConversation) {
      if (attributedOrders.has(order.id)) continue;
      const referral = await findReferral(client, order, usedReferrals);
      if (!referral) continue;
      const inserted = await client.query(
        `INSERT INTO marketing.order_attributions (
           environment,order_id,referral_id,conversation_id,status,attribution_model,
           rule_version,source_type,truth_type,confidence_level,source_reference,
           extractor_version,realized_at
         ) VALUES (
           $1,$2,$3,$4,'active',$5,$6,'deterministic_meta_messaging','observed',1.00,
           jsonb_build_object('ad_referral_id',$3,'order_id',$2,'window_days',7,
             'channel',$7),$8,$9
         ) ON CONFLICT DO NOTHING`,
        [
          env.FAREJADOR_ENV, order.id, referral.id, order.conversation_id,
          ATTRIBUTION_MODEL, RULE_VERSION, referral.channel,
          EXTRACTOR_VERSION, order.realized_at,
        ],
      );
      if ((inserted.rowCount ?? 0) > 0) {
        created += 1;
        usedReferrals.add(referral.id);
        attributedOrders.add(order.id);
      }
    }
    await client.query('COMMIT');
    return {
      enabled: true,
      referrals_backfilled: referralsBackfilled,
      realized_orders: orders.total,
      orders_with_conversation: orders.withConversation.length,
      created,
      revoked,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
