import type { AgentAction } from '../../shared/zod/agent-actions.js';
import {
  globalSlotKeySchema,
  itemSlotKeySchema,
  type ConversationState,
  type SessionSlotKey,
} from '../../shared/zod/agent-state.js';
import { collectToolProductIds, type ToolResultForValidation } from './tool-results.js';

export type ActionValidationResult =
  | { valid: true }
  | { valid: false; reason: string; severity: 'block' | 'warn' };

function block(reason: string): ActionValidationResult {
  return { valid: false, reason, severity: 'block' };
}

function itemExists(
  state: ConversationState,
  itemId: string,
  context: ActionValidationContext = {},
): boolean {
  if (state.items.some((item) => item.id === itemId)) return true;
  return context.incoming_item_ids?.has(itemId) === true;
}

function liveCartItemExists(state: ConversationState, cartItemId: string): boolean {
  return state.cart.some((item) => item.id === cartItemId && item.item_status !== 'removed');
}

function hasConfirmedCartItem(state: ConversationState): boolean {
  return state.cart.some((item) => item.item_status === 'confirmed');
}

function hasOpenPendingConfirmation(state: ConversationState): boolean {
  return state.pending_confirmation?.status === 'open';
}

export interface ActionValidationContext {
  recent_tool_results?: ToolResultForValidation[];
  /**
   * Item IDs created earlier in the same turn (via `create_item` actions
   * present in the current array). The action validator checks each
   * action against `state` only — `state` is not mutated between
   * validations in a turn — so without this hint, a `record_offer`
   * (or `set_active_item` / `update_item_status`) referencing an item
   * the same array just created would be rejected as `item_not_found`.
   */
  incoming_item_ids?: Set<string>;
}

function validateSlotScope(action: Extract<AgentAction, { type: 'update_slot' | 'mark_slot_stale' }>) {
  if (action.scope === 'global') {
    if (action.item_id !== null) {
      return block('global_slot_must_not_have_item_id');
    }
    if (!globalSlotKeySchema.safeParse(action.slot_key).success) {
      return block('slot_not_allowed_in_global_scope');
    }
    return { valid: true } as const;
  }

  if (!action.item_id) {
    return block('item_slot_requires_item_id');
  }
  if (!itemSlotKeySchema.safeParse(action.slot_key).success) {
    return block('slot_not_allowed_in_item_scope');
  }
  return { valid: true } as const;
}

function hasConfirmedCriticalSlots(state: ConversationState): boolean {
  for (const item of state.items.filter((candidate) => candidate.status === 'ofertado')) {
    for (const key of ['medida_pneu', 'quantidade'] satisfies SessionSlotKey[]) {
      const slot = item.slots?.[key];
      if (!slot || slot.source !== 'confirmed' || slot.stale !== 'fresh') {
        return false;
      }
    }
  }
  return true;
}

