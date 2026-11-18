import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { Environment } from '../shared/types/chatwoot.js';

type Db = Pick<Pool, 'query'>;
export type OrientacaoMilly = 'oferecer_retirada'|'pedir_proposta'|'seguir_tabela';
export interface PedidoConsultaMilly {
  environment: Environment;
  conversationId: string;
  triggerMessageId: string;
  unitId: string;
  productId: string;
  quantity: number;
  paymentMethod: 'pix' | 'cartao' | 'dinheiro';
  fulfillmentMode: 'pickup' | 'delivery';
  offeredTotalCents: number;
  catalogUnitCents: number;
  freightCents: number;
  destinationKey: string | null;
}
export interface ConsultaMilly extends PedidoConsultaMilly {
  id: string;
  status: 'pending' | 'declined' | 'cancelled' | 'approved';
  approvedTotalCents?: number;
  validUntil?: string;
  createdAt: string;
  decisao?: ParecerMilly['decisao'];
  orientacao?: OrientacaoMilly;
}
export interface OfertaMilly extends ConsultaMilly {
  approvedTotalCents: number;
  validUntil: string;
  publishedAt: string;
  publishedProviderId: string | null;
}
interface Row extends PedidoConsultaMilly {
  id: string;
  status: ConsultaMilly['status'];
  approvedTotalCents: number | null;
  validUntil: Date | null;
  publishedAt: Date | null;
  publishedProviderId: string | null;
  createdAt: Date;
  decision: ParecerMilly['decisao'] | null;
  orientation: OrientacaoMilly | null;
}
const columns = `r.id,r.environment,r.conversation_id AS "conversationId",r.trigger_message_id AS "triggerMessageId",
  r.unit_id AS "unitId",r.product_id AS "productId",r.quantity,r.payment_method AS "paymentMethod",
  r.fulfillment_mode AS "fulfillmentMode",r.offered_total_cents AS "offeredTotalCents",
  r.catalog_unit_cents AS "catalogUnitCents",r.freight_cents AS "freightCents",r.destination_key AS "destinationKey",
  r.approved_total_cents AS "approvedTotalCents",r.valid_until AS "validUntil",r.created_at AS "createdAt",
  r.published_at AS "publishedAt",r.published_provider_id::text AS "publishedProviderId",r.decision,r.orientation`;
const currentGate = 'g.enabled AND g.generation=r.generation';
const statusSql = `CASE
  WHEN r.state IN ('declined','pending','approved','sending') AND NOT COALESCE(${currentGate},false) THEN 'cancelled'
  WHEN r.state='pending' AND r.request_deadline<=clock_timestamp() THEN 'cancelled'
  WHEN r.state IN ('approved','sending','published') AND r.valid_until<=clock_timestamp() THEN 'cancelled'
  WHEN r.state IN ('sending','published') THEN 'approved'
  WHEN r.state='consumed' THEN 'cancelled'
  ELSE r.state END`;
const gateJoin = 'LEFT JOIN ops.milly_consulta_config g ON g.environment=r.environment';
function consulta(row: Row): ConsultaMilly {
  const { validUntil, createdAt, approvedTotalCents, publishedAt: _publishedAt, publishedProviderId: _providerId, decision,orientation,...fields } = row;
  return {
    ...fields, createdAt: new Date(createdAt).toISOString(),
    ...(decision && fields.status!=='cancelled' ? {decisao:decision} : {}),
    ...(orientation && fields.status==='declined' ? {orientacao:orientation} : {}),
    ...(fields.status === 'approved' && approvedTotalCents != null && validUntil
      ? { approvedTotalCents,validUntil:new Date(validUntil).toISOString() } : {}),
  };
}

export async function lerConsultaMilly(db: Db, environment: Environment): Promise<boolean> {
  if (!await esquemaDisponivel(db)) return false;
  const result = await db.query('SELECT enabled FROM ops.milly_consulta_config WHERE environment=$1',[environment]);
  return result.rows[0]?.enabled === true;
}

