import type { PoolClient } from 'pg';
import { z } from 'zod';
import { env } from '../shared/config/env.js';
import { normalizeBrazilianPhone } from '../shared/phone.js';
import { tireSizeKey } from '../shared/tire-size.js';
import type { ToolDefinition } from './types.js';

export const STOCK_INTEREST_TOOL: ToolDefinition = { type: 'function', function: {
  name: 'registrar_interesse_reposicao',
  description: 'Registra pedido de aviso pela equipe quando não há estoque. Não envia mensagens nem promete reposição. Primeiro peça ao cliente uma autorização explícita e o WhatsApp, por exemplo: pode me avisar no WhatsApp 21... . consentimento deve copiar a mensagem do cliente exatamente. Para revogar, use acao cancelar.',
  parameters: { type: 'object', additionalProperties: false,
    properties: { acao: { type: 'string', enum: ['registrar','cancelar'] }, medida: { type:'string' },
      condicao: { type:'string', enum:['novo','meia_vida','remold'] }, telefone:{type:'string'}, consentimento:{type:'string'} },
    required:['acao','medida','condicao','telefone','consentimento'] },
} };
const schema = z.object({ acao:z.enum(['registrar','cancelar']), medida:z.string().max(40),
  condicao:z.enum(['novo','meia_vida','remold']), telefone:z.string().max(40), consentimento:z.string().min(1).max(2000) }).strict();

export function explicitRestockConsent(text: string): boolean {
  const normalized=text.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  return /\b(avis\w*|notific\w*|inform\w*)\b/.test(normalized)
    && /\b(pode|quero|autorizo|sim|avisa|avise)\b/.test(normalized)
    && !/\b(nao|nunca|pare|cancel\w*|remov\w*)\b/.test(normalized);
}
export async function registerStockInterest(client: PoolClient, environment: string, conversationId: string, raw: unknown) {
  if (!env.ORGANIC_ATTRIBUTION_ENABLED) return { erro:'recurso_desativado' };
  const parsed=schema.safeParse(raw);
  if (!parsed.success) return { erro:'dados_invalidos' };
  const a=parsed.data, size=tireSizeKey(a.medida), phone=normalizeBrazilianPhone(a.telefone);
  if (!size) return { erro:'medida_invalida' };
  const recent=await client.query(`SELECT id,content,sent_at FROM core.messages WHERE environment=$1
    AND conversation_id=$2 AND sender_type='contact' AND NOT is_private AND deleted_at IS NULL
    ORDER BY sent_at DESC,id DESC LIMIT 5`,[environment,conversationId]);
  const consent=recent.rows.find(m=>String(m.content).trim()===a.consentimento.trim());
  if (!consent || Date.now()-new Date(consent.sent_at).getTime()>30*60000) return { erro:'autorizacao_nao_confirmada',
    orientacao:'Peça autorização explícita por texto para avisar no WhatsApp e copie a resposta sem alterar.' };
  if (a.acao==='cancelar') {
    if (!/\b(n[aã]o|cancel\w*|pare|remov\w*)\b/i.test(a.consentimento)) return {erro:'revogacao_nao_confirmada'};
    await client.query(`UPDATE ops.stock_interests SET status='cancelled',updated_at=now(),updated_by='customer'
      WHERE environment=$1 AND conversation_id=$2 AND tire_size=$3 AND tire_condition=$4`,[environment,conversationId,size,a.condicao]);
    return {cancelado:true};
  }
  const numbers=recent.rows.flatMap(m=>String(m.content).match(/\+?\d[\d\s().-]{8,24}\d/g) ?? []);
  if (!phone || !numbers.some(n=>normalizeBrazilianPhone(n)===phone) || !explicitRestockConsent(a.consentimento)) {
    return {erro:'consentimento_ou_telefone_pendente',orientacao:'Peça ao cliente confirmar por texto que pode avisar no WhatsApp e informar o número. Não diga que já registrou.'};
  }
  const saved=await client.query(`INSERT INTO ops.stock_interests
    (environment,conversation_id,source_message_id,tire_size,tire_condition,phone_e164,consent_text,consent_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING id`,
    [environment,conversationId,consent.id,size,a.condicao,phone,a.consentimento,consent.sent_at]);
  if(!saved.rowCount) {
    const active=await client.query(`SELECT id FROM ops.stock_interests WHERE environment=$1 AND conversation_id=$2
      AND tire_size=$3 AND tire_condition=$4 AND status='pending'`,[environment,conversationId,size,a.condicao]);
    if(!active.rowCount)return {erro:'novo_consentimento_necessario',orientacao:'Este pedido de aviso já foi encerrado. Peça uma nova autorização antes de registrar outro.'};
  }
  return {registrado:true,orientacao:'A equipe recebeu o interesse. Sem previsão garantida e sem disparo automático.'};
}
