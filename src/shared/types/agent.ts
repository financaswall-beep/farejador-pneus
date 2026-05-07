/**
 * Canonical TypeScript types for the `agent.*` schema (Fase 3).
 *
 * Rules:
 * - These are PLAIN interfaces derived directly from the SQL tables in 0016_agent_layer.sql.
 * - Do NOT add business logic here — this file is a 1:1 mirror of the DB columns.
 * - Timestamps are `Date` in memory; repositories handle ISO↔Date conversion.
 * - UUID columns are `string` typed (we never parse UUID parts in TS).
 * - Logical FKs to core.messages (partitioned table) are `string | null`, no referential type.
 */

import type { Environment } from './chatwoot.js';

// ------------------------------------------------------------------
// agent.session_current
// ------------------------------------------------------------------

export type SessionStatus = 'active' | 'paused' | 'escalated' | 'closed';

export interface SessionCurrent {
  id: string;
  environment: Environment;
  conversation_id: string;
  status: SessionStatus;
  current_skill: string | null;
  /** Logical FK → core.messages(id). Partitioned table — no REFERENCES. */
  last_customer_message_id: string | null;
  last_agent_turn_id: string | null;
  updated_at: Date;
  created_at: Date;
}

// ------------------------------------------------------------------
// agent.session_events
// ------------------------------------------------------------------

export type SessionEventType =
  | 'skill_selected'
  | 'confirmation_requested'
  | 'cart_proposed'
  | 'human_called'
  | 'bot_resumed'
  | 'session_paused'
  | 'session_closed'
  | 'fact_corrected'
  | 'escalation_created';

export interface SessionEvent {
  id: string;
  environment: Environment;
  conversation_id: string;
  event_type: SessionEventType;
  skill_name: string | null;
  event_payload: Record<string, unknown>;
  occurred_at: Date;
}

// ------------------------------------------------------------------
// agent.turns
// ------------------------------------------------------------------

export type TurnStatus = 'generated' | 'validated' | 'delivered' | 'failed' | 'blocked';

export interface Turn {
  id: string;
  environment: Environment;
  conversation_id: string;
  /** Logical FK → core.messages(id). */
  trigger_message_id: string;
  selected_skill: string | null;
  agent_version: string;
  context_hash: string;
  say_text: string | null;
  /** JSON array of AgentAction (see zod/agent-actions.ts). */
  actions: unknown[];
  /** Candidate text kept only when status='blocked'. */
  blocked_say_text: string | null;
  /** Candidate actions kept only when status='blocked'. */
  blocked_actions: unknown[];
  /** Audit snapshot for blocked turns. */
  blocked_payload: Record<string, unknown> | null;
  status: TurnStatus;
  /** Logical FK → core.messages(id). */
  delivered_message_id: string | null;
  llm_duration_ms: number | null;
  llm_input_tokens: number | null;
  llm_output_tokens: number | null;
  error_message: string | null;
  created_at: Date;
}

// ------------------------------------------------------------------
// agent.pending_confirmations
// ------------------------------------------------------------------

export type ConfirmationType =
  | 'fact_confirmation'
  | 'cart_confirmation'
  | 'order_confirmation'
  | 'fitment_confirmation';

export type ConfirmationStatus = 'open' | 'resolved' | 'expired' | 'cancelled';

export interface PendingConfirmation {
  id: string;
  environment: Environment;
  conversation_id: string;
  confirmation_type: ConfirmationType;
  expected_facts: Record<string, unknown>;
  /** Logical FK → core.messages(id). */
  question_message_id: string;
  status: ConfirmationStatus;
  expires_at: Date;
  /** Logical FK → core.messages(id). */
  resolved_by_message_id: string | null;
  resolved_at: Date | null;
  created_at: Date;
}

// ------------------------------------------------------------------
// agent.cart_current
// ------------------------------------------------------------------

export type CartStatus = 'empty' | 'proposed' | 'confirmed' | 'validated' | 'promoted';

export interface CartCurrent {
  id: string;
  environment: Environment;
  conversation_id: string;
  cart_status: CartStatus;
  estimated_total: string | null; // NUMERIC returned as string by pg driver
  updated_at: Date;
  created_at: Date;
}

// ------------------------------------------------------------------
// agent.cart_current_items
// ------------------------------------------------------------------

export type CartItemStatus = 'proposed' | 'confirmed' | 'removed';

export interface CartCurrentItem {
  id: string;
  environment: Environment;
  cart_id: string;
  product_id: string;
  quantity: number;
  unit_price: string | null; // NUMERIC
  item_status: CartItemStatus;
  created_at: Date;
  updated_at: Date;
}

// ------------------------------------------------------------------
// agent.cart_events
// ------------------------------------------------------------------

export type CartEventType =
  | 'proposed'
  | 'confirmed'
  | 'validated'
  | 'promoted'
  | 'removed'
  | 'replaced'
  | 'cleared';

export interface CartEvent {
  id: string;
  environment: Environment;
  conversation_id: string;
  event_type: CartEventType;
  affected_item_id: string | null;
  event_payload: Record<string, unknown>;
  occurred_at: Date;
}

// ------------------------------------------------------------------
// agent.order_drafts
// ------------------------------------------------------------------

export type FulfillmentMode = 'delivery' | 'pickup';
export type DraftStatus = 'collecting' | 'ready' | 'promoted' | 'abandoned';

export interface OrderDraft {
  id: string;
  environment: Environment;
  conversation_id: string;
  customer_name: string | null;
  delivery_address: string | null;
  geo_resolution_id: string | null;
  fulfillment_mode: FulfillmentMode | null;
  payment_method: string | null;
  draft_status: DraftStatus;
  promoted_order_id: string | null;
  promoted_by: string | null;
  promoted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

// ------------------------------------------------------------------
// agent.escalations
// ------------------------------------------------------------------

export type EscalationReason =
  | 'ready_to_close'
  | 'customer_requested'
  | 'validator_blocked'
  | 'confidence_low'
  | 'pending_expired'
  | 'other';

export type EscalationStatus = 'waiting' | 'in_attendance' | 'resolved' | 'returned_to_bot';

export interface Escalation {
  id: string;
  environment: Environment;
  conversation_id: string;
  reason: EscalationReason;
  status: EscalationStatus;
  summary_text: string | null;
  chatwoot_note_id: string | null;
  escalated_at: Date;
  resolved_at: Date | null;
  resolved_by: string | null;
  created_at: Date;
}

// ------------------------------------------------------------------
// View: agent.pending_human_closures
// ------------------------------------------------------------------

export interface PendingHumanClosure {
  escalation_id: string;
  environment: Environment;
  conversation_id: string;
  reason: EscalationReason;
  summary_text: string | null;
  escalated_at: Date;
  customer_name: string | null;
  delivery_address: string | null;
  fulfillment_mode: FulfillmentMode | null;
  payment_method: string | null;
  estimated_total: string | null;
}