export function validateAction(
  state: ConversationState,
  action: AgentAction,
  context: ActionValidationContext = {},
): ActionValidationResult {
  switch (action.type) {
    case 'update_slot': {
      const scopeValidation = validateSlotScope(action);
      if (!scopeValidation.valid) {
        return scopeValidation;
      }
      if (action.source === 'confirmed' && !action.set_by_message_id) {
        return block('confirmed_slot_requires_message_id');
      }
      // Removido em B2: branch sem-efeito (`isCriticalSlot && source.startsWith('inferred')
      // → { valid: true }`) que retornava o mesmo que o caminho default. Era codigo
      // morto que parecia regra. Quem voltar e quiser regra real para slots criticos
      // inferidos: usar `requires_confirmation: true` no setSlot — ja eh aplicado em
      // apply-action.ts:118-121 quando source comeca com 'inferred'.
      return { valid: true };
    }
    case 'mark_slot_stale':
      return validateSlotScope(action);
    case 'create_item':
      if (itemExists(state, action.item_id)) {
        return block('item_already_exists');
      }
      if (state.items.filter((item) => item.status !== 'descartado').length >= 5) {
        return block('too_many_open_items');
      }
      return { valid: true };
    case 'set_active_item': {
      const item = state.items.find((candidate) => candidate.id === action.item_id);
      if (!item) {
        // Item may have been created earlier in the same turn's action array.
        // A freshly-created item is never 'descartado', so the status check is satisfied.
        if (context.incoming_item_ids?.has(action.item_id)) {
          return { valid: true };
        }
        return block('item_not_found');
      }
      if (item.status === 'descartado') {
        return block('cannot_activate_discarded_item');
      }
      return { valid: true };
    }
    case 'update_item_status':
      return itemExists(state, action.item_id, context) ? { valid: true } : block('item_not_found');
    case 'record_offer': {
      const item = state.items.find((candidate) => candidate.id === action.item_id);
      const fromIncoming = !item && context.incoming_item_ids?.has(action.item_id) === true;
      if (!item && !fromIncoming) {
        return block('item_not_found');
      }
      if (item && !['aberto', 'ofertado'].includes(item.status)) {
        return block('offer_requires_open_or_offered_item');
      }
      // Freshly-created items are born with status='aberto' (see apply-action.ts
      // applyCreateItem), so the status gate above is satisfied for fromIncoming.
      if (context.recent_tool_results && context.recent_tool_results.length > 0) {
        const toolProductIds = collectToolProductIds(context.recent_tool_results);
        for (const product of action.products) {
          const productId = product.product_id;
          if (typeof productId === 'string' && !toolProductIds.has(productId)) {
            return block('offer_product_not_supported_by_tool_result');
          }
        }
      }
      return { valid: true };
    }
    case 'invalidate_offer':
      return state.last_offer ? { valid: true } : block('no_offer_to_invalidate');
    case 'add_objection':
      return { valid: true };
    case 'unsupported_observation':
      return action.requires_human_review ? { valid: true } : block('unsupported_observation_requires_review');
    case 'request_confirmation':
      if (
        action.confirmation_type === 'order_confirmation' &&
        !hasConfirmedCriticalSlots(state)
      ) {
        return block('order_confirmation_requires_confirmed_critical_slots');
      }
      return { valid: true };
    case 'add_to_cart': {
      const offeredProductIds = new Set(
        state.last_offer?.products
          .map((product) => product.product_id)
          .filter((productId): productId is string => typeof productId === 'string') ?? [],
      );
      const toolProductIds = collectToolProductIds(context.recent_tool_results ?? []);
      if (offeredProductIds.size > 0 && !offeredProductIds.has(action.product_id)) {
        return block('cart_product_not_in_current_offer');
      }
      if (toolProductIds.size > 0 && !toolProductIds.has(action.product_id)) {
        return block('cart_product_not_supported_by_tool_result');
      }
      return { valid: true };
    }
    case 'remove_from_cart':
      return liveCartItemExists(state, action.cart_item_id)
        ? { valid: true }
        : block('cart_item_not_found');
    case 'update_cart_item':
      return liveCartItemExists(state, action.cart_item_id)
        ? { valid: true }
        : block('cart_item_not_found');
    case 'clear_cart':
      return hasOpenPendingConfirmation(state)
        ? block('clear_cart_blocked_by_pending_confirmation')
        : { valid: true };
    case 'update_draft': {
      const fulfillmentMode = action.fulfillment_mode ?? state.order_draft?.fulfillment_mode ?? null;
      const deliveryAddress = action.delivery_address ?? state.order_draft?.delivery_address ?? null;
      if (fulfillmentMode === 'delivery' && !deliveryAddress) {
        return block('delivery_draft_requires_address');
      }
      return { valid: true };
    }
    case 'escalate':
      if (action.reason === 'ready_to_close' && !hasConfirmedCartItem(state)) {
        return block('ready_to_close_requires_confirmed_cart');
      }
      return { valid: true };
    case 'select_skill':
      return { valid: true };
  }
}
