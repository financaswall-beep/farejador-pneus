import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';

export interface PrivacyInventoryItem {
  surface: string;
  count: number;
  disposition: 'included' | 'retained' | 'pending';
  reason: string;
}

interface CountRow {
  source_records: string; core_conversations: string; core_messages: string; attachments: string;
  raw_events: string; agent_turns: string; outbound_messages: string; analytics_facts: string;
  atendente_jobs: string; atendente_dead_letters: string;
  analytics_evidence: string; linguistic_hints: string; partner_conversations: string;
  partner_messages: string; satisfaction_surveys: string; retail_orders: string;
  partner_orders: string; wholesale_orders: string; audit_events: string;
  audit_payload_review: string;
}

const inventorySql = `WITH links AS (
  SELECT * FROM commerce.customer_identity_links
   WHERE environment=$1 AND identity_id=$2 AND ended_at IS NULL
), core_conversations AS (
  SELECT DISTINCT cv.id,cv.chatwoot_conversation_id FROM links l
  JOIN core.conversations cv ON l.source_type='chatwoot_contact' AND cv.environment=l.environment
    AND cv.contact_id=l.source_id AND cv.deleted_at IS NULL
), partner_orders AS (
  SELECT DISTINCT po.id FROM links l JOIN commerce.partner_orders po
    ON l.source_type='partner_customer' AND po.environment=l.environment AND po.customer_id=l.source_id
), partner_conversations AS (
  SELECT DISTINCT pc.id,pc.chatwoot_conversation_id FROM links l
  JOIN commerce.partner_customers customer ON l.source_type='partner_customer'
    AND customer.environment=l.environment AND customer.id=l.source_id
  JOIN commerce.partner_conversations pc ON pc.environment=customer.environment AND pc.unit_id=customer.unit_id
    AND customer.phone IS NOT NULL AND pc.customer_identifier=customer.phone
), retail_orders AS (
  SELECT DISTINCT o.id FROM links l JOIN commerce.orders o ON o.environment=l.environment
    AND ((l.source_type='chatwoot_contact' AND o.contact_id=l.source_id)
      OR (l.source_type='walkin_customer' AND o.customer_id=l.source_id))
), wholesale_orders AS (
  SELECT DISTINCT wo.id FROM links l JOIN commerce.wholesale_orders wo
    ON l.source_type='wholesale_customer' AND wo.environment=l.environment AND wo.buyer_id=l.source_id
), all_core_conversations AS (
  SELECT id,chatwoot_conversation_id FROM core_conversations
  UNION SELECT cv.id,cv.chatwoot_conversation_id FROM core.conversations cv
   JOIN partner_conversations pc ON pc.chatwoot_conversation_id=cv.chatwoot_conversation_id AND cv.environment=$1
), source_ids AS (SELECT source_id FROM links), order_ids AS (
  SELECT id FROM retail_orders UNION SELECT id FROM partner_orders UNION SELECT id FROM wholesale_orders
)
SELECT
 (SELECT count(*) FROM links)::text source_records,
 (SELECT count(*) FROM all_core_conversations)::text core_conversations,
 (SELECT count(*) FROM core.messages m JOIN all_core_conversations c ON c.id=m.conversation_id WHERE m.environment=$1 AND m.deleted_at IS NULL)::text core_messages,
 (SELECT count(*) FROM core.message_attachments a JOIN all_core_conversations c ON c.id=a.conversation_id WHERE a.environment=$1)::text attachments,
 (SELECT count(*) FROM raw.raw_events r WHERE r.environment=$1 AND EXISTS (
    SELECT 1 FROM all_core_conversations c WHERE
      r.payload#>>'{conversation,id}'=c.chatwoot_conversation_id::text OR
      r.payload#>>'{conversation_id}'=c.chatwoot_conversation_id::text OR
      r.payload#>>'{message,conversation_id}'=c.chatwoot_conversation_id::text))::text raw_events,
 (SELECT count(*) FROM agent.turns t JOIN all_core_conversations c ON c.id=t.conversation_id WHERE t.environment=$1)::text agent_turns,
 (SELECT count(*) FROM ops.outbound_messages o JOIN all_core_conversations c ON c.id=o.conversation_id WHERE o.environment=$1)::text outbound_messages,
 (SELECT count(*) FROM ops.atendente_jobs j JOIN all_core_conversations c ON c.id=j.conversation_id WHERE j.environment=$1)::text atendente_jobs,
 (SELECT count(*) FROM ops.atendente_dead_letters d JOIN all_core_conversations c ON c.id=d.conversation_id WHERE d.environment=$1)::text atendente_dead_letters,
 (SELECT count(*) FROM analytics.conversation_facts f JOIN all_core_conversations c ON c.id=f.conversation_id WHERE f.environment=$1)::text analytics_facts,
 (SELECT count(*) FROM analytics.fact_evidence e JOIN analytics.conversation_facts f ON f.id=e.fact_id
    JOIN all_core_conversations c ON c.id=f.conversation_id WHERE e.environment=$1)::text analytics_evidence,
 (SELECT count(*) FROM analytics.linguistic_hints h JOIN all_core_conversations c ON c.id=h.conversation_id WHERE h.environment=$1)::text linguistic_hints,
 (SELECT count(*) FROM partner_conversations)::text partner_conversations,
 (SELECT count(*) FROM commerce.partner_messages m JOIN partner_conversations c ON c.id=m.conversation_id WHERE m.environment=$1)::text partner_messages,
 (SELECT count(*) FROM commerce.satisfaction_surveys s JOIN partner_orders o ON o.id=s.partner_order_id WHERE s.environment=$1)::text satisfaction_surveys,
 (SELECT count(*) FROM retail_orders)::text retail_orders,
 (SELECT count(*) FROM partner_orders)::text partner_orders,
 (SELECT count(*) FROM wholesale_orders)::text wholesale_orders,
 (SELECT count(*) FROM audit.events a WHERE a.environment=$1 AND
    (a.entity_id IN (SELECT source_id FROM source_ids) OR a.entity_id IN (SELECT id FROM order_ids)))::text audit_events,
 (SELECT count(*) FROM audit.events a WHERE a.environment=$1
    AND (a.payload_before IS NOT NULL OR a.payload_after IS NOT NULL))::text audit_payload_review`;

