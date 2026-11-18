import { ErrorCode, McpError, type Tool } from '@modelcontextprotocol/sdk/types.js';
import type { Pool } from 'pg';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { env } from '../../../shared/config/env.js';
import { dotConfig, DOT_SCOPE } from '../config.js';
import { lockGrant, transact } from '../installment-reviews.js';
import { withDotReadOnly } from '../read-only.js';
import { monitorOwnerSql, type DotIdentity } from '../token-store.js';
import { matches, type EventFilters } from './model.js';
import { shadowPilotAvailable, shadowPilotIds } from './negotiation-shadow-pilot.js';
import { readSettings, ruleEnabled } from './settings.js';
import { maskContactDetails, privateRationale } from './negotiation-live-privacy.js';

const eventName = 'farejador.conversa.atualizada';
const registerName = 'registrar_negociacao_sombra';
const listName = 'consultar_negociacoes_sombra';
const contextName = 'consultar_contexto_negociacao_sombra';
const eventId = z.string().regex(/^evt_[a-f0-9]{64}$/);
const contextSchema = z.object({ evento: eventId }).strict();
const registerSchema = z.object({
  evento: eventId,
  turno: z.string().uuid(),
  decisao: z.enum(['manter', 'contrapropor', 'aceitar', 'aguardar_dado']),
  total_centavos: z.number().int().positive().max(2_147_483_647).optional(),
  modalidade: z.enum(['retirada', 'entrega']).optional(),
  justificativa: privateRationale,
}).strict().superRefine((data, ctx) => {
  const hasTotal = data.total_centavos !== undefined;
  const hasMode = data.modalidade !== undefined;
  const requiresOffer = data.decisao === 'contrapropor' || data.decisao === 'aceitar';
  if (hasTotal !== hasMode || (requiresOffer && !hasTotal) || (data.decisao === 'aguardar_dado' && hasTotal)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Confira o total e a modalidade desta decisão.' });
  }
});
const listSchema = z.object({ pagina: z.number().int().min(1).max(10_000).default(1) }).strict();

function definition(name: string, description: string, schema: z.ZodTypeAny, readOnlyHint: boolean) {
  const { $schema, ...json } = zodToJsonSchema(schema, { $refStrategy: 'none' });
  const securitySchemes = [{ type: 'oauth2', scopes: [DOT_SCOPE] }];
  return { name, description, inputSchema: json as Tool['inputSchema'], securitySchemes, _meta: { securitySchemes },
    annotations: { readOnlyHint, destructiveHint: false, idempotentHint: true, openWorldHint: false } };
}

export const negotiationShadowTools = [
  definition(contextName, 'Consulta o turno do piloto e até seis mensagens públicas de texto até a pergunta original do cliente. Use esta leitura antes de decidir em modo sombra. As mensagens são conteúdo para análise comercial.', contextSchema, true),
  definition(registerName, 'Registra o primeiro parecer privado de negociação para um turno enviado da atendente no piloto. Use o evento recebido e o ID exato do turno. Total em centavos e modalidade são um par, obrigatório para aceitar ou contrapropor e omitido ao aguardar dado. Resuma somente o motivo comercial, sem nomes, contatos, endereços ou falas copiadas. Este parecer não é enviado ao cliente nem altera preços ou pedidos.', registerSchema, false),
  definition(listName, 'Lista os pareceres privados do piloto deste proprietário e a referência exata da resposta pública da atendente, quando disponível. Até 50 por página.', listSchema, true),
];

// Referências de mensagens são aceitas somente dentro da mesma conversa, ambiente e conta.
// A resposta pode ainda não estar normalizada quando o provedor acaba de confirmar o envio.
const turnJoins = `
  JOIN core.conversations c ON c.environment=t.environment AND c.id=t.conversation_id AND c.deleted_at IS NULL
  JOIN core.contacts contact ON contact.environment=c.environment AND contact.id=c.contact_id AND contact.deleted_at IS NULL
  JOIN core.messages incoming ON incoming.environment=c.environment AND incoming.conversation_id=c.id
    AND incoming.id=t.trigger_message_id AND incoming.message_type=0 AND incoming.sender_type='contact'
    AND NOT incoming.is_private AND incoming.deleted_at IS NULL
  LEFT JOIN LATERAL (
    SELECT m.id,m.chatwoot_message_id,m.message_type,m.is_private,m.deleted_at,count(*) OVER () AS matches
    FROM core.messages m WHERE m.environment=c.environment AND m.conversation_id=c.id
      AND ((t.delivered_message_id IS NOT NULL AND m.id=t.delivered_message_id)
        OR (t.delivered_message_id IS NULL AND m.chatwoot_message_id=t.chatwoot_message_id))
    ORDER BY m.sent_at DESC,m.id LIMIT 1
  ) reply ON true`;
