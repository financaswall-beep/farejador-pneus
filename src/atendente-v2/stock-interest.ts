import type { PoolClient } from 'pg';
import { z } from 'zod';
import { normalizeCheckoutPhone, containsCheckoutPhone } from '../shared/phone.js';
import { tireSizeKey } from '../shared/tire-size.js';
import type { ToolDefinition } from './types.js';

export const STOCK_INTEREST_TOOL: ToolDefinition = { type: 'function', function: {
  name: 'registrar_interesse_reposicao',
  description: 'Lista de espera quando falta pneu. Primeiro ofereça aviso pelo WhatsApp; após o aceite, peça o número com DDD no Instagram/Facebook. No WhatsApp com telefone cadastrado, OMITA telefone: o código recupera o número do contato; nunca peça novamente nem invente o número. Confirme medida, condição, tipo e quantidade desejados; pergunte somente o que falta. consentimento copia exatamente a resposta que autorizou o aviso (inclusive sim ou pode ser de boa, após sua oferta). Nunca invente consentimento, telefone, quantidade ou tipo. Não reserva nem envia aviso automaticamente. Para revogar use acao cancelar.',
  parameters: { type: 'object', additionalProperties: false,
    properties: { acao: { type: 'string', enum: ['registrar','cancelar'] }, medida: { type:'string' },
      condicao: { type:'string', enum:['novo','meia_vida','remold'] }, telefone:{type:'string',description:'Opcional no WhatsApp: omita para usar o telefone cadastrado do contato. Em outros canais, informe somente o número confirmado por texto pelo cliente.'}, consentimento:{type:'string'},
      quantidade:{type:'integer',minimum:1,maximum:999}, tipo_veiculo:{type:'string',enum:['car','motorcycle']} },
    required:['acao','medida','condicao','consentimento','quantidade','tipo_veiculo'] },
} };
const schema = z.object({ acao:z.enum(['registrar','cancelar']), medida:z.string().max(40),
  condicao:z.enum(['novo','meia_vida','remold']), telefone:z.string().max(40).optional(), consentimento:z.string().min(1).max(2000),
  quantidade:z.number().int().min(1).max(999).optional(), tipo_veiculo:z.enum(['car','motorcycle']).optional() }).strict();

export function contextualRestockConsent(text:string, offer:string):boolean {
  const normalized=text.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();
  const offered=/\b(avis\w*|notific\w*)\b/i.test(offer) && /\b(cheg\w*|reposi\w*|estoque)\b/i.test(offer)
    && /whats/i.test(offer);
  return offered && (explicitRestockConsent(text) || /^(sim|pode(?: sim| ser)?|quero(?: sim)?|claro|beleza|blz|ok)(?:[,\s]+(?:de boa|por favor|obrigad[oa]))?[\s!.😊👍]*$/.test(normalized));
}

