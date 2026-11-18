import type { Pool } from 'pg';
import { pool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';

interface Cursor { at:string; id:string }
interface Message { texto:string|null; em:string }
interface Order {
  id:string; numero:string; status:string; total_centavos:number; criado_em:string;
  pagamento:string|null; modalidade:string|null;
  itens:{nome:string|null; quantidade:number; unitario_centavos:number; desconto_centavos:number}[];
}
interface Consultation {
  id:string; estado:string; decisao:string|null; orientacao:string|null; produto:{id:string;nome:string|null};
  quantidade:number; pagamento:string; modalidade:string; solicitada_em:string; lida_em:string|null;
  decidida_em:string|null; tempo_milly_ms:number|null; valida_ate:string|null;
  proposta_centavos:number; tabela_unitaria_centavos:number; frete_centavos:number; aval_centavos:number|null;
  ficha:Record<string,unknown>|null; justificativa:string|null; pedido:Order|null;
}
interface HistoryTurn {
  id:string; numero:number; cliente:Message; atendente:Message|null; tempo_resposta_ms:number|null; consulta:Consultation|null; pedido:Order|null;
}

// Reconhece apenas a saída do turno. O ACK fornece uma cópia pública antes de normalizar o eco;
// se o provedor já a marcou privada ou apagada, essa cópia não pode reexibir o conteúdo.
const replyJoins = `
  LEFT JOIN agent.turns t ON t.environment=m.environment AND t.conversation_id=m.conversation_id
    AND t.trigger_message_id=m.id AND t.agent_version='v2'
  LEFT JOIN LATERAL (
    SELECT o.body,o.sent_at,o.provider_message_id,o.echo_id,o.status,o.body_sha256,o.milly_offer_id
    FROM ops.outbound_messages o WHERE o.environment=m.environment AND o.conversation_id=m.conversation_id
      AND o.trigger_message_id=m.id AND o.chatwoot_conversation_id=m.chatwoot_conversation_id
      AND o.kind='agent_text' AND (o.turn_id=t.id OR o.turn_id IS NULL)
    ORDER BY (o.status IN ('sent_api_ack','delivered')) DESC,o.created_at DESC,o.id DESC LIMIT 1
  ) ob ON true
  LEFT JOIN LATERAL (
    SELECT e.id,e.content,e.sent_at,e.chatwoot_message_id,e.is_private,e.deleted_at,e.message_type,e.sender_type
    FROM core.messages e WHERE e.environment=m.environment AND e.conversation_id=m.conversation_id
      AND e.chatwoot_conversation_id=m.chatwoot_conversation_id AND (
        e.chatwoot_message_id=ob.provider_message_id OR e.chatwoot_message_id=t.chatwoot_message_id
        OR e.chatwoot_message_id=q.published_provider_id
        OR e.echo_id IN (ob.echo_id,'turn:'||t.id::text) OR e.content_attributes->>'farejador_echo_id' IN (ob.echo_id,'turn:'||t.id::text))
    ORDER BY (e.chatwoot_message_id=ob.provider_message_id) DESC NULLS LAST,
      (e.chatwoot_message_id=t.chatwoot_message_id) DESC NULLS LAST,e.sent_at,e.id LIMIT 1
  ) echo ON true
  LEFT JOIN LATERAL (
    SELECT echo.content AS texto,echo.sent_at AS em,echo.chatwoot_message_id AS provider
      WHERE echo.id IS NOT NULL AND NOT echo.is_private AND echo.deleted_at IS NULL
        AND echo.sender_type IN ('user','agent_bot') AND echo.message_type=1
    UNION ALL SELECT ob.body,ob.sent_at,ob.provider_message_id
      WHERE echo.id IS NULL AND ob.status IN ('sent_api_ack','delivered')
        AND ob.provider_message_id IS NOT NULL AND ob.sent_at IS NOT NULL
  ) saida ON true`;

const effectiveState = `CASE
  WHEN q.state='consumed' THEN 'consumed'
  WHEN q.state='published' OR (q.state='sending' AND saida.provider IS NOT NULL
    AND (t.id IS NOT NULL OR ob.milly_offer_id=q.id) AND encode(sha256(convert_to(saida.texto,'UTF8')),'hex')=q.body_sha256)
    THEN CASE WHEN q.valid_until<=CURRENT_TIMESTAMP THEN 'expired' ELSE 'published' END
  WHEN q.state IN ('approved','sending','pending','declined') AND (g.enabled AND g.generation=q.generation) IS NOT TRUE THEN 'paused'
  WHEN q.state='pending' AND q.request_deadline<=CURRENT_TIMESTAMP THEN 'expired'
  WHEN q.state IN ('approved','sending') AND q.valid_until<=CURRENT_TIMESTAMP THEN 'expired'
  ELSE q.state END`;

// O aval e a mensagem de aceite podem apontar para o mesmo pedido.
const orderLookup = `
  LEFT JOIN ops.bot_order_attempts attempt ON attempt.environment=m.environment
    AND attempt.conversation_id=m.conversation_id AND attempt.request_message_id=m.id
  LEFT JOIN LATERAL (
    SELECT jsonb_object_agg(o.id,jsonb_build_object(
      'id',o.id,'numero',o.order_number,'status',o.status,'criado_em',o.created_at,
      'total_centavos',round(o.total_amount*100),'pagamento',o.payment_method,'modalidade',o.fulfillment_mode,
      'itens',(SELECT COALESCE(jsonb_agg(jsonb_build_object('nome',p.product_name,'quantidade',i.quantity,
        'unitario_centavos',round(i.unit_price*100),'desconto_centavos',round(i.discount_amount*100))
        ORDER BY i.created_at,i.id),'[]'::jsonb) FROM commerce.order_items i
        LEFT JOIN commerce.products p ON p.environment=i.environment AND p.id=i.product_id
        WHERE i.environment=o.environment AND i.order_id=o.id))) AS por_id
    FROM commerce.orders o WHERE o.environment=m.environment AND o.source_conversation_id=m.conversation_id
      AND (o.id=attempt.order_id OR (o.id=q.order_id AND o.unit_id=q.unit_id)) AND o.partner_order_id IS NULL
  ) pedidos ON true`;

export async function getMillyChatHistory(id:string,before?:Cursor,db:Pool=pool) {
  const result=await db.query<{turns:HistoryTurn[]}>(`WITH conversa AS (
    SELECT c.environment,c.id FROM core.conversations c
    JOIN core.contacts ct ON ct.environment=c.environment AND ct.id=c.contact_id AND ct.deleted_at IS NULL
    WHERE c.environment=$1 AND c.chatwoot_account_id=$2 AND c.id=$3 AND c.deleted_at IS NULL
  ), entradas AS (
    SELECT m.environment,m.conversation_id,m.chatwoot_conversation_id,m.id,m.content,m.sent_at,
      row_number() OVER (ORDER BY m.sent_at,m.id) AS numero FROM conversa c
    JOIN core.messages m ON m.environment=c.environment AND m.conversation_id=c.id
    WHERE NOT m.is_private AND m.deleted_at IS NULL AND m.sender_type='contact' AND m.message_type=0
  ), mensagens AS (
    SELECT * FROM entradas WHERE $4::timestamptz IS NULL OR (sent_at,id)<($4::timestamptz,$5::uuid)
    ORDER BY sent_at DESC,id DESC LIMIT 31
  ), turnos AS (
    SELECT m.id,m.sent_at,jsonb_build_object('id',m.id,'numero',m.numero,
      'cliente',jsonb_build_object('texto',m.content,'em',to_char(m.sent_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')),
      'atendente',CASE WHEN saida.em IS NOT NULL THEN jsonb_build_object('texto',saida.texto,'em',saida.em) END,
      'tempo_resposta_ms',CASE WHEN saida.em>=m.sent_at THEN round(extract(epoch FROM saida.em-m.sent_at)*1000) END,
      'pedido',pedidos.por_id->attempt.order_id::text,
      'consulta',CASE WHEN q.id IS NOT NULL THEN jsonb_build_object(
        'id',q.id,'estado',${effectiveState},'decisao',q.decision,'orientacao',q.orientation,
        'produto',jsonb_build_object('id',q.product_id,'nome',prod.product_name),'quantidade',q.quantity,
        'pagamento',q.payment_method,'modalidade',q.fulfillment_mode,'solicitada_em',q.created_at,'valida_ate',q.valid_until,
        'lida_em',historico.context_read_at,'decidida_em',historico.decided_at,
        'tempo_milly_ms',CASE WHEN historico.decided_at>=q.created_at THEN round(extract(epoch FROM historico.decided_at-q.created_at)*1000) END,
        'proposta_centavos',q.offered_total_cents,'tabela_unitaria_centavos',q.catalog_unit_cents,'frete_centavos',q.freight_cents,
        'aval_centavos',q.approved_total_cents,'justificativa',historico.decision_rationale,'ficha',historico.context_snapshot,'pedido',pedidos.por_id->q.order_id::text) END) AS dados
    FROM mensagens m LEFT JOIN ops.milly_consultas q ON q.environment=m.environment AND q.conversation_id=m.conversation_id AND q.trigger_message_id=m.id
      AND EXISTS (SELECT FROM core.units u WHERE u.environment=q.environment AND u.id=q.unit_id AND u.slug='main')
    -- Uma projeção local só expõe esses quatro campos. Na 0296 as chaves ausentes resultam em NULL.
    LEFT JOIN LATERAL jsonb_to_record(to_jsonb(q)) AS historico(
      context_read_at timestamptz,decided_at timestamptz,decision_rationale text,context_snapshot jsonb
    ) ON q.id IS NOT NULL
    LEFT JOIN ops.milly_consulta_config g ON g.environment=q.environment
    LEFT JOIN commerce.products prod ON prod.environment=q.environment AND prod.id=q.product_id
    ${replyJoins}
    ${orderLookup}
  ) SELECT COALESCE((SELECT jsonb_agg(dados ORDER BY sent_at DESC,id DESC) FROM turnos),'[]'::jsonb) AS turns FROM conversa`,
    [env.FAREJADOR_ENV,env.CHATWOOT_ACCOUNT_ID,id,before?.at??null,before?.id??null]);
  if(!result.rows[0])throw Error('bot_conversation_not_found');
  const page=result.rows[0].turns;
  const turns=page.slice(0,30).reverse();
  const oldest=turns[0];
  return {turns,next:page.length>30 && oldest?{at:oldest.cliente.em,id:oldest.id}:null};
}