// Em instalações anteriores à migration, uma tabela ausente não pode abortar a transação de venda.
async function esquemaDisponivel(db: Db) {
  const result = await db.query("SELECT to_regclass('ops.milly_consultas') IS NOT NULL AS pronta");
  return result.rows[0]?.pronta === true;
}

export async function definirConsultaMilly(db: Db, environment: Environment, ativa: boolean, personId: string): Promise<boolean> {
  const result = await db.query(`INSERT INTO ops.milly_consulta_config AS config (environment,enabled,owner_person_id)
    SELECT mc.environment,$2,mc.person_id FROM network.matriz_collaborators mc
    JOIN network.partner_people p ON p.id=mc.person_id AND p.environment=mc.environment AND p.revoked_at IS NULL
    WHERE mc.environment=$1 AND mc.person_id=$3 AND mc.panel_role='owner' AND mc.revoked_at IS NULL LIMIT 1
    ON CONFLICT (environment) DO UPDATE SET
      enabled=EXCLUDED.enabled,
      generation=CASE WHEN config.enabled<>EXCLUDED.enabled THEN gen_random_uuid() ELSE config.generation END,
      owner_person_id=CASE WHEN config.enabled AND EXCLUDED.enabled THEN config.owner_person_id ELSE EXCLUDED.owner_person_id END,
      updated_at=CASE WHEN config.enabled<>EXCLUDED.enabled THEN now() ELSE config.updated_at END
    RETURNING enabled`,[environment,ativa,personId]);
  if (!result.rows[0]) throw new Error('Somente o proprietário da Matriz pode controlar a negociação.');
  return result.rows[0].enabled;
}

export async function solicitarConsultaMilly(db: Db, input: PedidoConsultaMilly): Promise<{id:string;criada:boolean}|null> {
  const {environment,conversationId,triggerMessageId,unitId,productId,quantity,paymentMethod,fulfillmentMode,
    offeredTotalCents,catalogUnitCents,freightCents,destinationKey} = input;
  const parameters = [environment,conversationId,triggerMessageId,unitId,productId,quantity,paymentMethod,
    fulfillmentMode,offeredTotalCents,catalogUnitCents,freightCents,destinationKey];
  // A message can start only one decision. A retry may retrieve it, never change its terms.
  const result = await db.query<{id:string}>(`WITH gate AS (
    SELECT generation FROM ops.milly_consulta_config WHERE environment=$1 AND enabled FOR SHARE
  ) INSERT INTO ops.milly_consultas
    (environment,generation,conversation_id,trigger_message_id,unit_id,product_id,quantity,payment_method,
     fulfillment_mode,offered_total_cents,catalog_unit_cents,freight_cents,destination_key)
    SELECT $1,gate.generation,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12 FROM gate
    JOIN core.units u ON u.environment=$1 AND u.id=$4 AND u.slug='main'
    JOIN commerce.products p ON p.environment=$1 AND p.id=$5 AND p.product_type='tire' AND NOT p.partner_generic AND p.deleted_at IS NULL
    JOIN core.conversations c ON c.environment=$1 AND c.id=$2 AND c.deleted_at IS NULL
    JOIN core.contacts ct ON ct.environment=c.environment AND ct.id=c.contact_id AND ct.deleted_at IS NULL
    WHERE EXISTS (SELECT FROM core.messages m WHERE m.environment=c.environment AND m.conversation_id=c.id
      AND m.id=$3 AND m.sender_type='contact' AND m.message_type=0 AND NOT m.is_private AND m.deleted_at IS NULL)
    AND NOT EXISTS (SELECT 1 FROM ops.milly_consultas prior
      WHERE prior.environment=$1 AND prior.conversation_id=$2 AND prior.generation=gate.generation
      AND prior.unit_id=$4 AND prior.product_id=$5 AND prior.quantity=$6 AND prior.payment_method=$7
      AND prior.fulfillment_mode=$8 AND prior.offered_total_cents=$9 AND prior.catalog_unit_cents=$10
      AND prior.freight_cents=$11 AND prior.destination_key IS NOT DISTINCT FROM $12
      AND prior.state='declined' AND prior.decision='manter' AND prior.created_at>clock_timestamp()-interval '2 minutes')
    FOR SHARE OF ct
    ON CONFLICT (environment,conversation_id,trigger_message_id) DO NOTHING RETURNING id`, parameters);
  if (result.rows[0]) return {id:result.rows[0].id,criada:true};
  const previous = await db.query<{id:string}>(`SELECT r.id FROM ops.milly_consultas r
    JOIN ops.milly_consulta_config g ON g.environment=r.environment AND ${currentGate}
    WHERE r.environment=$1 AND r.conversation_id=$2 AND r.trigger_message_id=$3 AND r.unit_id=$4
    AND r.product_id=$5 AND r.quantity=$6 AND r.payment_method=$7 AND r.fulfillment_mode=$8
    AND r.offered_total_cents=$9 AND r.catalog_unit_cents=$10 AND r.freight_cents=$11
    AND r.destination_key IS NOT DISTINCT FROM $12 AND r.state='pending' AND r.request_deadline>clock_timestamp()`, parameters);
  return previous.rows[0] ? { id:previous.rows[0].id, criada:false } : null;
}

