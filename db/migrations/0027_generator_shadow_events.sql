-- ============================================================
-- 0027_generator_shadow_events.sql
-- Sprint 6: evento auditavel do Generator Shadow.
--
-- Aditiva/idempotente:
-- - adiciona generator_produced ao CHECK fechado de
--   agent.session_events.event_type.
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
    'generator_produced'
  ));
