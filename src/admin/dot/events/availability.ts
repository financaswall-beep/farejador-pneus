import { env } from '../../../shared/config/env.js';

export type DotEventsFailure = 'invalid_encryption_key' | 'mcp_disabled' | 'pool_too_small'
  | 'schema_unavailable' | 'initialization_failed';
let phase: 'pending' | 'ready' | 'unavailable' = 'pending';
let failure: DotEventsFailure | null = null;

/** Only bootstrap may enable events, after checking the key and private schema. */
export function setDotEventsAvailability(reason: DotEventsFailure | null) {
  phase = reason ? 'unavailable' : 'ready';
  failure = reason;
}
export function dotEventsAvailable() {
  return env.DOT_EVENTS_ENABLED && phase === 'ready';
}
export function dotEventsState() {
  return {
    configured: env.DOT_EVENTS_ENABLED,
    enabled: dotEventsAvailable(),
    state: env.DOT_EVENTS_ENABLED ? phase : 'disabled',
    reason: env.DOT_EVENTS_ENABLED ? failure : null,
  };
}
