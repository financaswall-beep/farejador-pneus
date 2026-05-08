import type { PoolClient } from 'pg';
import type { Environment } from '../../shared/types/chatwoot.js';
import type { ConversationState } from '../../shared/zod/agent-state.js';
import { env } from '../../shared/config/env.js';
import { loadCurrent } from '../state/agent-state.repository.js';
import type { ToolName } from './schemas.js';

export interface PlannerMessage {
  id: string;
  role: 'customer' | 'agent' | 'system';
  text: string;
  sent_at: string;
}

export interface ToolResultSummary {
  tool: ToolName;
  ok: boolean;
  summary: string;
  occurred_at: string;
}

export interface OrganizerFactSummary {
  fact_key: string;
  fact_value: unknown;
  observed_at: string | null;
  message_id: string | null;
  truth_type: string;
  source: string;
  confidence_level: number | null;
  extractor_version: string;
  latest_evidence_text: string | null;
  latest_evidence_message_id: string | null;
  latest_evidence_type: string | null;
}

export interface PlannerContext {
  environment: Environment;
  conversation_id: string;
  state: ConversationState;
  recent_messages: PlannerMessage[];
  available_tools: ToolName[];
  recent_tool_results: ToolResultSummary[];
  organizer_facts: OrganizerFactSummary[];
  derived_signals: ConversationState['derived_signals'];
}

export async function buildPlannerContext(
  client: PoolClient,
  environment: Environment,
  conversationId: string,
  triggerMessageId?: string,
): Promise<PlannerContext> {
  const state = await loadCurrent(client, environment, conversationId);
  if (!state) {
    throw new Error(`planner_context_missing_state:${conversationId}`);
  }

  const messages = await client.query<{
    id: string;
    sender_type: string;
    message_type: string;
    content: string;
    sent_at: Date;
  }>(
    `SELECT id, sender_type, message_type, content, sent_at
     FROM core.messages
     WHERE environment = $1
       AND conversation_id = $2
       AND is_private = false
       AND content IS NOT NULL
     AND content != ''
     AND ($3::uuid IS NULL OR sent_at <= (SELECT sent_at FROM core.messages WHERE id = $3::uuid))
     ORDER BY sent_at DESC
     LIMIT $4`,
    [environment, conversationId, triggerMessageId ?? null, env.ATENDENTE_CONTEXT_MESSAGES_LIMIT],
  );
  const toolEvents = await client.query<{
    event_type: 'tool_executed' | 'tool_failed';
    event_payload: Record<string, unknown>;
    occurred_at: Date;
  }>(
    `SELECT event_type, event_payload, occurred_at
     FROM agent.session_events
     WHERE environment = $1
       AND conversation_id = $2
       AND event_type IN ('tool_executed', 'tool_failed')
     ORDER BY occurred_at DESC
     LIMIT $3`,
    [environment, conversationId, env.ATENDENTE_CONTEXT_TOOL_EVENTS_LIMIT],
  );
  const organizerFacts = await client.query<{
    fact_key: string;
    fact_value: unknown;
    observed_at: Date | null;
    message_id: string | null;
    truth_type: string;
    source: string;
    confidence_level: number | null;
    extractor_version: string;
    latest_evidence_text: string | null;
    latest_evidence_message_id: string | null;
    latest_evidence_type: string | null;
  }>(
    `SELECT fact_key,
            fact_value,
            observed_at,
            message_id,
            truth_type,
            source,
            confidence_level::float8 AS confidence_level,
            extractor_version,
            latest_evidence_text,
            latest_evidence_message_id,
            latest_evidence_type
     FROM analytics.current_facts
     WHERE environment = $1
       AND conversation_id = $2
     ORDER BY observed_at DESC NULLS LAST, fact_key ASC
     LIMIT $3`,
    [environment, conversationId, env.ATENDENTE_CONTEXT_ORGANIZER_FACTS_LIMIT],
  );

  return {
    environment,
    conversation_id: conversationId,
    state,
    recent_messages: messages.rows.reverse().map((message) => ({
      id: message.id,
      role: mapSenderRole(message.sender_type),
      text: message.content,
      sent_at: message.sent_at.toISOString(),
    })),
    available_tools: [
      'buscarProduto',
      'verificarEstoque',
      'buscarCompatibilidade',
      'calcularFrete',
      'buscarPoliticaComercial',
    ],
    recent_tool_results: toolEvents.rows.reverse().flatMap((row) => {
      const tool = row.event_payload.tool;
      if (!isToolName(tool)) return [];
      return [
        {
          tool,
          ok: row.event_type === 'tool_executed',
          summary: JSON.stringify(row.event_payload).slice(0, 500),
          occurred_at: row.occurred_at.toISOString(),
        },
      ];
    }),
    organizer_facts: organizerFacts.rows.map((fact) => ({
      fact_key: fact.fact_key,
      fact_value: fact.fact_value,
      observed_at: fact.observed_at?.toISOString() ?? null,
      message_id: fact.message_id,
      truth_type: fact.truth_type,
      source: fact.source,
      confidence_level: fact.confidence_level,
      extractor_version: fact.extractor_version,
      latest_evidence_text: fact.latest_evidence_text,
      latest_evidence_message_id: fact.latest_evidence_message_id,
      latest_evidence_type: fact.latest_evidence_type,
    })),
    derived_signals: state.derived_signals,
  };
}

function mapSenderRole(senderType: string): PlannerMessage['role'] {
  if (senderType === 'contact') return 'customer';
  if (senderType === 'user' || senderType === 'agent') return 'agent';
  return 'system';
}

function isToolName(value: unknown): value is ToolName {
  return (
    value === 'buscarProduto' ||
    value === 'verificarEstoque' ||
    value === 'buscarCompatibilidade' ||
    value === 'calcularFrete' ||
    value === 'buscarPoliticaComercial'
  );
}
