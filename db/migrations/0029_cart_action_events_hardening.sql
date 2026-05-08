-- ============================================================
-- 0029_cart_action_events_hardening.sql
-- PR 3: validação semântica de actions e eventos de carrinho/draft.
-- ============================================================

ALTER TABLE agent.session_events
  DROP CONSTRAINT IF EXISTS session_events_event_type_check;

ALTER TABLE agent.session_events
  ADD CONSTRAINT session_events_event_type_check
  CHECK (event_type IN (
    -- 0016 original event types
    'skill_selected',
    'confirmation_requested',
    'cart_proposed',
    'human_called',
    'bot_resumed',
    'session_paused',
    'session_closed',
    'fact_corrected',
    'escalation_created',

    -- Atendente v1 reentrante
    'slot_set',
    'slot_marked_stale',
    'item_created',
    'active_item_changed',
    'item_status_changed',
    'offer_made',
    'offer_invalidated',
    'objection_raised',
    'human_requested',
    'unsupported_observation',
    'intent_to_close_recorded',

    -- Sprint 3 Planner
    'planner_decided',

    -- Sprint 4 Tool Executor
    'tool_executed',
    'tool_failed',

    -- Sprint 6 Generator Shadow
    'generator_produced',

    -- PR 3 cart/draft semantic events
    'cart_added',
    'cart_removed',
    'cart_updated',
    'cart_cleared',
    'draft_updated'
  ));

ALTER TABLE agent.cart_events
  DROP CONSTRAINT IF EXISTS cart_events_event_type_check;

ALTER TABLE agent.cart_events
  ADD CONSTRAINT cart_events_event_type_check
  CHECK (event_type IN (
    'proposed',
    'confirmed',
    'validated',
    'promoted',
    'removed',
    'replaced',
    'updated',
    'cleared'
  ));

COMMENT ON CONSTRAINT session_events_event_type_check ON agent.session_events IS
  'PR 3: inclui eventos semânticos de carrinho/draft em session_events.';

COMMENT ON CONSTRAINT cart_events_event_type_check ON agent.cart_events IS
  'PR 3: inclui updated para alteração de quantidade/preço sem troca de produto.';
