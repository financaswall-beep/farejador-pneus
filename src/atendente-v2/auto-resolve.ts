import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ChatwootApiClient } from '../admin/chatwoot-api.client.js';
import { pool } from '../persistence/db.js';
import { env } from '../shared/config/env.js';
import { logger } from '../shared/logger.js';
import type { Environment } from '../shared/types/chatwoot.js';
import { hasElapsedBusinessHours, type InboxBusinessHours } from './business-hours.js';
import { hasAgentV2Wildcard } from './conversation-scope.js';
import { lockBotConversation, syncHumanIntervention } from './conversation-control.js';
import { recordOutboundEvent } from './outbound-events.js';

const POLL_MS = 60_000;
const INBOX_CACHE_MS = 5 * 60_000;
const BATCH_SIZE = 25;

export type ResolutionReason = 'completed_order' | 'explicit_desistance' | 'inactivity';

export interface AutoResolveCandidate {
  conversation_id: string;
  chatwoot_conversation_id: string | number;
  chatwoot_inbox_id: number | null;
  latest_message_id: string;
  latest_message_at: Date;
  latest_customer_text: string | null;
}

interface ResolutionGuard {
  allowed: boolean;
  has_completed_order: boolean;
}

interface ResolutionPayload {
  expected_last_message_id: string;
  reason: ResolutionReason;
}