function item(surface: string, count: string, disposition: PrivacyInventoryItem['disposition'], reason: string): PrivacyInventoryItem {
  return { surface,count:Number(count),disposition,reason };
}

export async function inventoryCustomerPrivacy(
  environment: 'prod' | 'test', identityId: string, requestType: 'portability' | 'anonymization',
  dbPool: Pool = defaultPool,
): Promise<{ identity_id: string; mode: 'dry_run'; items: PrivacyInventoryItem[]; has_pending: boolean }> {
  const found = await dbPool.query<CountRow>(inventorySql,[environment,identityId]);
  const row = found.rows[0];
  if (!row) throw new Error('identity_not_found');
  const anonymization = requestType === 'anonymization';
  const items = [
    item('source_records',row.source_records,anonymization?'pending':'included',
      anonymization?'anonymization_execution_disabled':'customer-provided profile data'),
    item('core_conversations',row.core_conversations,anonymization?'pending':'included','conversation scope'),
    item('core_messages',row.core_messages,anonymization?'pending':'included','free text requires field-aware handling'),
    item('core_message_attachments',row.attachments,'pending','attachments and location require explicit external/storage handling'),
    item('raw.raw_events',row.raw_events,anonymization?'pending':'retained','immutable source subject to retention/legal-hold policy'),
    item('agent.turns',row.agent_turns,anonymization?'pending':'retained','bot say_text/actions/blocked payload are internal records'),
    item('ops.outbound_messages',row.outbound_messages,anonymization?'pending':'retained','delivery/retry record contains sent body'),
    item('ops.atendente_jobs',row.atendente_jobs,anonymization?'pending':'retained','job lifecycle is operational evidence'),
    item('ops.atendente_dead_letters',row.atendente_dead_letters,anonymization?'pending':'retained','failure record may require manual review'),
    item('analytics.conversation_facts',row.analytics_facts,anonymization?'pending':'included','structured and free-form derived facts'),
    item('analytics.fact_evidence',row.analytics_evidence,anonymization?'pending':'included','literal evidence can contain personal data'),
    item('analytics.linguistic_hints',row.linguistic_hints,anonymization?'pending':'retained','internal derived evidence'),
    item('commerce.partner_conversations',row.partner_conversations,anonymization?'pending':'included','partner fanout customer fields'),
    item('commerce.partner_messages',row.partner_messages,anonymization?'pending':'included','partner fanout content and attachments'),
    item('commerce.satisfaction_surveys',row.satisfaction_surveys,anonymization?'pending':'included','rating retained; comment and identifiers need policy'),
    item('financial_facts.retail_orders',row.retail_orders,'retained','economic facts, dates and values are preserved'),
    item('financial_facts.partner_orders',row.partner_orders,'retained','economic facts, dates and values are preserved'),
    item('financial_facts.wholesale_orders',row.wholesale_orders,'retained','economic facts, dates and values are preserved'),
    item('audit.events',row.audit_events,'retained','audit trail is preserved with identity reference'),
    item('audit.unscoped_payload_review',row.audit_payload_review,'pending','free-form audit payloads can contain residual PII without a source key'),
    item('external.chatwoot',row.core_conversations,'pending','external copy requires a separate authenticated operation'),
  ];
  return { identity_id:identityId,mode:'dry_run',items,has_pending:items.some((entry) => entry.count>0 && entry.disposition==='pending') };
}