export async function consultaDoTurnoMilly(db: Db, environment: Environment, conversationId: string, triggerMessageId: string) {
  if (!await esquemaDisponivel(db)) return null;
  const res = await db.query<Row>(`SELECT ${columns},${statusSql} AS status FROM ops.milly_consultas r ${gateJoin}
    WHERE r.environment=$1 AND r.conversation_id=$2 AND r.trigger_message_id=$3`,[environment,conversationId,triggerMessageId]);
  return res.rows[0] ? consulta(res.rows[0]) : null;
}

export async function lerPedidoConsultaMilly(db: Db, environment: Environment, id: string) {
  const res = await db.query<Row>(`SELECT ${columns},r.state AS status FROM ops.milly_consultas r ${gateJoin}
    WHERE r.environment=$1 AND r.id=$2 AND r.state='pending' AND ${currentGate}
      AND r.request_deadline>clock_timestamp()`,[environment,id]);
  return res.rows[0] ? consulta(res.rows[0]) : null;
}

export async function lerResultadoConsultaMilly(db: Db, environment: Environment, id: string) {
  const res = await db.query<Row>(`SELECT ${columns},${statusSql} AS status FROM ops.milly_consultas r ${gateJoin}
    WHERE r.environment=$1 AND r.id=$2`,[environment,id]);
  return res.rows[0] ? consulta(res.rows[0]) : {status:'cancelled' as const};
}

export interface ParecerMilly {
  decisao: 'aceitar'|'contrapropor'|'manter'|'aguardar_dado';
  totalCentavos?: number;
  orientacao?: OrientacaoMilly;
  justificativa?: string;
  personId: string;
}
export async function registrarParecerMilly(db: Db, environment: Environment, id: string, parecer: ParecerMilly) {
  const aprovar = parecer.decisao==='aceitar' || parecer.decisao==='contrapropor';
  if (aprovar && !Number.isSafeInteger(parecer.totalCentavos)) return false;
  // Uma instalação ainda na 0296 aceita as mesmas decisões, sem persistir justificativa.
  const gravaMotivo = parecer.justificativa !== undefined && (await db.query(`SELECT FROM pg_catalog.pg_attribute
    WHERE attrelid='ops.milly_consultas'::regclass AND attname='decision_rationale' AND NOT attisdropped`)).rowCount === 1;
  const res = await db.query(`WITH gate AS (SELECT generation FROM ops.milly_consulta_config
      WHERE environment=$1 AND enabled AND owner_person_id=$4 FOR SHARE)
    UPDATE ops.milly_consultas r SET state=CASE WHEN $5 THEN 'approved' ELSE 'declined' END,decision=$3,orientation=$7,
      decided_by=$4,approved_total_cents=$6${gravaMotivo ? ',decision_rationale=$8' : ''},
      valid_until=CASE WHEN $5 THEN clock_timestamp()+interval '30 minutes' END
    FROM gate WHERE r.environment=$1 AND r.id=$2 AND r.generation=gate.generation AND r.state='pending'
      AND r.request_deadline>clock_timestamp() AND (NOT $5 OR
       ($6::int>r.freight_cents AND $6<=r.catalog_unit_cents::bigint*r.quantity+r.freight_cents
        AND ($6-r.freight_cents)%r.quantity=0 AND ($3<>'aceitar' OR $6=r.offered_total_cents)
        AND ($3<>'contrapropor' OR $6>=r.offered_total_cents))) RETURNING r.id`,
    [environment,id,parecer.decisao,parecer.personId,aprovar,aprovar?parecer.totalCentavos:null,parecer.orientacao??null,
      ...(gravaMotivo ? [parecer.justificativa] : [])]);
  return res.rowCount===1;
}

