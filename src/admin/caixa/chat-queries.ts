import type { Pool } from 'pg';
import { pool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { loadCustomerLeadLocations } from '../painel/customer-lead-location.js';
import { loadCustomerLeadInterests } from '../painel/customer-lead-interests.js';

export async function requireChatConversation(id: string, db: Pool = pool) {
  const row = (await db.query(`SELECT c.id,c.contact_id,c.chatwoot_conversation_id,c.channel_type,
    c.current_status,ct.name,ct.phone_e164,ct.email,COALESCE(b.mode,'auto') AS mode,COALESCE(b.version,0) AS version
    FROM core.conversations c LEFT JOIN core.contacts ct ON ct.environment=c.environment AND ct.id=c.contact_id AND ct.deleted_at IS NULL
    LEFT JOIN ops.conversation_bot_control b ON b.environment=c.environment AND b.conversation_id=c.id
    WHERE c.environment=$1 AND c.id=$2 AND c.deleted_at IS NULL AND c.chatwoot_account_id=$3`,
  [env.FAREJADOR_ENV,id,env.CHATWOOT_ACCOUNT_ID])).rows[0];
  if (!row) throw Error('bot_conversation_not_found');
  return row;
}

const baseSql = `SELECT c.id,c.contact_id,c.channel_type,c.current_status,ct.name,
  COALESCE(b.mode,'auto') AS mode,COALESCE(b.version,0) AS version,
  last_msg.content AS last_message,last_msg.sender_type,last_msg.sent_at,
  incoming.sent_at AS last_customer_at,
  (incoming.sent_at IS NOT NULL AND (outgoing.sent_at IS NULL OR incoming.sent_at>outgoing.sent_at)) AS waiting,
  photo.id AS photo_request_id,photo.status AS photo_status,photo.tire_size AS photo_measure,
  EXISTS(SELECT 1 FROM ops.outbound_messages o WHERE o.environment=c.environment AND o.conversation_id=c.id
    AND o.status='dead_letter' AND o.created_at>COALESCE(outgoing.sent_at,c.started_at)) AS send_failed
  FROM core.conversations c
  LEFT JOIN core.contacts ct ON ct.environment=c.environment AND ct.id=c.contact_id AND ct.deleted_at IS NULL
  LEFT JOIN ops.conversation_bot_control b ON b.environment=c.environment AND b.conversation_id=c.id
  LEFT JOIN LATERAL(SELECT content,sender_type,sent_at FROM core.messages m WHERE m.environment=c.environment
    AND m.conversation_id=c.id AND m.deleted_at IS NULL AND NOT m.is_private AND m.message_type IN(0,1)
    ORDER BY sent_at DESC,chatwoot_message_id DESC LIMIT 1) last_msg ON true
  LEFT JOIN LATERAL(SELECT max(sent_at) AS sent_at FROM core.messages m WHERE m.environment=c.environment
    AND m.conversation_id=c.id AND m.sender_type='contact' AND m.deleted_at IS NULL AND NOT m.is_private) incoming ON true
  LEFT JOIN LATERAL(SELECT max(sent_at) AS sent_at FROM (
    SELECT sent_at FROM core.messages m WHERE m.environment=c.environment AND m.conversation_id=c.id
      AND m.message_type=1 AND m.deleted_at IS NULL AND NOT m.is_private
    UNION ALL SELECT created_at FROM ops.outbound_messages o WHERE o.environment=c.environment AND o.conversation_id=c.id
      AND o.status IN('pending','sending','sent_api_ack','delivered') AND o.kind IN('operator_text','operator_attachment')
  ) sent) outgoing ON true
  LEFT JOIN LATERAL(SELECT p.id,p.status,p.tire_size FROM commerce.photo_requests p JOIN core.units u
    ON u.id=p.unit_id AND u.environment=p.environment AND u.slug='main'
    WHERE p.environment=c.environment AND p.conversation_id=c.chatwoot_conversation_id AND
    ((p.status='pending' AND p.expires_at>now()) OR p.status='answered') ORDER BY p.created_at LIMIT 1) photo ON true
  WHERE c.environment=$1 AND c.chatwoot_account_id=$2 AND c.deleted_at IS NULL`;

export async function listOperationConversations(input: {
  search: string; filter: 'all'|'needs'|'bot'; channel: string; offset: number; closed: boolean;
}, db: Pool = pool) {
  const result = await db.query(`WITH conversations AS (${baseSql}), filtered AS (
    SELECT * FROM conversations c WHERE ($3 OR current_status<>'resolved')
    AND ($4='' OR COALESCE(name,'') ILIKE '%'||$4||'%' OR COALESCE(last_message,'') ILIKE '%'||$4||'%'
      OR EXISTS(SELECT 1 FROM ops.bot_stock_searches s WHERE s.environment=$1 AND s.conversation_id=c.id
        AND s.measure ILIKE '%'||$4||'%')) AND ($5='' OR channel_type=$5)
  ), selected AS (SELECT * FROM filtered WHERE ($6='all' OR ($6='bot' AND mode='auto') OR
      ($6='needs' AND (waiting OR mode='human' OR photo_request_id IS NOT NULL OR send_failed)))
    ORDER BY (waiting OR photo_request_id IS NOT NULL) DESC,
      CASE WHEN waiting THEN last_customer_at END ASC,sent_at DESC NULLS LAST,id
    LIMIT 31 OFFSET $7) SELECT COALESCE((SELECT jsonb_agg(selected) FROM selected),'[]'::jsonb) AS entries,
    (SELECT count(*)::int FROM filtered) AS filtered_total,
    (SELECT count(*)::int FROM filtered WHERE waiting OR mode='human' OR photo_request_id IS NOT NULL OR send_failed) AS needs_total`,
    [env.FAREJADOR_ENV,env.CHATWOOT_ACCOUNT_ID,input.closed,input.search,input.channel,input.filter,input.offset]);
  const entries=result.rows[0].entries as Array<Record<string,any>>;
  const more = entries.length>30, rows = entries.slice(0,30);
  const [locations, interests] = await Promise.all([
    loadCustomerLeadLocations(env.FAREJADOR_ENV,rows.map(r=>r.contact_id),db),
    loadCustomerLeadInterests(env.FAREJADOR_ENV,rows.map(r=>r.id),db),
  ]);
  return { rows:rows.map(row=>({...row,location:locations.get(row.contact_id) ?? null,interests:interests.get(row.id) ?? []})),
    has_more:more, total:result.rows[0]?.filtered_total ?? 0, needs_total:result.rows[0]?.needs_total ?? 0 };
}

export async function getOperationConversation(id: string, db: Pool = pool) {
  const conversation = await requireChatConversation(id,db);
  const [locations,interests,photos,orders] = await Promise.all([
    loadCustomerLeadLocations(env.FAREJADOR_ENV,[conversation.contact_id],db),
    loadCustomerLeadInterests(env.FAREJADOR_ENV,[id],db),
    db.query(`SELECT p.id,p.tire_size,p.status,p.created_at,p.sent_to_customer_at,
      EXISTS(SELECT 1 FROM commerce.photo_request_blobs b WHERE b.environment=p.environment AND b.photo_request_id=p.id) AS has_photo
      FROM commerce.photo_requests p JOIN core.units u ON u.environment=p.environment AND u.id=p.unit_id AND u.slug='main'
      WHERE p.environment=$1 AND p.conversation_id=$2 AND (p.status='answered' OR
      (p.status='pending' AND p.expires_at>now()) OR p.sent_to_customer_at>now()-interval '1 day') ORDER BY p.created_at DESC`,[env.FAREJADOR_ENV,conversation.chatwoot_conversation_id]),
    db.query(`SELECT id,status,total_amount,created_at FROM commerce.orders
      WHERE environment=$1 AND source_conversation_id=$2 ORDER BY created_at DESC LIMIT 10`,[env.FAREJADOR_ENV,id]),
  ]);
  return {...conversation,location:locations.get(conversation.contact_id) ?? null,
    interests:interests.get(id) ?? [],photos:photos.rows,orders:orders.rows};
}

/** Cursor composto: traz as mensagens recentes; o histórico antigo é paginado. */
export async function getOperationMessages(id: string, before?: { at: string; id: string }, db: Pool = pool) {
  await requireChatConversation(id,db);
  const result = await db.query(`SELECT m.id,m.content,m.sent_at,m.status,m.sender_type,m.message_type,
    o.kind AS outbound_kind,op.client_token,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('id',a.id,'type',a.file_type,'url',a.data_url,
      'mime',a.mime_type,'latitude',a.coordinates_lat,'longitude',a.coordinates_lng)) FROM core.message_attachments a
      WHERE a.environment=m.environment AND a.message_id=m.id),'[]'::jsonb) AS attachments
    FROM core.messages m LEFT JOIN LATERAL(SELECT o.id,o.kind FROM ops.outbound_messages o
      WHERE o.environment=m.environment AND o.conversation_id=m.conversation_id AND
      (o.provider_message_id=m.chatwoot_message_id OR o.echo_id=m.echo_id OR o.echo_id=m.content_attributes->>'farejador_echo_id')
      ORDER BY o.created_at DESC LIMIT 1) o ON true
    LEFT JOIN ops.operator_messages op ON op.environment=m.environment AND op.outbound_id=o.id
    WHERE m.environment=$1 AND m.conversation_id=$2 AND NOT m.is_private AND m.deleted_at IS NULL
      AND ($3::timestamptz IS NULL OR (m.sent_at,m.id)<($3::timestamptz,$4::uuid))
    ORDER BY m.sent_at DESC,m.id DESC LIMIT 61`,[env.FAREJADOR_ENV,id,before?.at ?? null,before?.id ?? null]);
  const rows=result.rows.slice(0,60), oldest=rows.at(-1);
  const pending=before ? {rows:[]} : await db.query(`SELECT o.id,o.body AS content,o.created_at AS sent_at,
    o.status,o.last_error_kind,o.kind AS outbound_kind,op.client_token,op.filename,op.mime,op.bytes IS NOT NULL AS has_file
    FROM ops.operator_messages op JOIN ops.outbound_messages o ON o.environment=op.environment AND o.id=op.outbound_id
    WHERE op.environment=$1 AND op.conversation_id=$2 AND NOT EXISTS(SELECT 1 FROM core.messages m
      WHERE m.environment=o.environment AND m.conversation_id=o.conversation_id AND m.deleted_at IS NULL
      AND (m.chatwoot_message_id=o.provider_message_id OR m.echo_id=o.echo_id OR m.content_attributes->>'farejador_echo_id'=o.echo_id))
    ORDER BY o.created_at DESC LIMIT 100`,[env.FAREJADOR_ENV,id]);
  return {messages:rows.reverse(),outgoing:pending.rows.reverse(),
    next:result.rows.length>60 && oldest ? {at:oldest.sent_at,id:oldest.id} : null};
}