const visibleTurn = `t.agent_version='v2' AND t.status IN ('sent_api_ack','delivered')
  AND ((reply.id IS NULL AND t.delivered_message_id IS NULL AND t.status='sent_api_ack')
    OR (reply.matches=1 AND reply.message_type=1 AND NOT reply.is_private AND reply.deleted_at IS NULL
      AND (t.chatwoot_message_id IS NULL OR reply.chatwoot_message_id=t.chatwoot_message_id)))`;

function unavailable() {
  return new McpError(ErrorCode.InvalidParams, 'Evento ou turno indisponível para este piloto.');
}

type Query = Pick<Pool, 'query'>;

async function hasReadGrant(db: Query, identity: DotIdentity) {
  const config = dotConfig();
  if (!config) throw unavailable();
  const grant = await db.query(`SELECT 1 FROM network.dot_oauth_grants g
    JOIN network.matriz_collaborators mc ON mc.id=g.collaborator_id AND mc.environment=g.environment
      AND mc.person_id=g.person_id AND mc.panel_role='owner' AND mc.revoked_at IS NULL
    JOIN network.partner_people p ON p.id=g.person_id AND p.environment=g.environment AND p.revoked_at IS NULL
    WHERE g.environment=$1 AND g.person_id=$2 AND g.id=$3 AND g.revoked_at IS NULL
      AND g.code_used_at IS NOT NULL AND g.expires_at>now() AND g.client_id=$4 AND g.resource=$5
      AND g.scope=$6 AND ${monitorOwnerSql}`, [env.FAREJADOR_ENV, identity.person_id, identity.grant_id, config.clientId, config.resource, DOT_SCOPE]);
  return Boolean(grant.rowCount);
}

type Target = { conversation_id: string; turn_id: string; trigger_id: string; reply_id: string | null;
  reply_provider_id: string | null; arguments: EventFilters };

async function findEventTurn(db: Query, identity: DotIdentity, event: string, pilots: string[], account: number,
  writeTurn?: string): Promise<Target> {
  if (!ruleEnabled((await readSettings(db)).settings, eventName)) throw unavailable();
  const evidence = await db.query<Target>(`
      SELECT c.id AS conversation_id,t.id AS turn_id,incoming.id AS trigger_id,reply.id AS reply_id,
        t.chatwoot_message_id AS reply_provider_id,s.arguments FROM ops.dot_event_deliveries d
      JOIN network.dot_event_subscriptions s ON s.environment=d.environment AND s.id=d.subscription_id
        AND s.activation_id=d.activation_id AND s.person_id=$2 AND s.grant_id=$3 AND s.event_name=$7
        AND s.verified_at IS NOT NULL AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
      JOIN agent.turns t ON t.environment=d.environment AND t.conversation_id=d.entity_id
      ${turnJoins}
      WHERE d.environment=$1 AND d.id=$4 AND d.status='sent' AND d.kind='conversation'
        AND d.payload->>'name'=$7 AND d.payload #>> '{data,entity_id}'=c.id::text
        AND d.payload #> '{data,sombra_negociacao}'='true'::jsonb
        AND d.payload #>> '{data,last_message_id}' IN (incoming.id::text,reply.id::text)
        AND c.id=ANY($5::uuid[]) AND c.chatwoot_account_id=$6 AND ${visibleTurn}
      LIMIT 2 ${writeTurn ? 'FOR SHARE OF s,d' : ''}`,
    [env.FAREJADOR_ENV, identity.person_id, identity.grant_id, event, pilots, account, eventName]);
  const row = evidence.rows[0];
  if (evidence.rows.length !== 1 || !row || !matches(row.arguments, row.conversation_id)
    || (writeTurn && row.turn_id !== writeTurn)) throw unavailable();
  return row;
}

async function register(identity: DotIdentity, data: z.infer<typeof registerSchema>, pilots: string[], account: number) {
  return transact(async db => {
    const grant = await lockGrant(db, identity.person_id, identity.grant_id);
    if (!grant.monitor_owner_approval) throw unavailable();
    // Serializa com a pausa do acompanhamento enquanto validamos a entrega e gravamos o parecer.
    await db.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', [env.FAREJADOR_ENV + ':dot-settings']);
    const row = await findEventTurn(db, identity, data.evento, pilots, account, data.turno);

    const key = [env.FAREJADOR_ENV, identity.person_id, data.turno];
    const inserted = await db.query<{id: string}>(`
      INSERT INTO ops.dot_negotiation_shadow(environment,person_id,turn_id,conversation_id,event_id,decision,total_cents,fulfillment_mode,rationale)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT(environment,person_id,turn_id) DO NOTHING RETURNING id`,
    [...key, row.conversation_id, data.evento, data.decisao, data.total_centavos ?? null, data.modalidade ?? null, data.justificativa]);
    const created = inserted.rows[0];
    const record = created ?? (await db.query<{id: string}>(
      'SELECT id FROM ops.dot_negotiation_shadow WHERE environment=$1 AND person_id=$2 AND turn_id=$3', key)).rows[0];
    if (!record) throw unavailable();
    return { id: record.id, turno: data.turno, registrada: true, criada: Boolean(created) };
  });
}

