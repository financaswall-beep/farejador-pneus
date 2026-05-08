import type { PoolClient } from 'pg';
import type { AgentAction } from '../../shared/zod/agent-actions.js';
import type {
  ConversationState,
  ItemSlotsState,
  OrderDraftState,
  SlotValue,
} from '../../shared/zod/agent-state.js';
import { applyAction } from './apply-action.js';

export class AgentStateVersionConflictError extends Error {
  constructor(conversationId: string, expectedVersion: number) {
    super(`agent_state_version_conflict:${conversationId}:${expectedVersion}`);
    this.name = 'AgentStateVersionConflictError';
  }
}

export async function loadCurrent(
  client: PoolClient,
  environment: string,
  conversationId: string,
): Promise<ConversationState | null> {
  const session = await client.query<{
    environment: 'prod' | 'test';
    conversation_id: string;
    contact_id: string | null;
    status: 'active' | 'paused' | 'escalated' | 'closed';
    current_skill: string | null;
    last_customer_message_id: string | null;
    last_agent_turn_id: string | null;
    version: string;
    turn_index: number;
    updated_at: Date;
    created_at: Date;
  }>(
    `SELECT sc.environment,
            sc.conversation_id,
            c.contact_id,
            sc.status,
            sc.current_skill,
            sc.last_customer_message_id,
            sc.last_agent_turn_id,
            sc.version::text AS version,
            sc.turn_index,
            sc.updated_at,
            sc.created_at
     FROM agent.session_current sc
     JOIN core.conversations c
       ON c.id = sc.conversation_id
      AND c.environment = sc.environment
     WHERE sc.environment = $1
       AND sc.conversation_id = $2`,
    [environment, conversationId],
  );

  const row = session.rows[0];
  if (!row) {
    return null;
  }

  const [items, slots] = await Promise.all([
    client.query<{
      id: string;
      status: 'aberto' | 'ofertado' | 'no_carrinho' | 'descartado';
      is_active: boolean;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT id, status, is_active, created_at, updated_at
       FROM agent.session_items
       WHERE environment = $1
         AND conversation_id = $2
       ORDER BY created_at ASC`,
      [environment, conversationId],
    ),
    client.query<{
      id: string;
      scope: 'global' | 'item';
      item_id: string | null;
      slot_key: string;
      value_json: unknown;
      source: SlotValue['source'];
      confidence: string;
      stale: SlotValue['stale'];
      requires_confirmation: boolean;
      evidence_text: string | null;
      set_by_message_id: string | null;
      set_by_skill: string | null;
      previous_value_json: unknown | null;
      set_at: Date;
    }>(
      `SELECT id, scope, item_id, slot_key, value_json, source,
              confidence::text AS confidence, stale, requires_confirmation,
              evidence_text, set_by_message_id, set_by_skill, previous_value_json, set_at
       FROM agent.session_slots
       WHERE environment = $1
         AND conversation_id = $2
       ORDER BY set_at ASC`,
      [environment, conversationId],
    ),
  ]);

  const [events, pendingConfirmation, cartItems] = await Promise.all([
    client.query<{
      event_type: string;
      event_payload: Record<string, unknown>;
      occurred_at: Date;
    }>(
      `SELECT event_type, event_payload, occurred_at
       FROM agent.session_events
       WHERE environment = $1
         AND conversation_id = $2
       ORDER BY occurred_at ASC`,
      [environment, conversationId],
    ),
    client.query<{
      id: string;
      confirmation_type: string;
      expected_facts: Record<string, unknown>;
      status: string;
      expires_at: Date;
    }>(
      `SELECT id, confirmation_type, expected_facts, status, expires_at
       FROM agent.pending_confirmations
       WHERE environment = $1
         AND conversation_id = $2
         AND status = 'open'
       ORDER BY created_at DESC
       LIMIT 1`,
      [environment, conversationId],
    ),
    client.query<{
      id: string;
      product_id: string;
      quantity: number;
      unit_price: string | null;
      item_status: 'proposed' | 'confirmed' | 'removed';
    }>(
      `SELECT ci.id, ci.product_id, ci.quantity, ci.unit_price::text AS unit_price, ci.item_status
       FROM agent.cart_current cc
       JOIN agent.cart_current_items ci
         ON ci.cart_id = cc.id
        AND ci.environment = cc.environment
       WHERE cc.environment = $1
         AND cc.conversation_id = $2
         AND ci.item_status != 'removed'
       ORDER BY ci.created_at ASC`,
      [environment, conversationId],
    ),
  ]);

  const orderDraft = await client.query<{
    customer_name: string | null;
    delivery_address: string | null;
    geo_resolution_id: string | null;
    fulfillment_mode: 'delivery' | 'pickup' | null;
    payment_method: OrderDraftState['payment_method'];
    draft_status: OrderDraftState['draft_status'];
    promoted_order_id: string | null;
    promoted_by: string | null;
    promoted_at: Date | null;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT customer_name, delivery_address, geo_resolution_id,
            fulfillment_mode, payment_method, draft_status,
            promoted_order_id, promoted_by, promoted_at, created_at, updated_at
     FROM agent.order_drafts
     WHERE environment = $1
       AND conversation_id = $2`,
    [environment, conversationId],
  );

  const stateItems = items.rows.map((item) => ({
    id: item.id,
    conversation_id: conversationId,
    status: item.status,
    is_active: item.is_active,
    created_at: item.created_at.toISOString(),
    updated_at: item.updated_at.toISOString(),
    slots: {},
  }));

  const state: ConversationState = {
    schema_version: 'atendente_v1.0',
    environment: row.environment,
    conversation_id: row.conversation_id,
    contact_id: row.contact_id,
    status: row.status,
    current_skill: row.current_skill,
    last_customer_message_id: row.last_customer_message_id,
    last_agent_turn_id: row.last_agent_turn_id,
    last_processed_message_id: row.last_customer_message_id,
    version: Number(row.version),
    turn_index: row.turn_index,
    items: stateItems,
    global_slots: {},
    cart: cartItems.rows.map((item) => ({
      id: item.id,
      product_id: item.product_id,
      quantity: item.quantity,
      unit_price: item.unit_price === null ? null : Number(item.unit_price),
      item_status: item.item_status,
    })),
    order_draft: orderDraft.rows[0]
      ? {
          customer_name: orderDraft.rows[0].customer_name,
          delivery_address: orderDraft.rows[0].delivery_address,
          geo_resolution_id: orderDraft.rows[0].geo_resolution_id,
          fulfillment_mode: orderDraft.rows[0].fulfillment_mode,
          payment_method: orderDraft.rows[0].payment_method,
          draft_status: orderDraft.rows[0].draft_status,
          promoted_order_id: orderDraft.rows[0].promoted_order_id,
          promoted_by: orderDraft.rows[0].promoted_by,
          promoted_at: orderDraft.rows[0].promoted_at?.toISOString() ?? null,
          created_at: orderDraft.rows[0].created_at.toISOString(),
          updated_at: orderDraft.rows[0].updated_at.toISOString(),
        }
      : null,
    pending_confirmation: pendingConfirmation.rows[0]
      ? {
          id: pendingConfirmation.rows[0].id,
          confirmation_type: pendingConfirmation.rows[0].confirmation_type,
          expected_facts: pendingConfirmation.rows[0].expected_facts,
          status: pendingConfirmation.rows[0].status,
          expires_at: pendingConfirmation.rows[0].expires_at.toISOString(),
        }
      : null,
    last_offer: null,
    derived_signals: {
      missing_for_close: [],
      stale_slots: [],
      recent_objections: [],
      has_pending_human_request: false,
      offer_expired: false,
    },
    updated_at: row.updated_at.toISOString(),
    created_at: row.created_at.toISOString(),
  };

  for (const slot of slots.rows) {
    const stateSlot: SlotValue = {
      id: slot.id,
      conversation_id: conversationId,
      scope: slot.scope,
      item_id: slot.item_id,
      slot_key: slot.slot_key as SlotValue['slot_key'],
      value_json: slot.value_json,
      source: slot.source,
      confidence: Number(slot.confidence),
      stale: slot.stale,
      requires_confirmation: slot.requires_confirmation,
      evidence_text: slot.evidence_text,
      set_by_message_id: slot.set_by_message_id,
      set_by_skill: slot.set_by_skill,
      previous_value_json: slot.previous_value_json,
      set_at: slot.set_at.toISOString(),
    };

    if (slot.scope === 'global') {
      state.global_slots[slot.slot_key as keyof typeof state.global_slots] = stateSlot;
    } else if (slot.item_id) {
      const item = state.items.find((candidate) => candidate.id === slot.item_id);
      if (item) {
        item.slots[slot.slot_key as keyof typeof item.slots] = stateSlot;
      }
    }

    if (slot.stale !== 'fresh' && !state.derived_signals.stale_slots.includes(slot.slot_key)) {
      state.derived_signals.stale_slots.push(slot.slot_key);
    }
  }

  for (const event of events.rows) {
    if (event.event_type === 'objection_raised') {
      const objection = event.event_payload?.action && typeof event.event_payload.action === 'object'
        ? (event.event_payload.action as { objection_type?: unknown }).objection_type
        : undefined;
      if (typeof objection === 'string' && !state.derived_signals.recent_objections.includes(objection)) {
        state.derived_signals.recent_objections.push(objection);
      }
    }

    if (event.event_type === 'human_requested') {
      state.derived_signals.has_pending_human_request = true;
    }

    if (event.event_type === 'offer_made') {
      const action = event.event_payload?.action as
        | {
            offer_id?: unknown;
            item_id?: unknown;
            products?: unknown;
            expires_at?: unknown;
          }
        | undefined;
      if (
        action &&
        typeof action.offer_id === 'string' &&
        typeof action.item_id === 'string' &&
        Array.isArray(action.products) &&
        typeof action.expires_at === 'string'
      ) {
        state.last_offer = {
          offer_id: action.offer_id,
          item_id: action.item_id,
          products: action.products as Record<string, unknown>[],
          expires_at: action.expires_at,
          invalidated: false,
          invalidation_reason: null,
        };
      }
    }

    if (event.event_type === 'offer_invalidated' && state.last_offer) {
      state.last_offer.invalidated = true;
      const reason = event.event_payload?.reason;
      state.last_offer.invalidation_reason = typeof reason === 'string' ? reason : 'invalidated';
    }
  }

  return state;
}

/**
 * Aplica e persiste action **assumindo que já existe transação ativa no client**.
 * Use quando o caller (ex: worker) controla BEGIN/COMMIT.
 *
 * Retorna o estado novo com version incrementada. Lança
 * AgentStateVersionConflictError se outra escrita avançou a versão.
 */
export async function applyActionAndPersistInTx(
  client: PoolClient,
  state: ConversationState,
  action: AgentAction,
): Promise<ConversationState> {
  if ('action_id' in action) {
    const existing = await client.query(
      `SELECT 1
       FROM agent.session_events
       WHERE action_id = $1
       LIMIT 1`,
      [action.action_id],
    );
    if (existing.rowCount && existing.rowCount > 0) {
      return state;
    }
  }

  const result = applyAction(state, action);
  const nextVersion = state.version + 1;

  const update = await client.query(
    `UPDATE agent.session_current
     SET version = version + 1,
         turn_index = GREATEST(turn_index, $3),
         current_skill = $4,
         status = $5,
         updated_at = $6
     WHERE environment = $1
       AND conversation_id = $2
       AND version = $7`,
    [
      state.environment,
      state.conversation_id,
      result.state.turn_index,
      result.state.current_skill,
      result.state.status,
      result.state.updated_at,
      state.version,
    ],
  );

  if (update.rowCount !== 1) {
    throw new AgentStateVersionConflictError(state.conversation_id, state.version);
  }

  await syncSessionItems(client, result.state);
  await syncSessionSlots(client, result.state);
  await persistOperationalState(client, state, result.state, action);

  for (const event of result.events_to_emit) {
    await client.query(
      `INSERT INTO agent.session_events
         (environment, conversation_id, action_id, turn_index, event_type,
          skill_name, event_payload, resulting_state_version, emitted_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (action_id) DO NOTHING`,
      [
        state.environment,
        state.conversation_id,
        event.action_id ?? null,
        result.state.turn_index,
        event.event_type,
        result.state.current_skill,
        JSON.stringify(event.event_payload),
        nextVersion,
        event.emitted_by ?? null,
      ],
    );
  }

  return { ...result.state, version: nextVersion };
}

/**
 * Versão pública que abre/encerra própria transação. Mantida para
 * callers que não controlam tx (testes, scripts ad-hoc).
 *
 * Idempotência: se action_id já existe em session_events, retorna estado
 * de entrada sem abrir transação (no-op silencioso).
 */
export async function applyActionAndPersist(
  client: PoolClient,
  state: ConversationState,
  action: AgentAction,
): Promise<ConversationState> {
  if ('action_id' in action) {
    const existing = await client.query(
      `SELECT 1
       FROM agent.session_events
       WHERE action_id = $1
       LIMIT 1`,
      [action.action_id],
    );
    if (existing.rowCount && existing.rowCount > 0) {
      return state;
    }
  }

  await client.query('BEGIN');
  try {
    const next = await applyActionAndPersistInTx(client, state, action);
    await client.query('COMMIT');
    return next;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function persistOperationalState(
  client: PoolClient,
  previous: ConversationState,
  next: ConversationState,
  action: AgentAction,
): Promise<void> {
  switch (action.type) {
    case 'add_to_cart':
    case 'remove_from_cart':
    case 'update_cart_item':
    case 'clear_cart':
      await syncCart(client, previous, next, action);
      return;
    case 'update_draft':
      await syncOrderDraft(client, next);
      return;
    case 'request_confirmation':
      await syncPendingConfirmation(client, next);
      return;
    case 'escalate':
      await syncEscalation(client, next, action);
      return;
    default:
      return;
  }
}

function estimateCartTotal(state: ConversationState): number | null {
  const activeItems = state.cart.filter((item) => item.item_status !== 'removed');
  if (activeItems.length === 0 || activeItems.some((item) => item.unit_price === null)) {
    return null;
  }
  return activeItems.reduce((total, item) => total + (item.unit_price ?? 0) * item.quantity, 0);
}

async function ensureCartCurrent(client: PoolClient, state: ConversationState): Promise<string> {
  const activeItems = state.cart.filter((item) => item.item_status !== 'removed');
  const cartStatus = activeItems.length > 0 ? 'proposed' : 'empty';
  const estimatedTotal = estimateCartTotal(state);
  const cart = await client.query<{ id: string }>(
    `INSERT INTO agent.cart_current
       (environment, conversation_id, cart_status, estimated_total, updated_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (environment, conversation_id) DO UPDATE
     SET cart_status = EXCLUDED.cart_status,
         estimated_total = EXCLUDED.estimated_total,
         updated_at = EXCLUDED.updated_at
     RETURNING id`,
    [state.environment, state.conversation_id, cartStatus, estimatedTotal, state.updated_at],
  );
  return cart.rows[0]!.id;
}

async function syncCart(
  client: PoolClient,
  previous: ConversationState,
  next: ConversationState,
  action: AgentAction,
): Promise<void> {
  const cartId = await ensureCartCurrent(client, next);
  const activeIds = new Set(
    next.cart.filter((item) => item.item_status !== 'removed').map((item) => item.id),
  );

  await client.query(
    `UPDATE agent.cart_current_items
     SET item_status = 'removed', updated_at = $3
     WHERE environment = $1
       AND cart_id = $2
       AND item_status != 'removed'
       AND NOT (id = ANY($4::uuid[]))`,
    [next.environment, cartId, next.updated_at, [...activeIds]],
  );

  for (const item of next.cart.filter((candidate) => candidate.item_status !== 'removed')) {
    await client.query(
      `INSERT INTO agent.cart_current_items
         (id, environment, cart_id, product_id, quantity, unit_price, item_status, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, 'proposed'), $8)
       ON CONFLICT (id) DO UPDATE
       SET quantity = EXCLUDED.quantity,
           unit_price = EXCLUDED.unit_price,
           item_status = EXCLUDED.item_status,
           updated_at = EXCLUDED.updated_at`,
      [
        item.id,
        next.environment,
        cartId,
        item.product_id,
        item.quantity,
        item.unit_price,
        item.item_status ?? 'proposed',
        next.updated_at,
      ],
    );
  }

  const { eventType, affectedItemId } = cartEventFor(previous, next, action);
  await client.query(
    `INSERT INTO agent.cart_events
       (environment, conversation_id, event_type, affected_item_id, event_payload, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      next.environment,
      next.conversation_id,
      eventType,
      affectedItemId,
      JSON.stringify({ action }),
      next.updated_at,
    ],
  );
}

function cartEventFor(
  previous: ConversationState,
  next: ConversationState,
  action: AgentAction,
): { eventType: 'proposed' | 'removed' | 'replaced' | 'updated' | 'cleared'; affectedItemId: string | null } {
  switch (action.type) {
    case 'add_to_cart': {
      const item = next.cart.find(
        (candidate) => candidate.product_id === action.product_id && candidate.item_status !== 'removed',
      );
      return { eventType: 'proposed', affectedItemId: item?.id ?? null };
    }
    case 'remove_from_cart':
      return { eventType: 'removed', affectedItemId: action.cart_item_id };
    case 'update_cart_item':
      return { eventType: 'updated', affectedItemId: action.cart_item_id };
    case 'clear_cart':
      return { eventType: 'cleared', affectedItemId: null };
    default:
      return { eventType: previous.cart.length === next.cart.length ? 'replaced' : 'proposed', affectedItemId: null };
  }
}

async function syncOrderDraft(client: PoolClient, state: ConversationState): Promise<void> {
  if (!state.order_draft) return;
  await client.query(
    `INSERT INTO agent.order_drafts
       (environment, conversation_id, customer_name, delivery_address, geo_resolution_id,
        fulfillment_mode, payment_method, draft_status, promoted_order_id,
        promoted_by, promoted_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (environment, conversation_id) DO UPDATE
     SET customer_name = EXCLUDED.customer_name,
         delivery_address = EXCLUDED.delivery_address,
         geo_resolution_id = EXCLUDED.geo_resolution_id,
         fulfillment_mode = EXCLUDED.fulfillment_mode,
         payment_method = EXCLUDED.payment_method,
         draft_status = EXCLUDED.draft_status,
         promoted_order_id = EXCLUDED.promoted_order_id,
         promoted_by = EXCLUDED.promoted_by,
         promoted_at = EXCLUDED.promoted_at,
         updated_at = EXCLUDED.updated_at`,
    [
      state.environment,
      state.conversation_id,
      state.order_draft.customer_name,
      state.order_draft.delivery_address,
      state.order_draft.geo_resolution_id,
      state.order_draft.fulfillment_mode,
      state.order_draft.payment_method,
      state.order_draft.draft_status,
      state.order_draft.promoted_order_id,
      state.order_draft.promoted_by,
      state.order_draft.promoted_at,
      state.order_draft.updated_at,
    ],
  );
}

async function syncPendingConfirmation(client: PoolClient, state: ConversationState): Promise<void> {
  if (!state.pending_confirmation) return;
  const questionMessageId = state.last_customer_message_id ?? state.conversation_id;
  await client.query(
    `INSERT INTO agent.pending_confirmations
       (id, environment, conversation_id, confirmation_type, expected_facts,
        question_message_id, status, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (id) DO UPDATE
     SET expected_facts = EXCLUDED.expected_facts,
         status = EXCLUDED.status,
         expires_at = EXCLUDED.expires_at`,
    [
      state.pending_confirmation.id,
      state.environment,
      state.conversation_id,
      state.pending_confirmation.confirmation_type,
      JSON.stringify(state.pending_confirmation.expected_facts),
      questionMessageId,
      state.pending_confirmation.status,
      state.pending_confirmation.expires_at,
    ],
  );
}

async function syncEscalation(
  client: PoolClient,
  state: ConversationState,
  action: Extract<AgentAction, { type: 'escalate' }>,
): Promise<void> {
  await client.query(
    `INSERT INTO agent.escalations
       (environment, conversation_id, reason, summary_text, escalated_at)
     SELECT $1::env_t, $2, $3, $4, $5
     WHERE NOT EXISTS (
       SELECT 1
       FROM agent.escalations
       WHERE environment = $1::env_t
         AND conversation_id = $2
         AND reason = $3
         AND status IN ('waiting', 'in_attendance')
     )`,
    [state.environment, state.conversation_id, action.reason, action.summary_text, state.updated_at],
  );
}

async function syncSessionItems(client: PoolClient, state: ConversationState): Promise<void> {
  for (const item of state.items) {
    await client.query(
      `INSERT INTO agent.session_items
         (id, environment, conversation_id, status, is_active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE
       SET status = EXCLUDED.status,
           is_active = EXCLUDED.is_active,
           updated_at = EXCLUDED.updated_at`,
      [
        item.id,
        state.environment,
        state.conversation_id,
        item.status,
        item.is_active,
        item.created_at,
        item.updated_at ?? state.updated_at,
      ],
    );
  }
}

async function syncSessionSlots(client: PoolClient, state: ConversationState): Promise<void> {
  await client.query(
    `DELETE FROM agent.session_slots
     WHERE environment = $1
       AND conversation_id = $2`,
    [state.environment, state.conversation_id],
  );

  for (const [slotKey, slot] of Object.entries(state.global_slots)) {
    if (slot) {
      await insertSlot(client, state, slotKey, slot);
    }
  }

  for (const item of state.items) {
    for (const [slotKey, slot] of Object.entries(item.slots as ItemSlotsState)) {
      if (slot) {
        await insertSlot(client, state, slotKey, slot);
      }
    }
  }
}

async function insertSlot(
  client: PoolClient,
  state: ConversationState,
  slotKey: string,
  slot: SlotValue,
): Promise<void> {
  await client.query(
    `INSERT INTO agent.session_slots
       (environment, conversation_id, scope, item_id, slot_key, value_json,
        source, confidence, stale, requires_confirmation, evidence_text,
        set_by_message_id, set_by_skill, previous_value_json, set_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
    [
      state.environment,
      state.conversation_id,
      slot.scope,
      slot.item_id,
      slotKey,
      JSON.stringify(slot.value_json),
      slot.source,
      slot.confidence,
      slot.stale,
      slot.requires_confirmation,
      slot.evidence_text ?? null,
      slot.set_by_message_id ?? null,
      slot.set_by_skill ?? null,
      slot.previous_value_json === undefined ? null : JSON.stringify(slot.previous_value_json),
      slot.set_at,
    ],
  );
}