export async function cancelarConsultaMilly(db: Db, environment: Environment, id: string) {
  await db.query(`UPDATE ops.milly_consultas SET state='cancelled' WHERE environment=$1 AND id=$2 AND state='pending'`,[environment,id]);
}

export async function reservarEnvioOfertaMilly(db: Db, environment: Environment, id: string, conversationId: string, triggerMessageId: string, body: string) {
  const hash = createHash('sha256').update(body,'utf8').digest('hex');
  const result = await db.query(`WITH gate AS (SELECT generation FROM ops.milly_consulta_config
      WHERE environment=$1 AND enabled FOR SHARE)
    UPDATE ops.milly_consultas r SET state='sending',body_sha256=$5 FROM gate
    WHERE r.environment=$1 AND r.id=$2 AND r.conversation_id=$3 AND r.trigger_message_id=$4
      AND r.generation=gate.generation AND r.valid_until>clock_timestamp()
      AND (r.state='approved' OR (r.state='sending' AND r.body_sha256=$5)) RETURNING r.id`,
    [environment,id,conversationId,triggerMessageId,hash]);
  return result.rowCount===1;
}

// O ACK do provedor ainda é válido quando o dono pausa durante o envio. Somente a saída
// vinculada a esta oferta, com o mesmo corpo autorizado, comprova a publicação.
const evidence = `o.environment=r.environment AND o.conversation_id=r.conversation_id
  AND o.milly_offer_id=r.id AND o.trigger_message_id=r.trigger_message_id AND o.kind='agent_text'
  AND o.body_sha256=r.body_sha256 AND o.status IN ('sent_api_ack','delivered') AND o.provider_message_id IS NOT NULL`;
export async function confirmarEnvioOfertaMilly(db: Db, environment: Environment, id: string, conversationId: string, triggerMessageId: string) {
  const result = await db.query(`UPDATE ops.milly_consultas r SET state='published',published_at=COALESCE(o.sent_at,o.updated_at),published_provider_id=o.provider_message_id
    FROM ops.outbound_messages o WHERE r.environment=$1 AND r.id=$2 AND r.conversation_id=$3 AND r.trigger_message_id=$4
    AND r.state='sending' AND ${evidence} RETURNING r.id`,[environment,id,conversationId,triggerMessageId]);
  return result.rowCount===1;
}

/** Recupera um envio cujo ACK se perdeu após o Chatwoot aceitar a mensagem. */
export async function reconciliarEcoOfertaMilly(db: Db, environment: Environment, conversationId: string, id?: string) {
  const result=await db.query(`UPDATE ops.milly_consultas r SET state='published',published_at=m.sent_at,published_provider_id=m.chatwoot_message_id
    FROM agent.turns t JOIN core.messages m ON m.environment=t.environment AND m.conversation_id=t.conversation_id
      AND m.message_type=1 AND NOT m.is_private AND m.deleted_at IS NULL AND m.sender_type IN ('user','agent_bot')
      AND (m.echo_id='turn:'||t.id::text OR m.content_attributes->>'farejador_echo_id'='turn:'||t.id::text)
    WHERE r.environment=$1 AND r.conversation_id=$2 AND ($3::uuid IS NULL OR r.id=$3)
      AND r.state='sending'
      AND t.environment=r.environment AND t.conversation_id=r.conversation_id AND t.trigger_message_id=r.trigger_message_id
      AND t.agent_version='v2' AND encode(sha256(convert_to(m.content,'UTF8')),'hex')=r.body_sha256
    RETURNING r.id`,[environment,conversationId,id??null]);
  return (result.rowCount??0)>0;
}

