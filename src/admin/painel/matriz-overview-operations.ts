import type { Pool } from 'pg';
import { loadCustomerLeadLocations } from './customer-lead-location.js';
import { loadCustomerLeadInterests } from './customer-lead-interests.js';

export async function readOverviewAttention(db: Pool, environment: string) {
  const result=await db.query(`SELECT
    (SELECT count(*)::int FROM ops.conversation_bot_control b JOIN core.conversations c
      ON c.id=b.conversation_id AND c.environment=b.environment
      WHERE b.environment=$1 AND b.mode='human' AND c.deleted_at IS NULL AND c.current_status<>'resolved') human,
    (SELECT count(*)::int FROM commerce.orders o JOIN core.units u
      ON u.id=o.unit_id AND u.environment=o.environment AND u.slug='main'
      WHERE o.environment=$1 AND o.partner_order_id IS NULL AND o.status='open'
        AND o.fulfillment_mode='pickup' AND o.pickup_arrived_at IS NULL
        AND EXISTS(SELECT 1 FROM audit.events e WHERE e.environment=o.environment
          AND e.entity_id=o.id AND e.event_type='matriz_galpao_reserved')) pickups,
    (SELECT count(*)::int FROM commerce.orders o JOIN core.units u
      ON u.id=o.unit_id AND u.environment=o.environment AND u.slug='main'
      WHERE o.environment=$1 AND o.partner_order_id IS NULL AND o.status<>'cancelled'
        AND o.fulfillment_mode='delivery' AND o.delivery_status='pending') deliveries,
    (WITH stock AS (
      SELECT s.measure,s.tire_condition,commerce.stock_vehicle_type(s.environment,s.measure,s.brand,s.tire_condition) vehicle_type,
        sum(s.quantity_on_hand-s.quantity_reserved) available,max(s.min_quantity) minimum
      FROM commerce.wholesale_stock s WHERE s.environment=$1 GROUP BY 1,2,3
    ) SELECT count(*)::int FROM stock s FULL JOIN
      (SELECT * FROM commerce.wholesale_replenishment_policies WHERE environment=$1) p
      ON p.measure=s.measure AND p.tire_condition=s.tire_condition AND p.vehicle_type IS NOT DISTINCT FROM s.vehicle_type
      WHERE COALESCE(p.min_quantity,s.minimum)>0
        AND COALESCE(s.available,0)<COALESCE(p.min_quantity,s.minimum)) low_stock,
    (SELECT count(*)::int FROM core.conversations c WHERE c.environment=$1
      AND c.deleted_at IS NULL AND c.current_status<>'resolved'
      AND c.last_activity_at>now()-interval '24 hours') active_conversations`,[environment]);
  return result.rows[0] as {human:number;pickups:number;deliveries:number;low_stock:number;active_conversations:number};
}

export async function readOverviewLeads(db: Pool, environment: 'prod'|'test') {
  const result=await db.query(`SELECT c.id,c.contact_id,c.chatwoot_conversation_id,ct.name,c.channel_type,
      extract(epoch FROM (now()-m.sent_at))/3600 hours,
      COALESCE((SELECT cf.fact_value #>> '{}' FROM analytics.conversation_facts cf
        WHERE cf.environment=c.environment AND cf.conversation_id=c.id AND cf.superseded_by IS NULL
          AND cf.fact_key IN ('medida_consultada','medida_pneu','moto_modelo_consultado')
        ORDER BY COALESCE(cf.observed_at,cf.created_at) DESC,cf.id DESC LIMIT 1),'Interesse não informado') interest
    FROM core.conversations c JOIN core.contacts ct ON ct.id=c.contact_id AND ct.environment=c.environment
    JOIN LATERAL (SELECT sender_type,sent_at FROM core.messages
      WHERE environment=c.environment AND conversation_id=c.id AND NOT is_private AND deleted_at IS NULL
      ORDER BY sent_at DESC,id DESC LIMIT 1) m ON true
    WHERE c.environment=$1 AND c.deleted_at IS NULL AND ct.deleted_at IS NULL
      AND c.current_status<>'resolved' AND m.sender_type IN ('user','agent_bot')
      AND m.sent_at BETWEEN now()-interval '7 days' AND now()-interval '1 hour'
      AND EXISTS (SELECT 1 FROM analytics.conversation_facts cf WHERE cf.environment=c.environment
        AND cf.conversation_id=c.id AND cf.fact_key='preco_cotado' AND cf.superseded_by IS NULL)
      AND NOT EXISTS (SELECT 1 FROM commerce.orders o WHERE o.environment=c.environment AND o.source_conversation_id=c.id)
      AND NOT EXISTS (SELECT 1 FROM ops.customer_lead_board_state b WHERE b.environment=c.environment
        AND b.conversation_id=c.id AND (b.archived_at IS NOT NULL OR b.manual_lane='perdido'))
    ORDER BY m.sent_at DESC,c.id LIMIT 5`,[environment]);
  const [locations,interests]=await Promise.all([
    loadCustomerLeadLocations(environment,result.rows.map(row=>row.contact_id),db),
    loadCustomerLeadInterests(environment,result.rows.map(row=>row.id),db),
  ]);
  return result.rows.map(({contact_id,...row})=>({...row,
    interest:interests.get(row.id)?.map(item=>item.measure).join(' · ')||row.interest,
    location:locations.get(contact_id)?.label??null}));
}
