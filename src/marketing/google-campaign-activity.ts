import type { Pool } from 'pg';
import { pool } from '../persistence/db.js';
import { env } from '../shared/config/env.js';
import { GOOGLE_RESULTS_CTE } from './google-results.js';

const PAGE_SIZE = 25;
interface Page<T> { total:number; rows:T[] }
interface CampaignOrder {
  order_id:string; ad_id:string; revenue:string; gross_margin:string|null;
  product_cost:string|null; partner_payout:string|null; realized_at:string;
  conversation_number:number; conversion_status:string|null;
}
interface CampaignConversation {
  conversation_number:number; current_status:string; channel_type:string;
  observed_at:string; ad_id:string;
}
interface CampaignEvent { id:string; order_id:string; status:string; attempts:number; updated_at:string; sent_at:string|null }

// Somente leitura. Conta, ambiente e propriedade nunca vêm do navegador.
export async function getGoogleCampaignActivity(account:string, campaign:string, since:string, until:string,
  orderPage=1, conversationPage=1, dbPool:Pool=pool) {
  const values=[env.FAREJADOR_ENV,since,until,account,campaign];
  const orders=await dbPool.query<Page<CampaignOrder>>(`${GOOGLE_RESULTS_CTE}, selected AS (
    SELECT a.order_id,a.ad_id,a.total_amount::text revenue,a.gross_margin::text gross_margin,
      a.product_cost::text product_cost,a.partner_payout::text partner_payout,a.realized_at,
      c.chatwoot_conversation_id conversation_number,q.status conversion_status
    FROM attributed a JOIN core.conversations c ON c.environment=$1 AND c.id=a.conversation_id
    LEFT JOIN marketing.google_conversion_outbox q ON q.environment=$1 AND q.attribution_id=a.id AND q.action_id=$6
    WHERE a.campaign_id=$5
  ), page AS (SELECT * FROM selected ORDER BY realized_at DESC,order_id LIMIT 25 OFFSET $7)
  SELECT (SELECT count(*)::int FROM selected) total,
    COALESCE((SELECT jsonb_agg(page ORDER BY realized_at DESC,order_id) FROM page),'[]'::jsonb) rows`,
  [...values,env.GOOGLE_ADS_CONVERSION_ACTION_ID??'',(orderPage-1)*PAGE_SIZE]);
  const conversations=await dbPool.query<Page<CampaignConversation>>(`WITH selected AS (
    SELECT DISTINCT ON (c.id) c.chatwoot_conversation_id conversation_number,c.current_status,c.channel_type,
      b.observed_at,g.ad_group_id||':'||g.ad_id ad_id
    FROM marketing.google_clicks g
    JOIN marketing.google_click_conversations b ON b.environment=g.environment AND b.click_id=g.id
    JOIN core.conversations c ON c.environment=b.environment AND c.id=b.conversation_id
    JOIN marketing.google_campaigns p ON p.environment=g.environment AND p.account_id=g.account_id AND p.campaign_id=g.campaign_id
    WHERE g.environment=$1 AND g.account_id=$4 AND g.campaign_id=$5 AND p.owned
      AND b.observed_at>=($2::date::timestamp AT TIME ZONE 'America/Sao_Paulo')
      AND b.observed_at<(($3::date+1)::timestamp AT TIME ZONE 'America/Sao_Paulo')
    ORDER BY c.id,b.observed_at DESC,g.id
  ), page AS (SELECT * FROM selected ORDER BY observed_at DESC,conversation_number LIMIT 25 OFFSET $6)
  SELECT (SELECT count(*)::int FROM selected) total,
    COALESCE((SELECT jsonb_agg(page ORDER BY observed_at DESC,conversation_number) FROM page),'[]'::jsonb) rows`,
  [...values,(conversationPage-1)*PAGE_SIZE]);
  // Histórico inclui envios em revisão após cancelamento; não depende da lista paginada de vendas.
  const events=await dbPool.query<CampaignEvent>(`SELECT q.id,a.order_id,q.status,q.attempts,q.updated_at,q.sent_at
    FROM marketing.google_order_attributions a
    JOIN marketing.google_clicks g ON g.environment=a.environment AND g.id=a.click_id
    JOIN marketing.google_campaigns p ON p.environment=g.environment AND p.account_id=g.account_id AND p.campaign_id=g.campaign_id
    JOIN marketing.google_conversion_outbox q ON q.environment=a.environment AND q.attribution_id=a.id AND q.action_id=$6
    WHERE a.environment=$1 AND g.account_id=$4 AND g.campaign_id=$5 AND p.owned
      AND a.realized_at>=($2::date::timestamp AT TIME ZONE 'America/Sao_Paulo')
      AND a.realized_at<(($3::date+1)::timestamp AT TIME ZONE 'America/Sao_Paulo')
    ORDER BY q.updated_at DESC,q.id LIMIT 30`,[...values,env.GOOGLE_ADS_CONVERSION_ACTION_ID??'']);
  return {available:true,page_size:PAGE_SIZE,orders:{...orders.rows[0],page:orderPage},
    conversations:{...conversations.rows[0],page:conversationPage},events:events.rows};
}
