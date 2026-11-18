import { randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { ErrorCode, McpError, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { env } from '../../../shared/config/env.js';
import type { Environment } from '../../../shared/types/chatwoot.js';
import { lerPedidoConsultaMilly, registrarParecerMilly } from '../../../atendente-v2/milly-negociacao.js';
import { dotConfig, DOT_SCOPE } from '../config.js';
import { lockGrant, transact } from '../installment-reviews.js';
import { monitorOwnerSql, type DotIdentity } from '../token-store.js';
import { dotEventsAvailable } from './availability.js';
import { signedHeaders, unseal } from './crypto.js';
import { sendWebhook, type WebhookSender } from './https.js';
import { matches } from './model.js';
import { readSettings, ruleEnabled } from './settings.js';
import { activeSubscriptionsSql, subscriptionParams, type Subscription } from './subscriptions.js';
import { commercialFacts, permiteValor } from './negotiation-live-stock.js';

const conversationEvent = 'farejador.conversa.atualizada';
const reason = 'aval_comercial_milly';
const contextTool = 'consultar_negociacao_atendente';
const decideTool = 'orientar_negociacao_atendente';
type Query = Pick<Pool,'query'>;
const contextSchema = z.object({evento:z.string().regex(/^evt_[a-f0-9]{64}$/),consulta:z.string().uuid()}).strict();
const decisionSchema = contextSchema.extend({turno:z.string().uuid(),loja:z.string().uuid(),
  decisao:z.enum(['aceitar','contrapropor','manter','aguardar_dado']),
  total_centavos:z.number().int().positive().max(2_147_483_647).optional(),
  orientacao:z.enum(['oferecer_retirada','pedir_proposta','seguir_tabela']).optional(),
}).strict().superRefine((v,ctx) => {
  if ((v.decisao==='aceitar'||v.decisao==='contrapropor') !== (v.total_centavos!==undefined))
    ctx.addIssue({code:'custom',message:'Informe total somente para aceitar ou contrapropor.'});
  if ((v.decisao==='aceitar'||v.decisao==='contrapropor') && v.orientacao!==undefined)
    ctx.addIssue({code:'custom',message:'Use orientação opcional somente ao manter ou aguardar.'});
});
type Decision = z.infer<typeof decisionSchema>;
const securitySchemes = [{type:'oauth2',scopes:[DOT_SCOPE]}];
function tool(name:string,description:string,schema:z.ZodTypeAny,readOnlyHint:boolean) {
  const {$schema,...inputSchema}=zodToJsonSchema(schema,{$refStrategy:'none'});
  return {name,description,inputSchema:inputSchema as Tool['inputSchema'],_meta:{securitySchemes},securitySchemes,
    annotations:{readOnlyHint,destructiveHint:false,idempotentHint:true,openWorldHint:false}};
}
export const liveNegotiationTools=[
  tool(contextTool,'Leia a ficha comercial atual da Matriz para uma consulta privada recebida por evento. Retorna produto, estoque, giro, reposição, custo e condições da transação. Na entrega, rotas abertas não comprovam desvio nem custo adicional.',contextSchema,true),
  tool(decideTool,'Registre o aval delegado pelo controle do proprietário para esta consulta, turno e loja. Total em centavos inclui o frete de tabela. Aceitar usa o total oferecido pelo cliente; contrapropor usa total maior, até a tabela. Ao manter ou aguardar, a orientação opcional pode oferecer retirada para nova avaliação, pedir proposta ou seguir tabela. O pedido e o catálogo não são alterados pela ferramenta.',decisionSchema,false),
];
export const liveNegotiationInstructions=' Quando um evento de conversa trouxer reason=aval_comercial_milly, use consultar_negociacao_atendente com eventId e evidence.consulta. '
  +'Leia quantidade disponível desta variante, giro, custo, reposição e modalidade. Considere somente as condições retornadas. '
  +'Use custo dos pneus e custo adicional de entrega conhecido para avaliar a contribuição direta. Taxas do meio de pagamento e despesas fixas ficam fora da ficha. Não afirme margem líquida garantida. '
  +'Considere a fonte da praça de referência e quantas entregas têm município cadastrado. Uma parada na mesma cidade não confirma que este endereço cabe na rota. '
  +'Para entrega, consulte as paradas abertas e o histórico com número de rotas por média. Combustível declarado e despesas aprovadas podem se sobrepor. A média histórica não é o custo de incluir o endereço. Quando faltar o custo incremental use aguardar_dado ou manter. '
  +'Nesse caso pode orientar oferecer_retirada para saber se o cliente aceita mudar de modalidade e avaliar uma nova proposta. Nunca peça ao cliente informações internas de custo e nunca prometa o desconto na retirada antecipadamente. '
  +'Se a ficha permitir, chame orientar_negociacao_atendente com o evento, consulta, turno e loja retornados. '
  +'O controle ativado pelo proprietário delega apenas esse aval à atendente, dentro da ficha. As demais operações continuam com suas confirmações próprias.';

const eligibleSubs=activeSubscriptionsSql+` AND ${monitorOwnerSql} AND s.event_name='${conversationEvent}' AND s.verified_at IS NOT NULL`;
async function subscriptions(db:Query,environment:Environment,owner?:string) {
  if (environment!==env.FAREJADOR_ENV || !dotEventsAvailable() || !env.CHATWOOT_ACCOUNT_ID
    || !ruleEnabled((await readSettings(db)).settings,conversationEvent)) return [];
  return (await db.query<Subscription>(eligibleSubs+` AND s.person_id=COALESCE(
    (SELECT owner_person_id FROM ops.milly_consulta_config WHERE environment=$1 AND enabled),$4::uuid)`,
  [...subscriptionParams(),owner??null])).rows;
}
export async function canalConsultaMillyDisponivel(db:Query,environment:Environment,owner?:string) {
  try { return (await subscriptions(db,environment,owner)).length===1; } catch { return false; }
}
function unavailable() { return new McpError(ErrorCode.InvalidParams,'Consulta expirada, pausada ou indisponível nesta conexão.'); }

export async function notificarConsultaMilly(db:Pool,environment:Environment,consultaId:string,conversationId:string,
  send:WebhookSender=sendWebhook):Promise<boolean> {
  if (!dotEventsAvailable() || environment!==env.FAREJADOR_ENV) return false;
  const pedido=await lerPedidoConsultaMilly(db,environment,consultaId);
  if (!pedido || pedido.conversationId!==conversationId) return false;
  const subs=(await subscriptions(db,environment)).filter(s=>matches(s.arguments,conversationId));
  // A URL or a person supplied by the model must never choose a callback.
  if(subs.length!==1) return false;
  const sub=subs[0]!, id='evt_'+randomBytes(32).toString('hex'), now=new Date().toISOString();
  const payload={eventId:id,name:conversationEvent,timestamp:now,data:{
    entity_id:conversationId,kind:'conversation',reason,status:'aguardando_aval',observed_at:now,
    source:'ops.milly_consultas',url:dotConfig()!.origin+'/admin/painel',evidence:{consulta:consultaId},
  },cursor:null};
  const fingerprint='milly:'+consultaId;
  // A synchronous sale consultation has its own deadline and delivery. Keep its event receipt
  // for the callback and for deduplication; the periodic monitoring worker never dispatches it.
  const inserted=await db.query(`INSERT INTO ops.dot_event_deliveries
    (id,environment,subscription_id,activation_id,kind,entity_id,fingerprint,payload,not_before)
    SELECT $1,q.environment,s.id,s.activation_id,'conversation',q.conversation_id,$6,$7::jsonb,q.request_deadline
    FROM ops.milly_consultas q JOIN ops.milly_consulta_config cf ON cf.environment=q.environment
      AND cf.enabled AND cf.generation=q.generation
    JOIN network.dot_event_subscriptions s ON s.environment=cf.environment AND s.person_id=cf.owner_person_id
      AND s.id=$3 AND s.activation_id=$4 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
    JOIN core.conversations c ON c.id=q.conversation_id AND c.environment=q.environment
      AND c.chatwoot_account_id=$9 AND c.deleted_at IS NULL
    JOIN core.messages m ON m.environment=c.environment AND m.conversation_id=c.id AND m.id=q.trigger_message_id
      AND m.message_type=0 AND NOT m.is_private AND m.deleted_at IS NULL
    WHERE q.environment=$2 AND q.id=$5 AND q.conversation_id=$8 AND q.state='pending' AND q.request_deadline>clock_timestamp()
    ON CONFLICT DO NOTHING RETURNING id`,
  [id,environment,sub.id,sub.activation_id,consultaId,fingerprint,payload,conversationId,env.CHATWOOT_ACCOUNT_ID]);
  if (!inserted.rowCount) {
    const existing=await db.query(`SELECT 1 FROM ops.dot_event_deliveries
      WHERE environment=$1 AND subscription_id=$2 AND activation_id=$3 AND kind='conversation'
        AND entity_id=$4 AND fingerprint=$5 AND status IN ('pending','sent')`,[environment,sub.id,sub.activation_id,conversationId,fingerprint]);
    return Boolean(existing.rowCount);
  }
  const body=JSON.stringify(payload);
  let sent=false;
  try {
    const keys=[unseal(sub.secret_ciphertext,sub.id)];
    if(sub.previous_secret_ciphertext && sub.previous_secret_until && sub.previous_secret_until>new Date())
      keys.push(unseal(sub.previous_secret_ciphertext,sub.id));
    const {status}=await send(sub.callback_url,body,signedHeaders(id,body,sub.id,keys));
    sent=status>=200 && status<300;
  } finally {
    await db.query(`UPDATE ops.dot_event_deliveries SET status=CASE WHEN $3 THEN 'sent' ELSE 'failed' END,
      attempts=attempts+1,sent_at=CASE WHEN $3 THEN clock_timestamp() END
      WHERE environment=$1 AND id=$2 AND status='pending'`,[environment,id,sent]);
  }
  return sent;
}

async function resolveEvent(db:PoolClient,identity:DotIdentity,args:z.infer<typeof contextSchema>) {
  if(!dotEventsAvailable()) throw unavailable();
  const grant=await lockGrant(db,identity.person_id,identity.grant_id);
  if(!grant.monitor_owner_approval) throw unavailable();
  await db.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',[env.FAREJADOR_ENV+':dot-settings']);
  if (!ruleEnabled((await readSettings(db)).settings,conversationEvent)) throw unavailable();
  const event=await db.query<{entity_id:string;arguments:Subscription['arguments']}>(`
    SELECT d.entity_id,s.arguments FROM ops.dot_event_deliveries d
    JOIN network.dot_event_subscriptions s ON s.environment=d.environment AND s.id=d.subscription_id
      AND s.activation_id=d.activation_id AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
      AND s.verified_at IS NOT NULL AND s.event_name=$6 AND s.person_id=$3 AND s.grant_id=$4
    JOIN ops.milly_consultas q ON q.environment=d.environment AND q.id=$5 AND d.entity_id=q.conversation_id
    JOIN core.conversations c ON c.environment=q.environment AND c.id=q.conversation_id AND c.deleted_at IS NULL
      AND c.chatwoot_account_id=$8
    JOIN core.contacts ct ON ct.environment=c.environment AND ct.id=c.contact_id AND ct.deleted_at IS NULL
    JOIN core.messages m ON m.environment=c.environment AND m.conversation_id=c.id AND m.id=q.trigger_message_id
      AND m.message_type=0 AND m.sender_type='contact' AND NOT m.is_private AND m.deleted_at IS NULL
    JOIN ops.milly_consulta_config cf ON cf.environment=q.environment AND cf.generation=q.generation
      AND cf.enabled AND cf.owner_person_id=s.person_id
    WHERE d.environment=$1 AND d.id=$2 AND d.kind='conversation' AND d.status IN ('pending','sent')
      AND d.payload->>'name'=$6 AND d.payload#>>'{data,reason}'=$7 AND d.payload#>>'{data,evidence,consulta}'=q.id::text
      AND d.fingerprint='milly:'||q.id::text
    FOR SHARE OF s`,[env.FAREJADOR_ENV,args.evento,identity.person_id,identity.grant_id,args.consulta,conversationEvent,reason,env.CHATWOOT_ACCOUNT_ID]);
  const receipt=event.rows[0];
  if(!receipt || !matches(receipt.arguments,receipt.entity_id)) throw unavailable();
  return receipt.entity_id;
}

export async function invokeLiveNegotiation(identity:DotIdentity,name:string,input:unknown) {
  try {
    const decision:Decision|null=name===decideTool ? decisionSchema.parse(input) : null;
    if(!decision && name!==contextTool) throw unavailable();
    const args=decision??contextSchema.parse(input);
    const result=await transact(async db=>{
      const conversation=await resolveEvent(db,identity,args);
      const req=await lerPedidoConsultaMilly(db,env.FAREJADOR_ENV,args.consulta);
      if(!req && decision) {
        // A lost acknowledgement must not make the Dot infer that the saved price was rejected.
        const saved=await db.query(`SELECT 1 FROM ops.milly_consultas r JOIN ops.milly_consulta_config cf
          ON cf.environment=r.environment AND cf.enabled AND cf.generation=r.generation AND cf.owner_person_id=r.decided_by
          WHERE r.environment=$1 AND r.id=$2 AND r.conversation_id=$3 AND r.trigger_message_id=$4 AND r.unit_id=$5
            AND r.decided_by=$6 AND r.decision=$7 AND r.approved_total_cents IS NOT DISTINCT FROM $8::int
            AND r.orientation IS NOT DISTINCT FROM $9::text
            AND r.state IN ('declined','approved','sending','published','consumed')`,
          [env.FAREJADOR_ENV,args.consulta,conversation,decision.turno,decision.loja,identity.person_id,decision.decisao,
            decision.total_centavos??null,decision.orientacao??null]);
        if(saved.rowCount) return {consulta:args.consulta,registrada:true,decisao:decision.decisao};
      }
      if(!req || req.conversationId!==conversation || (decision && (decision.turno!==req.triggerMessageId || decision.loja!==req.unitId))) throw unavailable();
      if(!decision){
        const facts=await commercialFacts(db,env.FAREJADOR_ENV,req);
        return {consulta:req.id,turno:req.triggerMessageId,loja:req.unitId,produto:req.productId,
          quantidade:req.quantity,forma_pagamento:req.paymentMethod,modalidade:req.fulfillmentMode,
          oferta_cliente_total_centavos:req.offeredTotalCents,tabela_unitaria_centavos:req.catalogUnitCents,
          frete_tabela_centavos:req.freightCents,lido_em:new Date().toISOString(),...facts};
      }
      if(decision.decisao==='aceitar'||decision.decisao==='contrapropor') {
        const facts=await commercialFacts(db,env.FAREJADOR_ENV,req,true);
        if(!permiteValor(req,facts,decision.decisao,decision.total_centavos!))
          throw new McpError(ErrorCode.InvalidParams,'A ficha atual não permite esse valor. Use manter ou aguardar_dado.');
      }
      if(decision.orientacao==='oferecer_retirada' && req.fulfillmentMode!=='delivery')
        throw new McpError(ErrorCode.InvalidParams,'A consulta já é para retirada.');
      const ok=await registrarParecerMilly(db,env.FAREJADOR_ENV,req.id,{decisao:decision.decisao,
        ...(decision.total_centavos!==undefined?{totalCentavos:decision.total_centavos}:{}),
        ...(decision.orientacao?{orientacao:decision.orientacao}:{}),personId:identity.person_id});
      if(!ok) throw unavailable();
      return {consulta:req.id,registrada:true,decisao:decision.decisao};
    });
    return {content:[{type:'text' as const,text:JSON.stringify(result)}],structuredContent:result};
  } catch(e) {
    if(e instanceof McpError) throw e;
    if(e instanceof z.ZodError) throw new McpError(ErrorCode.InvalidParams,'Confira consulta, turno e condição comercial.');
    throw new McpError(ErrorCode.InternalError,'Consulta privada da atendente indisponível.');
  }
}
