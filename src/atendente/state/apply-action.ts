import type {
  AddObjectionAction,
  AddToCartAction,
  AgentAction,
  ClearCartAction,
  CreateItemAction,
  EscalateAction,
  InvalidateOfferAction,
  MarkSlotStaleAction,
  RecordOfferAction,
  RemoveFromCartAction,
  RequestConfirmationAction,
  SelectSkillAction,
  SetActiveItemAction,
  UnsupportedObservationAction,
  UpdateCartItemAction,
  UpdateDraftAction,
  UpdateItemStatusAction,
  UpdateSlotAction,
} from '../../shared/zod/agent-actions.js';
import type {
  ConversationState,
  ItemSlotKey,
  SessionItem,
  SlotValue,
} from '../../shared/zod/agent-state.js';
import { INVALIDATION_RULES, staleLevelForAction } from './invalidation-rules.js';

export interface SessionEventInsert {
  action_id?: string;
  event_type: string;
  event_payload: Record<string, unknown>;
  emitted_by?: 'generator' | 'system' | 'human_override';
}

export interface ApplyResult {
  state: ConversationState;
  events_to_emit: SessionEventInsert[];
}

function cloneState(state: ConversationState): ConversationState {
  return structuredClone(state);
}

function touch(state: ConversationState, action: AgentAction): void {
  state.updated_at = actionTimestamp(state, action);
}

function actionTimestamp(state: ConversationState, action: AgentAction): string {
  return 'emitted_at' in action ? action.emitted_at : state.updated_at;
}

function deterministicId(state: ConversationState, action: AgentAction, suffix: string): string {
  if ('action_id' in action) {
    return action.action_id;
  }

  // Deterministic UUID-ish value for legacy actions. It is not cryptographic;
  // it only preserves applyAction purity until legacy actions gain action_id.
  const input = `${state.conversation_id}:${suffix}:${JSON.stringify(action)}`;
  let hash = 0;
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 31 + input.charCodeAt(index)) >>> 0;
  }
  const hex = hash.toString(16).padStart(8, '0');
  return `${hex}-0000-4000-8000-000000000000`;
}

function addSeconds(isoTimestamp: string, seconds: number): string {
  return new Date(Date.parse(isoTimestamp) + seconds * 1000).toISOString();
}

function draftStatusFor(action: UpdateDraftAction, current?: ConversationState['order_draft']): 'collecting' | 'ready' {
  const customerName = action.customer_name ?? current?.customer_name ?? null;
  const deliveryAddress = action.delivery_address ?? current?.delivery_address ?? null;
  const fulfillmentMode = action.fulfillment_mode ?? current?.fulfillment_mode ?? null;
  const paymentMethod = action.payment_method ?? current?.payment_method ?? null;

  if (!customerName || !fulfillmentMode || !paymentMethod) {
    return 'collecting';
  }
  if (fulfillmentMode === 'delivery' && !deliveryAddress) {
    return 'collecting';
  }
  return 'ready';
}

function eventFor(action: AgentAction, eventType: string, payload?: Record<string, unknown>): SessionEventInsert {
  return {
    action_id: 'action_id' in action ? action.action_id : undefined,
    event_type: eventType,
    event_payload: payload ?? { action },
    emitted_by: 'emitted_by' in action ? action.emitted_by : undefined,
  };
}

function findItem(state: ConversationState, itemId: string): SessionItem & { slots?: Partial<Record<ItemSlotKey, SlotValue>> } {
  const item = state.items.find((candidate) => candidate.id === itemId);
  if (!item) {
    throw new Error(`item_not_found:${itemId}`);
  }
  return item;
}

function activeItem(state: ConversationState): (SessionItem & { slots?: Partial<Record<ItemSlotKey, SlotValue>> }) | null {
  return state.items.find((item) => item.is_active) ?? null;
}