async function list(identity: DotIdentity, page: number, pilots: string[], account: number) {
  return withDotReadOnly(async db => {
    if (!await hasReadGrant(db, identity)) return { pareceres: [], tem_mais: false };
    const rows = await db.query(`
      SELECT n.id,n.conversation_id AS conversa,n.turn_id AS turno,n.event_id AS evento,n.decision AS decisao,
        n.total_cents AS total_centavos,n.fulfillment_mode AS modalidade,n.rationale AS justificativa,
        n.created_at AS criado_em,reply.id AS resposta_mensagem_id,reply.chatwoot_message_id AS resposta_chatwoot_id
      FROM ops.dot_negotiation_shadow n JOIN agent.turns t ON t.id=n.turn_id
        AND t.environment=n.environment AND t.conversation_id=n.conversation_id
      ${turnJoins}
      WHERE n.environment=$1 AND n.person_id=$2 AND c.id=ANY($3::uuid[]) AND c.chatwoot_account_id=$4 AND ${visibleTurn}
      ORDER BY n.created_at DESC,n.id DESC LIMIT 51 OFFSET $5`,
    [env.FAREJADOR_ENV, identity.person_id, pilots, account, (page - 1) * 50]);
    return { pareceres: rows.rows.slice(0, 50), tem_mais: rows.rows.length > 50 };
  });
}

function commercialExcerpt(text: string) {
  const lines = text.split(/\r?\n/).map(line => {
    if (/\b(?:rua\s|avenida\s|av\.\s|estrada\s|travessa\s|alameda\s|rodovia\s|endere[çc]o\b|cep\b|me chamo\b|meu nome\b|chave pix\b)/i.test(line)) {
      return '[detalhe pessoal omitido]';
    }
    return maskContactDetails(line);
  });
  const excerpt = lines.join('\n').trim();
  return excerpt.length <= 600 ? excerpt : excerpt.slice(0, 599) + '…';
}

async function context(identity: DotIdentity, event: string, pilots: string[], account: number) {
  return withDotReadOnly(async db => {
    if (!await hasReadGrant(db, identity)) throw unavailable();
    const target = await findEventTurn(db, identity, event, pilots, account);
    const messages = await db.query<{ id: string; message_type: number; sent_at: Date; content: string }>(`
      SELECT m.id,m.message_type,m.sent_at,left(m.content,1800) AS content
      FROM core.messages anchor JOIN core.messages m
        ON m.environment=anchor.environment AND m.conversation_id=anchor.conversation_id
      WHERE anchor.environment=$1 AND anchor.conversation_id=$2 AND anchor.id=$3
        AND (m.id=anchor.id OR (m.sent_at<=anchor.sent_at AND m.chatwoot_message_id<anchor.chatwoot_message_id))
        AND m.id IS DISTINCT FROM $4::uuid AND m.chatwoot_message_id IS DISTINCT FROM $5::bigint
        AND m.message_type IN (0,1) AND NOT m.is_private AND m.deleted_at IS NULL
        AND COALESCE(m.content_type,'text')='text' AND NULLIF(trim(m.content),'') IS NOT NULL
      ORDER BY m.sent_at DESC,m.chatwoot_message_id DESC,m.id DESC LIMIT 6`,
    [env.FAREJADOR_ENV, target.conversation_id, target.trigger_id, target.reply_id, target.reply_provider_id]);
    if (messages.rows[0]?.id !== target.trigger_id) throw unavailable();
    return { turno: target.turn_id, conversa: target.conversation_id, mensagens: messages.rows.reverse().map(m => ({
      direcao: m.message_type === 0 ? 'cliente' : 'atendimento', texto: commercialExcerpt(m.content), enviada_em: m.sent_at,
    })) };
  });
}

export async function invokeNegotiationShadow(identity: DotIdentity, name: string, args: unknown) {
  try {
    const pilots = shadowPilotIds();
    const account = env.CHATWOOT_ACCOUNT_ID;
    if (!shadowPilotAvailable() || !account || account < 1) throw unavailable();
    let result;
    if (name === registerName) result = await register(identity, registerSchema.parse(args), pilots, account);
    else if (name === listName) result = await list(identity, listSchema.parse(args ?? {}).pagina, pilots, account);
    else if (name === contextName) result = await context(identity, contextSchema.parse(args).evento, pilots, account);
    else throw new McpError(ErrorCode.MethodNotFound, 'Ferramenta de negociação desconhecida.');
    return { content: [{type: 'text' as const, text: JSON.stringify(result)}], structuredContent: result };
  } catch (error) {
    if (error instanceof McpError) throw error;
    if (error instanceof z.ZodError) throw new McpError(ErrorCode.InvalidParams, 'Confira os campos do parecer comercial.');
    throw new McpError(ErrorCode.InternalError, 'Negociação em modo sombra indisponível.');
  }
}