const inboxCache = new Map<number, { expiresAt: number; value: InboxBusinessHours }>();

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function normalizeCustomerText(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[!?.,;:]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Deliberadamente estrito: classificação frouxa nunca encerra conversa. */
export function isExplicitDesistance(text: string | null): boolean {
  if (!text) return false;
  const normalized = normalizeCustomerText(text);
  return /^(?:nao quero mais|desisti|nao vou querer|deixa pra la|pode cancelar|cancela|ja comprei em outro lugar|comprei em outro lugar|nao tenho mais interesse)(?: obrigado| obrigada)?$/.test(normalized);
}

export function parseResolutionPayload(body: string): ResolutionPayload | null {
  try {
    const parsed = JSON.parse(body) as Partial<ResolutionPayload>;
    if (typeof parsed.expected_last_message_id !== 'string'
        || !['completed_order', 'explicit_desistance', 'inactivity'].includes(String(parsed.reason))) {
      return null;
    }
    return parsed as ResolutionPayload;
  } catch {
    return null;
  }
}

export async function listAutoResolveCandidates(
  client: PoolClient,
  environment: Environment,
  allowedConversationIds: readonly string[] = env.AGENT_V2_CONVERSATION_IDS,
): Promise<AutoResolveCandidate[]> {
  const result = await client.query<AutoResolveCandidate>(
    `SELECT c.id AS conversation_id,c.chatwoot_conversation_id,c.chatwoot_inbox_id,
            latest.id AS latest_message_id,latest.sent_at AS latest_message_at,
            customer.content AS latest_customer_text
       FROM core.conversations c
       JOIN LATERAL (
         SELECT m.id,m.sender_type,m.sent_at
           FROM core.messages m
          WHERE m.environment=c.environment AND m.conversation_id=c.id
            AND NOT m.is_private AND m.deleted_at IS NULL AND m.message_type IN (0,1,3)
          ORDER BY m.sent_at DESC,m.chatwoot_message_id DESC LIMIT 1
       ) latest ON true
       LEFT JOIN LATERAL (
         SELECT m.content
           FROM core.messages m
          WHERE m.environment=c.environment AND m.conversation_id=c.id
            AND m.sender_type='contact' AND NOT m.is_private AND m.deleted_at IS NULL
          ORDER BY m.sent_at DESC,m.chatwoot_message_id DESC LIMIT 1
       ) customer ON true
      WHERE c.environment=$1 AND c.deleted_at IS NULL
        AND c.current_status IN ('open','pending')
        AND latest.sender_type<>'contact'
        AND ($2::boolean OR c.id::text=ANY($3::text[]))
      ORDER BY latest.sent_at ASC
      LIMIT $4`,
    [environment, hasAgentV2Wildcard(allowedConversationIds),
      allowedConversationIds.filter((id) => id !== '*'), BATCH_SIZE],
  );
  return result.rows;
}

/**
 * Guarda única usada antes de enfileirar e repetida imediatamente antes do HTTP.
 * Qualquer pendência deixa `allowed=false`; indisponibilidade de banco lança erro.
 */
export async function assessResolutionGuard(
  client: PoolClient,
  environment: Environment,
  conversationId: string,
  expectedLastMessageId: string,
  excludedOutboundId: string | null = null,
): Promise<ResolutionGuard> {
  const result = await client.query<ResolutionGuard>(
    `WITH matching_conversation AS (
       SELECT c.id,c.chatwoot_conversation_id
         FROM core.conversations c
        WHERE c.environment=$1 AND c.id=$2 AND c.deleted_at IS NULL
          AND c.current_status IN ('open','pending')
          AND EXISTS (
            SELECT 1 FROM core.messages expected
             WHERE expected.environment=c.environment
               AND expected.conversation_id=c.id AND expected.id=$3
               AND expected.sender_type<>'contact' AND NOT expected.is_private
               AND expected.deleted_at IS NULL
               AND NOT EXISTS (
                 SELECT 1 FROM core.messages newer
                  WHERE newer.environment=expected.environment
                    AND newer.conversation_id=expected.conversation_id
                    AND NOT newer.is_private AND newer.deleted_at IS NULL
                    AND newer.message_type IN (0,1,3)
                    AND (newer.sent_at,newer.chatwoot_message_id)>
                        (expected.sent_at,expected.chatwoot_message_id)
               )
          )
          AND COALESCE((SELECT control.mode FROM ops.conversation_bot_control control
                         WHERE control.environment=c.environment
                           AND control.conversation_id=c.id),'auto')='auto'
     ), linked_orders AS (
       SELECT o.*,
              CASE WHEN o.partner_order_id IS NOT NULL THEN
                po.status<>'cancelled' AND po.deleted_at IS NULL AND
                ((po.fulfillment_mode='delivery' AND po.delivery_status='delivered') OR
                 (po.fulfillment_mode='pickup' AND po.retrieved_at IS NOT NULL))
              ELSE o.status<>'cancelled' AND
                ((o.fulfillment_mode='delivery' AND o.delivery_status='delivered') OR
                 (o.fulfillment_mode='pickup' AND o.retrieved_at IS NOT NULL))
              END AS completed,
              po.status AS partner_status,po.deleted_at AS partner_deleted_at
         FROM commerce.orders o
         LEFT JOIN commerce.partner_orders po
           ON po.environment=o.environment AND po.id=o.partner_order_id
        WHERE o.environment=$1 AND o.source_conversation_id=$2
     ), state AS (
       SELECT EXISTS(SELECT 1 FROM matching_conversation) AS conversation_ok,
              EXISTS(SELECT 1 FROM linked_orders WHERE completed) AS has_completed_order,
              EXISTS(SELECT 1 FROM linked_orders
                      WHERE status<>'cancelled' AND NOT completed) AS has_order_pending,
              EXISTS(SELECT 1 FROM ops.atendente_jobs j
                      WHERE j.environment=$1 AND j.conversation_id=$2
                        AND j.status IN ('pending','processing','failed')) AS has_job_pending,
              EXISTS(SELECT 1 FROM ops.outbound_messages o
                      WHERE o.environment=$1 AND o.conversation_id=$2
                        AND ($4::uuid IS NULL OR o.id<>$4)
                        AND o.status IN ('pending','sending','failed','sent_api_ack')) AS has_outbound_pending,
              EXISTS(SELECT 1 FROM ops.atendente_dead_letters d
                      WHERE d.environment=$1 AND d.conversation_id=$2
                        AND d.resolved_at IS NULL) AS has_dead_letter,
              EXISTS(SELECT 1 FROM agent.escalations e
                      WHERE e.environment=$1 AND e.conversation_id=$2
                        AND e.status IN ('waiting','in_attendance')) AS has_escalation,
              EXISTS(SELECT 1 FROM agent.order_drafts d
                      WHERE d.environment=$1 AND d.conversation_id=$2
                        AND d.draft_status='ready')
              OR EXISTS(SELECT 1 FROM agent.pending_confirmations p
                        WHERE p.environment=$1 AND p.conversation_id=$2
                          AND p.status='open'
                          AND p.confirmation_type='order_confirmation') AS has_checkout_pending,
              EXISTS(SELECT 1 FROM core.conversations c
                      JOIN commerce.photo_requests p
                        ON p.environment=c.environment
                       AND p.conversation_id=c.chatwoot_conversation_id
                      WHERE c.environment=$1 AND c.id=$2
                        AND p.status IN ('pending','answered')) AS has_photo_pending,
              EXISTS(SELECT 1 FROM core.conversations c
                      JOIN commerce.satisfaction_surveys s
                        ON s.environment=c.environment
                       AND s.conversation_id=c.chatwoot_conversation_id
                      WHERE c.environment=$1 AND c.id=$2 AND s.status='pending') AS has_survey_pending,
              EXISTS(
                SELECT 1 FROM linked_orders o
                 WHERE o.completed AND $5::boolean
                   AND NOT EXISTS (
                     SELECT 1 FROM commerce.satisfaction_surveys s
                      WHERE s.environment=o.environment
                        AND (s.order_id=o.id OR
                             (o.partner_order_id IS NOT NULL AND s.partner_order_id=o.partner_order_id))
                   )
              ) AS missing_completed_survey
     )
     SELECT (conversation_ok AND NOT has_order_pending AND NOT has_job_pending
             AND NOT has_outbound_pending AND NOT has_dead_letter AND NOT has_escalation
             AND NOT has_checkout_pending AND NOT has_photo_pending AND NOT has_survey_pending
             AND NOT missing_completed_survey) AS allowed,
            has_completed_order
       FROM state`,
    [environment, conversationId, expectedLastMessageId, excludedOutboundId,
      env.SATISFACTION_SURVEY],
  );
  return result.rows[0] ?? { allowed: false, has_completed_order: false };
}

async function getInboxBusinessHours(inboxId: number): Promise<InboxBusinessHours | null> {
  const cached = inboxCache.get(inboxId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  try {
    const inbox = await new ChatwootApiClient().getInbox(inboxId);
    const value: InboxBusinessHours = {
      enabled: inbox.workingHoursEnabled,
      timezone: inbox.timezone,
      workingHours: inbox.workingHours,
    };
    inboxCache.set(inboxId, { expiresAt: Date.now() + INBOX_CACHE_MS, value });
    return value;
  } catch (err) {
    logger.warn({ err, inbox_id: inboxId }, 'bot auto resolve: horário do inbox indisponível');
    return null;
  }
}

async function chooseReason(
  client: PoolClient,
  candidate: AutoResolveCandidate,
  now: Date,
): Promise<ResolutionReason | null> {
  const guard = await assessResolutionGuard(
    client, env.FAREJADOR_ENV, candidate.conversation_id, candidate.latest_message_id,
  );
  if (!guard.allowed) return null;
  if (guard.has_completed_order) return 'completed_order';
  if (isExplicitDesistance(candidate.latest_customer_text)) return 'explicit_desistance';
  if (candidate.chatwoot_inbox_id == null) return null;
  const hours = await getInboxBusinessHours(candidate.chatwoot_inbox_id);
  return hours && hasElapsedBusinessHours(
    candidate.latest_message_at, now, env.BOT_AUTO_RESOLVE_IDLE_BUSINESS_HOURS, hours,
  ) ? 'inactivity' : null;
}

export async function enqueueConversationResolution(
  client: PoolClient,
  candidate: AutoResolveCandidate,
  reason: ResolutionReason,
): Promise<boolean> {
  await client.query('BEGIN');
  try {
    await lockBotConversation(client, env.FAREJADOR_ENV, candidate.conversation_id);
    const control = await syncHumanIntervention(client, env.FAREJADOR_ENV, candidate.conversation_id);
    const guard = await assessResolutionGuard(
      client, env.FAREJADOR_ENV, candidate.conversation_id, candidate.latest_message_id,
    );
    if (control.mode !== 'auto' || !guard.allowed
        || (reason === 'completed_order' && !guard.has_completed_order)) {
      await client.query('COMMIT');
      return false;
    }
    const body = JSON.stringify({ expected_last_message_id: candidate.latest_message_id, reason });
    const echoId = `resolve:${candidate.conversation_id}:${candidate.latest_message_id}`;
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO ops.outbound_messages (
         environment,conversation_id,chatwoot_conversation_id,echo_id,kind,
         body,body_sha256,status
       ) VALUES ($1,$2,$3,$4,'conversation_resolution',$5,$6,'pending')
       ON CONFLICT (environment,echo_id) WHERE echo_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [env.FAREJADOR_ENV, candidate.conversation_id, candidate.chatwoot_conversation_id,
        echoId, body, sha256(body)],
    );
    if (inserted.rows[0]) await recordOutboundEvent(client, {
      environment: env.FAREJADOR_ENV, outboundId: inserted.rows[0].id,
      toStatus: 'pending', reason: `auto_resolve:${reason}`,
    });
    await client.query('COMMIT');
    return Boolean(inserted.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

export async function validateResolutionOutbound(
  client: PoolClient,
  environment: Environment,
  conversationId: string,
  outboundId: string,
  body: string,
): Promise<boolean> {
  const payload = parseResolutionPayload(body);
  if (!payload) return false;
  const guard = await assessResolutionGuard(
    client, environment, conversationId, payload.expected_last_message_id, outboundId,
  );
  return guard.allowed && (payload.reason !== 'completed_order' || guard.has_completed_order);
}

export async function pollConversationAutoResolve(now = new Date()): Promise<number> {
  const client = await pool.connect();
  try {
    const candidates = await listAutoResolveCandidates(client, env.FAREJADOR_ENV);
    let queued = 0;
    for (const candidate of candidates) {
      const reason = await chooseReason(client, candidate, now);
      if (reason && await enqueueConversationResolution(client, candidate, reason)) queued++;
    }
    return queued;
  } finally {
    client.release();
  }
}

export function startConversationAutoResolveWorker(): () => void {
  if (!env.BOT_AUTO_RESOLVE_ENABLED) return () => undefined;
  if (!env.BOT_OUTBOX) {
    logger.error('bot auto resolve: desativado porque BOT_OUTBOX=false');
    return () => undefined;
  }
  let stopped = false;
  const loop = async (): Promise<void> => {
    if (stopped) return;
    try {
      const queued = await pollConversationAutoResolve();
      if (queued > 0) logger.info({ queued }, 'bot auto resolve: conversas enfileiradas');
    } catch (err) {
      logger.error({ err }, 'bot auto resolve: ciclo falhou');
    }
    if (!stopped) setTimeout(() => void loop(), POLL_MS);
  };
  void loop();
  logger.info({ idle_business_hours: env.BOT_AUTO_RESOLVE_IDLE_BUSINESS_HOURS },
    'bot auto resolve: iniciado');
  return () => { stopped = true; };
}