function setSlot(state: ConversationState, action: UpdateSlotAction): SlotValue | null {
  const slot: SlotValue = {
    scope: action.scope,
    item_id: action.item_id,
    slot_key: action.slot_key,
    value_json: action.value,
    source: action.source,
    confidence: action.confidence,
    stale: 'fresh',
    requires_confirmation:
      action.source === 'inferred' ||
      action.source === 'inferred_from_history' ||
      action.source === 'inferred_from_organizadora',
    evidence_text: action.evidence_text ?? null,
    set_by_message_id: action.set_by_message_id ?? null,
    set_by_skill: action.set_by_skill ?? null,
    set_at: action.emitted_at,
  };

  if (action.scope === 'global') {
    const previous = state.global_slots[action.slot_key as keyof typeof state.global_slots];
    slot.previous_value_json = previous?.value_json ?? null;
    state.global_slots[action.slot_key as keyof typeof state.global_slots] = slot;
    return previous ?? null;
  }

  if (!action.item_id) {
    throw new Error('item_slot_requires_item_id');
  }

  const item = findItem(state, action.item_id);
  item.slots ??= {};
  const previous = item.slots[action.slot_key as ItemSlotKey] ?? null;
  slot.previous_value_json = previous?.value_json ?? null;
  item.slots[action.slot_key as ItemSlotKey] = slot;
  return previous;
}

function markSlotStale(state: ConversationState, action: MarkSlotStaleAction): void {
  if (action.scope === 'global') {
    const slot = state.global_slots[action.slot_key as keyof typeof state.global_slots];
    if (slot) {
      slot.stale = action.stale;
      slot.requires_confirmation = true;
    }
    return;
  }

  if (!action.item_id) {
    throw new Error('item_slot_requires_item_id');
  }

  const slot = findItem(state, action.item_id).slots?.[action.slot_key as ItemSlotKey];
  if (slot) {
    slot.stale = action.stale;
    slot.requires_confirmation = true;
  }
}

function invalidateOffer(state: ConversationState, reason: string): void {
  if (state.last_offer && !state.last_offer.invalidated) {
    state.last_offer.invalidated = true;
    state.last_offer.invalidation_reason = reason;
  }
}

function applyCascadeInvalidation(state: ConversationState, action: UpdateSlotAction): SessionEventInsert[] {
  const events: SessionEventInsert[] = [];
  const rules = INVALIDATION_RULES.filter(
    (rule) => rule.trigger_scope === action.scope && rule.trigger_slot === action.slot_key,
  );

  for (const rule of rules) {
    if (rule.invalidate_offer) {
      invalidateOffer(state, `${action.scope}.${action.slot_key}_changed`);
      events.push(eventFor(action, 'offer_invalidated', { reason: `${action.scope}.${action.slot_key}_changed` }));
    }

    if (action.scope !== 'item' || !action.item_id) {
      continue;
    }

    const item = findItem(state, action.item_id);
    item.slots ??= {};

    for (const effect of rule.effects) {
      const slot = item.slots[effect.slot_key as ItemSlotKey];
      if (!slot || !effect.if_source.includes(slot.source)) {
        continue;
      }

      if (effect.action === 'delete') {
        delete item.slots[effect.slot_key as ItemSlotKey];
        events.push(eventFor(action, 'slot_marked_stale', { slot_key: effect.slot_key, action: 'delete' }));
        continue;
      }

      slot.stale = staleLevelForAction(effect.action);
      slot.requires_confirmation = true;
      events.push(
        eventFor(action, 'slot_marked_stale', {
          slot_key: effect.slot_key,
          stale: slot.stale,
        }),
      );
    }
  }

  return events;
}

function applyUpdateSlot(state: ConversationState, action: UpdateSlotAction): ApplyResult {
  const next = cloneState(state);
  setSlot(next, action);
  const sideEvents = applyCascadeInvalidation(next, action);
  touch(next, action);
  return { state: next, events_to_emit: [eventFor(action, 'slot_set'), ...sideEvents] };
}

function applyCreateItem(state: ConversationState, action: CreateItemAction): ApplyResult {
  const next = cloneState(state);
  if (next.items.some((item) => item.id === action.item_id)) {
    return { state: next, events_to_emit: [] };
  }
  if (action.make_active) {
    for (const item of next.items) {
      item.is_active = false;
    }
  }
  next.items.push({
    id: action.item_id,
    status: 'aberto',
    is_active: action.make_active,
    created_at: action.emitted_at,
    updated_at: action.emitted_at,
    slots: {},
  });
  touch(next, action);
  return { state: next, events_to_emit: [eventFor(action, 'item_created')] };
}