export function explicitRestockConsent(text: string): boolean {
  const normalized=text.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  return /\b(avis\w*|notific\w*|inform\w*)\b/.test(normalized)
    && /\b(pode|quero|autorizo|sim|avisa|avise)\b/.test(normalized)
    && !/\b(nao|nunca|pare|cancel\w*|remov\w*)\b/.test(normalized);
}
export async function registerStockInterest(client: PoolClient, environment: string, conversationId: string, raw: unknown) {
  const parsed=schema.safeParse(raw);
  if (!parsed.success) return { erro:'dados_invalidos' };
  const a=parsed.data, size=tireSizeKey(a.medida);
  if (!size) return { erro:'medida_invalida' };
  const recent=await client.query(`SELECT id,content,sent_at,chatwoot_message_id FROM core.messages WHERE environment=$1
    AND conversation_id=$2 AND sender_type='contact' AND NOT is_private AND deleted_at IS NULL
    ORDER BY sent_at DESC,id DESC LIMIT 20`,[environment,conversationId]);
  const consent=recent.rows.find(m=>String(m.content).trim()===a.consentimento.trim());
  if (!consent || Date.now()-new Date(consent.sent_at).getTime()>30*60000) return { erro:'autorizacao_nao_confirmada',
    orientacao:'Peça autorização explícita por texto para avisar no WhatsApp e copie a resposta sem alterar.' };
  if (a.acao==='cancelar') {
    if (!/\b(n[aã]o|cancel\w*|pare|remov\w*)\b/i.test(a.consentimento)) return {erro:'revogacao_nao_confirmada'};
    await client.query(`UPDATE ops.stock_interests SET status='cancelled',updated_at=now(),updated_by='customer'
      WHERE environment=$1 AND conversation_id=$2 AND tire_size=$3 AND tire_condition=$4 AND status<>'cancelled'`,[environment,conversationId,size,a.condicao]);
    return {cancelado:true};
  }
  const previous=(await client.query(`SELECT content,message_type FROM core.messages WHERE environment=$1 AND conversation_id=$2
    AND (sent_at,chatwoot_message_id)<($3::timestamptz,$4::bigint) AND deleted_at IS NULL AND NOT is_private AND message_type IN(0,1)
    ORDER BY sent_at DESC,chatwoot_message_id DESC LIMIT 1`,[environment,conversationId,consent.sent_at,consent.chatwoot_message_id])).rows[0];
  const offer=previous?.message_type===1?String(previous.content??''):'';
  const confirmed=(explicitRestockConsent(a.consentimento) && /whats/i.test(a.consentimento))
    || contextualRestockConsent(a.consentimento,offer);
  const contact=(await client.query(`SELECT c.channel_type,ct.phone_e164 FROM core.conversations c
    LEFT JOIN core.contacts ct ON ct.id=c.contact_id AND ct.environment=c.environment AND ct.deleted_at IS NULL
    WHERE c.id=$1 AND c.environment=$2 AND c.deleted_at IS NULL`,[conversationId,environment])).rows[0];
  const known=/whatsapp/i.test(contact?.channel_type??'')?normalizeCheckoutPhone(contact?.phone_e164):null;
  const phone=normalizeCheckoutPhone(a.telefone?.trim()||known);
  const revoked=recent.rows.some(m=>Number(m.chatwoot_message_id)>Number(consent.chatwoot_message_id)
    && /\b(n[aã]o\s+(?:me\s+)?avis\w*|n[aã]o\s+preciso|cancel\w*\s+(?:o\s+)?aviso|pare\s+de\s+(?:me\s+)?avis\w*)\b/i.test(m.content));
  if(revoked)return {erro:'novo_consentimento_necessario',orientacao:'O cliente desistiu do aviso. Não o inclua usando a autorização anterior.'};
  if (!phone || !(known===phone || recent.rows.some(m=>containsCheckoutPhone(String(m.content),phone))) || !confirmed) {
    return {erro:'consentimento_ou_telefone_pendente',orientacao:'Peça ao cliente confirmar por texto que pode avisar no WhatsApp e informar o número. Não diga que já registrou.'};
  }
  const classified=(await client.query(`SELECT commerce.catalog_vehicle_type($1::env_t,$2,NULL,$3) AS type`,
    [environment,a.medida,a.condicao])).rows[0]?.type;
  if(classified && a.tipo_veiculo && classified!==a.tipo_veiculo) return {erro:'tipo_veiculo_divergente',orientacao:'Confira o tipo de veículo e a medida antes de registrar.'};
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[`${environment}|waitlist|${phone}|${size}|${a.condicao}`]);
  const duplicate=await client.query(`SELECT id FROM ops.stock_interests WHERE environment=$1 AND phone_e164=$2
    AND tire_size=$3 AND tire_condition=$4 AND status='pending'`,[environment,phone,size,a.condicao]);
  if(duplicate.rowCount)return {registrado:true,orientacao:'Este WhatsApp já está na lista para esse pneu. Não foi duplicado e não há reserva.'};
  const saved=await client.query(`INSERT INTO ops.stock_interests
    (environment,conversation_id,source_message_id,tire_size,tire_condition,phone_e164,consent_text,consent_at,quantity,vehicle_type,offer_text)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING RETURNING id`,
    [environment,conversationId,consent.id,size,a.condicao,phone,a.consentimento,consent.sent_at,a.quantidade??null,a.tipo_veiculo??classified??null,contextualRestockConsent(a.consentimento,offer)?offer:null]);
  if(!saved.rowCount) {
    const active=await client.query(`SELECT id FROM ops.stock_interests WHERE environment=$1 AND conversation_id=$2
      AND tire_size=$3 AND tire_condition=$4 AND status='pending'`,[environment,conversationId,size,a.condicao]);
    if(!active.rowCount)return {erro:'novo_consentimento_necessario',orientacao:'Este pedido de aviso já foi encerrado. Peça uma nova autorização antes de registrar outro.'};
  }
  return {registrado:true,orientacao:'A equipe recebeu o interesse. Sem previsão garantida e sem disparo automático.'};
}
