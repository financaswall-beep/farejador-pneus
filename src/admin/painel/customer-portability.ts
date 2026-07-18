import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { getClientePainelV2ById } from './queries-clientes-v2.js';

export interface PortabilityPackage {
  generated_at: string;
  identity_id: string;
  profile_sources: Array<Record<string, unknown>>;
  conversations: Array<Record<string, unknown>>;
  attachments: Array<Record<string, unknown>>;
  satisfaction: Array<Record<string, unknown>>;
  transactions: Array<Record<string, unknown>>;
  purposes: string[];
  excluded: string[];
}

const scopeCte = `WITH links AS (
  SELECT * FROM commerce.customer_identity_links WHERE environment=$1 AND identity_id=$2 AND ended_at IS NULL
), core_conversations AS (
  SELECT DISTINCT cv.id FROM links l JOIN core.conversations cv
    ON l.source_type='chatwoot_contact' AND cv.environment=l.environment AND cv.contact_id=l.source_id
   WHERE cv.deleted_at IS NULL
), partner_orders AS (
  SELECT DISTINCT po.id FROM links l JOIN commerce.partner_orders po
    ON l.source_type='partner_customer' AND po.environment=l.environment AND po.customer_id=l.source_id
), partner_conversations AS (
  SELECT DISTINCT pc.id FROM links l JOIN commerce.partner_customers customer
    ON l.source_type='partner_customer' AND customer.environment=l.environment AND customer.id=l.source_id
  JOIN commerce.partner_conversations pc ON pc.environment=customer.environment AND pc.unit_id=customer.unit_id
    AND customer.phone IS NOT NULL AND pc.customer_identifier=customer.phone
)`;

export async function buildPortabilityPackage(
  environment: 'prod' | 'test', identityId: string, dbPool: Pool = defaultPool,
): Promise<PortabilityPackage> {
  const profile = await getClientePainelV2ById(identityId,environment,dbPool);
  if (!profile) throw new Error('identity_not_found');
  const [messages,partnerMessages,attachments,satisfaction,transactions] = await Promise.all([
    dbPool.query<Record<string,unknown>>(`${scopeCte}
      SELECT m.chatwoot_message_id,m.sender_type,m.content,m.content_type,m.status,m.sent_at::text
        FROM core.messages m JOIN core_conversations c ON c.id=m.conversation_id
       WHERE m.environment=$1 AND m.deleted_at IS NULL AND m.is_private=false ORDER BY m.sent_at,m.id`,[environment,identityId]),
    dbPool.query<Record<string,unknown>>(`${scopeCte}
      SELECT m.chatwoot_message_id,m.direction,m.sender,m.content,m.attachments,m.created_at::text
        FROM commerce.partner_messages m JOIN partner_conversations c ON c.id=m.conversation_id
       WHERE m.environment=$1 ORDER BY m.created_at,m.id`,[environment,identityId]),
    dbPool.query<Record<string,unknown>>(`${scopeCte}
      SELECT a.chatwoot_attachment_id,a.file_type,a.mime_type,a.file_size_bytes,a.duration_ms,
             a.width,a.height,a.data_url,a.thumb_url,a.coordinates_lat,a.coordinates_lng,a.created_at::text
        FROM core.message_attachments a JOIN core_conversations c ON c.id=a.conversation_id
       WHERE a.environment=$1 ORDER BY a.created_at,a.id`,[environment,identityId]),
    dbPool.query<Record<string,unknown>>(`${scopeCte}
      SELECT s.status,s.rating,s.comment,s.asked_at::text,s.answered_at::text,s.created_at::text
        FROM commerce.satisfaction_surveys s JOIN partner_orders o ON o.id=s.partner_order_id
       WHERE s.environment=$1 ORDER BY s.created_at,s.id`,[environment,identityId]),
    dbPool.query<Record<string,unknown>>(`${scopeCte}, transactions AS (
      SELECT 'retail' source,o.id,o.total_amount,o.status,o.created_at occurred_at
        FROM links l JOIN commerce.orders o ON o.environment=l.environment AND
          ((l.source_type='chatwoot_contact' AND o.contact_id=l.source_id)
           OR (l.source_type='walkin_customer' AND o.customer_id=l.source_id))
      UNION
      SELECT 'partner',po.id,po.total_amount,po.status,
        CASE WHEN po.fulfillment_mode='delivery' THEN po.delivered_at ELSE COALESCE(po.retrieved_at,po.created_at) END
        FROM commerce.partner_orders po JOIN partner_orders p ON p.id=po.id
      UNION
      SELECT 'wholesale',wo.id,wo.total_amount,wo.status,wo.sold_at
        FROM links l JOIN commerce.wholesale_orders wo ON l.source_type='wholesale_customer'
          AND wo.environment=l.environment AND wo.buyer_id=l.source_id)
      SELECT source,id::text,total_amount::text,status,occurred_at::text FROM transactions ORDER BY occurred_at,id`,[environment,identityId]),
  ]);
  return {
    generated_at:new Date().toISOString(),identity_id:identityId,
    profile_sources:profile.sources.map((source) => ({ source_type:source.source_type,name:source.name,
      phone:source.phone,email:source.email,document_number:source.document_number,updated_at:source.updated_at })),
    conversations:[...messages.rows,...partnerMessages.rows],attachments:attachments.rows,
    satisfaction:satisfaction.rows,transactions:transactions.rows,
    purposes:['customer_service','order_fulfillment','commercial_history','service_quality'],
    excluded:['passwords_and_tokens','private_internal_notes','costs_and_internal_margin','third_party_personal_data','raw_webhook_secrets'],
  };
}