function applySetActiveItem(state: ConversationState, action: SetActiveItemAction): ApplyResult {
  const next = cloneState(state);
  const item = findItem(next, action.item_id);
  if (item.status === 'descartado') {
    throw new Error('cannot_activate_discarded_item');
  }
  const previousActive = activeItem(next);
  const changedActiveItem = previousActive !== null && previousActive.id !== action.item_id;
  const events: SessionEventInsert[] = [eventFor(action, 'active_item_changed')];

  for (const candidate of next.items) {
    candidate.is_active = candidate.id === action.item_id;
  }
  if (changedActiveItem && previousActive) {
    previousActive.updated_at = action.emitted_at;
    if (next.last_offer?.item_id === previousActive.id && !next.last_offer.invalidated) {
      invalidateOffer(next, 'active_item_changed');
      events.push(eventFor(action, 'offer_invalidated', { reason: 'active_item_changed', item_id: previousActive.id }));
    }

    for (const [slotKey, slot] of Object.entries(previousActive.slots ?? {})) {
      if (!slot) continue;
      slot.stale = 'stale_strong';
      slot.requires_confirmation = true;
      events.push(
        eventFor(action, 'slot_marked_stale', {
          item_id: previousActive.id,
          slot_key: slotKey,
          stale: 'stale_strong',
          reason: 'active_item_changed',
        }),
      );
    }
  }
  touch(next, action);
  return { state: next, events_to_emit: events };
}

function applyUpdateItemStatus(state: ConversationState, action: UpdateItemStatusAction): ApplyResult {
  const next = cloneState(state);
  const item = findItem(next, action.item_id);
  item.status = action.status;
  item.updated_at = action.emitted_at;
  if (action.status === 'descartado') {
    item.is_active = false;
  }
  touch(next, action);
  return { state: next, events_to_emit: [eventFor(action, 'item_status_changed')] };
}

function applyRecordOffer(state: ConversationState, action: RecordOfferAction): ApplyResult {
  const next = cloneState(state);
  const item = findItem(next, action.item_id);
  item.status = 'ofertado';
  next.last_offer = {
    offer_id: action.offer_id,
    item_id: action.item_id,
    products: action.products,
    expires_at: action.expires_at,
    invalidated: false,
    invalidation_reason: null,
  };
  touch(next, action);
  return { state: next, events_to_emit: [eventFor(action, 'offer_made')] };
}

function applyInvalidateOffer(state: ConversationState, action: InvalidateOfferAction): ApplyResult {
  const next = cloneState(state);
  invalidateOffer(next, action.reason);
  touch(next, action);
  return { state: next, events_to_emit: [eventFor(action, 'offer_invalidated')] };
}

function applyAddObjection(state: ConversationState, action: AddObjectionAction): ApplyResult {
  const next = cloneState(state);
  touch(next, action);
  return { state: next, events_to_emit: [eventFor(action, 'objection_raised')] };
}

function applyUnsupportedObservation(state: ConversationState, action: UnsupportedObservationAction): ApplyResult {
  const next = cloneState(state);
  touch(next, action);
  return { state: next, events_to_emit: [eventFor(action, 'unsupported_observation')] };
}

function applySelectSkill(state: ConversationState, action: SelectSkillAction): ApplyResult {
  const next = cloneState(state);
  next.current_skill = action.skill_name;
  touch(next, action);
  return { state: next, events_to_emit: [eventFor(action, 'skill_selected')] };
}

function applyRequestConfirmation(state: ConversationState, action: RequestConfirmationAction): ApplyResult {
  const next = cloneState(state);
  const timestamp = actionTimestamp(state, action);
  next.pending_confirmation = {
    id: deterministicId(state, action, 'pending_confirmation'),
    confirmation_type: action.confirmation_type,
    expected_facts: action.expected_facts,
    status: 'open',
    expires_at: addSeconds(timestamp, action.expires_in_seconds ?? 86400),
  };
  touch(next, action);
  return { state: next, events_to_emit: [eventFor(action, 'confirmation_requested')] };
}

function applyEscalate(state: ConversationState, action: EscalateAction): ApplyResult {
  const next = cloneState(state);
  next.status = 'escalated';
  next.derived_signals.has_pending_human_request = action.reason === 'customer_requested';
  touch(next, action);
  return {
    state: next,
    events_to_emit: [
      eventFor(action, action.reason === 'customer_requested' ? 'human_requested' : 'escalation_created'),
    ],
  };
}