/** Uma confirmação de envio recebida tarde comprova o que foi oferecido, inclusive após o vencimento. */
export async function reconciliarPublicacaoMilly(db: Db, environment: Environment, conversationId: string) {
  await reconciliarEcoOfertaMilly(db,environment,conversationId);
  await db.query(`UPDATE ops.milly_consultas r SET state='published',published_at=COALESCE(o.sent_at,o.updated_at),published_provider_id=o.provider_message_id
    FROM ops.outbound_messages o WHERE r.environment=$1 AND r.conversation_id=$2
      AND r.state='sending' AND ${evidence}`,[environment,conversationId]);
}

export async function buscarOfertaCheckoutMilly(db: Db, environment: Environment, conversationId: string, produtos?: string|string[]): Promise<OfertaMilly|null> {
  if (!await esquemaDisponivel(db)) return null;
  const ids = typeof produtos==='string' ? [produtos] : produtos??null;
  const candidatas=await db.query<{state:string}>(`SELECT DISTINCT state FROM ops.milly_consultas
    WHERE environment=$1 AND conversation_id=$2 AND state IN ('sending','published') AND valid_until>clock_timestamp()
      AND ($3::uuid[] IS NULL OR product_id=ANY($3::uuid[]))`,[environment,conversationId,ids]);
  if (!candidatas.rows.length) return null;
  if (candidatas.rows.some(row=>row.state==='sending')) {
    await reconciliarPublicacaoMilly(db,environment,conversationId);
  }
  const res = await db.query<Row>(`SELECT ${columns},'approved' AS status FROM ops.milly_consultas r
    WHERE r.environment=$1 AND r.conversation_id=$2 AND r.state='published' AND r.valid_until>clock_timestamp()
      AND ($3::uuid[] IS NULL OR r.product_id=ANY($3::uuid[]))
    ORDER BY r.published_at DESC,r.id DESC LIMIT 1 FOR UPDATE`,[environment,conversationId,ids]);
  const row = res.rows[0];
  if (!row?.validUntil || !row.publishedAt || row.approvedTotalCents==null) return null;
  return {...consulta(row), approvedTotalCents:row.approvedTotalCents,validUntil:new Date(row.validUntil).toISOString(),
    publishedAt:new Date(row.publishedAt).toISOString(),publishedProviderId:row.publishedProviderId};
}

export async function consumirOfertaMilly(db: Db, environment: Environment, id: string, orderId: string) {
  const res = await db.query(`UPDATE ops.milly_consultas r SET state='consumed',order_id=o.id
    FROM commerce.orders o WHERE r.environment=$1 AND r.id=$2 AND r.state='published' AND r.valid_until>clock_timestamp()
      AND o.environment=r.environment AND o.id=$3 AND o.source_conversation_id=r.conversation_id AND o.unit_id=r.unit_id
      AND o.partner_order_id IS NULL
      AND round(o.total_amount*100)=r.approved_total_cents AND o.fulfillment_mode=r.fulfillment_mode
      AND o.payment_method=r.payment_method AND (SELECT count(*)=1 AND
        bool_and(i.product_id=r.product_id AND i.quantity=r.quantity
          AND round(i.unit_price*100)*r.quantity+r.freight_cents=r.approved_total_cents)
        FROM commerce.order_items i WHERE i.environment=o.environment AND i.order_id=o.id) RETURNING r.id`,[environment,id,orderId]);
  if (res.rowCount!==1) throw new Error('O aval da Milly expirou ou não corresponde ao pedido.');
}

export async function pedidoComAvalMilly(db: Db, environment: Environment, orderId: string) {
  if (!await esquemaDisponivel(db)) return false;
  const res = await db.query('SELECT 1 FROM ops.milly_consultas WHERE environment=$1 AND order_id=$2 AND state=\'consumed\'',[environment,orderId]);
  return res.rowCount===1;
}