function applyAddToCart(state: ConversationState, action: AddToCartAction): ApplyResult {
  const next = cloneState(state);
  const existing = next.cart.find(
    (item) => item.product_id === action.product_id && item.item_status !== 'removed',
  );
  const cartItemId = existing?.id ?? deterministicId(state, action, 'cart_item');

  if (existing) {
    existing.quantity = action.quantity;
    existing.unit_price = action.unit_price ?? existing.unit_price ?? null;
    existing.item_status = 'proposed';
  } else {
    next.cart.push({
      id: cartItemId,
      product_id: action.product_id,
      quantity: action.quantity,
      unit_price: action.unit_price ?? null,
      item_status: 'proposed',
    });
  }

  const offeredItemId = next.last_offer?.products.some(
    (product) => product.product_id === action.product_id,
  )
    ? next.last_offer.item_id
    : null;
  if (offeredItemId) {
    const item = next.items.find((candidate) => candidate.id === offeredItemId);
    if (item) {
      item.status = 'no_carrinho';
      item.updated_at = actionTimestamp(state, action);
    }
  }

  touch(next, action);
  return {
    state: next,
    events_to_emit: [eventFor(action, 'cart_proposed', { action, cart_item_id: cartItemId })],
  };
}

function applyRemoveFromCart(state: ConversationState, action: RemoveFromCartAction): ApplyResult {
  const next = cloneState(state);
  const item = next.cart.find((candidate) => candidate.id === action.cart_item_id);
  if (item) {
    item.item_status = 'removed';
  }
  touch(next, action);
  return { state: next, events_to_emit: [eventFor(action, 'cart_proposed')] };
}

function applyUpdateCartItem(state: ConversationState, action: UpdateCartItemAction): ApplyResult {
  const next = cloneState(state);
  const item = next.cart.find((candidate) => candidate.id === action.cart_item_id);
  if (!item || item.item_status === 'removed') {
    throw new Error(`cart_item_not_found:${action.cart_item_id}`);
  }
  item.quantity = action.quantity;
  touch(next, action);
  return { state: next, events_to_emit: [eventFor(action, 'cart_proposed')] };
}

function applyClearCart(state: ConversationState, action: ClearCartAction): ApplyResult {
  const next = cloneState(state);
  for (const item of next.cart) {
    item.item_status = 'removed';
  }
  touch(next, action);
  return { state: next, events_to_emit: [eventFor(action, 'cart_proposed')] };
}

function applyUpdateDraft(state: ConversationState, action: UpdateDraftAction): ApplyResult {
  const next = cloneState(state);
  const timestamp = actionTimestamp(state, action);
  const current = next.order_draft ?? null;

  next.order_draft = {
    customer_name: action.customer_name ?? current?.customer_name ?? null,
    delivery_address: action.delivery_address ?? current?.delivery_address ?? null,
    geo_resolution_id: current?.geo_resolution_id ?? null,
    fulfillment_mode: action.fulfillment_mode ?? current?.fulfillment_mode ?? null,
    payment_method: action.payment_method ?? current?.payment_method ?? null,
    draft_status: draftStatusFor(action, current),
    promoted_order_id: current?.promoted_order_id ?? null,
    promoted_by: current?.promoted_by ?? null,
    promoted_at: current?.promoted_at ?? null,
    created_at: current?.created_at ?? timestamp,
    updated_at: timestamp,
  };

  touch(next, action);
  return { state: next, events_to_emit: [eventFor(action, 'fact_corrected')] };
}

export function applyAction(state: ConversationState, action: AgentAction): ApplyResult {
  switch (action.type) {
    case 'update_slot':
      return applyUpdateSlot(state, action);
    case 'mark_slot_stale': {
      const next = cloneState(state);
      markSlotStale(next, action);
      touch(next, action);
      return { state: next, events_to_emit: [eventFor(action, 'slot_marked_stale')] };
    }
    case 'create_item':
      return applyCreateItem(state, action);
    case 'set_active_item':
      return applySetActiveItem(state, action);
    case 'update_item_status':
      return applyUpdateItemStatus(state, action);
    case 'record_offer':
      return applyRecordOffer(state, action);
    case 'invalidate_offer':
      return applyInvalidateOffer(state, action);
    case 'add_objection':
      return applyAddObjection(state, action);
    case 'unsupported_observation':
      return applyUnsupportedObservation(state, action);
    case 'select_skill':
      return applySelectSkill(state, action);
    case 'request_confirmation':
      return applyRequestConfirmation(state, action);
    case 'escalate':
      return applyEscalate(state, action);
    case 'add_to_cart':
      return applyAddToCart(state, action);
    case 'remove_from_cart':
      return applyRemoveFromCart(state, action);
    case 'update_cart_item':
      return applyUpdateCartItem(state, action);
    case 'clear_cart':
      return applyClearCart(state, action);
    case 'update_draft':
      return applyUpdateDraft(state, action);
  }
}

export function deriveActiveItem(state: ConversationState) {
  return activeItem(state);
}
