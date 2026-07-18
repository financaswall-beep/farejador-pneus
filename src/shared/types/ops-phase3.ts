/**
 * Canonical TypeScript types for Fase 3 additions to `ops.*`.
 *
 * Source: 0019_ops_phase3_additions.sql
 * Pre-existing tables (enrichment_jobs, stock_snapshots, bot_events, erasure_log)
 * are NOT redefined here — they belong to Phase 1/2 ops layer.
 *
 * This file adds:
 * - ops.atendente_jobs
 * - ops.unhandled_messages
 * - ops.agent_incidents
 * Plus the extended fields added to ops.enrichment_jobs in Fase 3.
 */

import type { Environment } from './chatwoot.js';

// ------------------------------------------------------------------
// ops.atendente_jobs
// ------------------------------------------------------------------

export type AtendenteJobStatus =
  | 'pending'
  | 'processing'
  | 'processed'
  | 'failed'
  | 'dead_letter'
  | 'superseded';

export interface AtendenteJob {
  id: string;
  environment: Environment;
  conversation_id: string;
  /** Logical FK → core.messages(id). UNIQUE: one job per customer message. */
  trigger_message_id: string;
  status: AtendenteJobStatus;
  not_before: Date;
  attempts: number;
  locked_at: Date | null;
  locked_by: string | null;
  error_message: string | null;
  processed_at: Date | null;
  created_at: Date;
}

// ------------------------------------------------------------------
// ops.unhandled_messages
// ------------------------------------------------------------------

export type FallbackReason =
  | 'router_no_skill'
  | 'policy_missing'
  | 'data_missing'
  | 'evidence_low'
  | 'other';

export interface UnhandledMessage {
  id: string;
  environment: Environment;
  conversation_id: string;
  /** Logical FK → core.messages(id). */
  message_id: string;
  message_text: string | null;
  fallback_reason: FallbackReason;
  skill_used: string;
  reviewed_at: Date | null;
  reviewed_by: string | null;
  promoted_to_skill: string | null;
  notes: string | null;
  created_at: Date;
}

// NOTA (2026-06-14): os tipos de ops.agent_incidents e ops.enrichment_jobs
// (Organizadora/V1) foram removidos — eram usados só pelo ops-phase3.repository.ts,
// que era código órfão (a Organizadora está morta; ver docs/MAPA_LIMPEZA_ORGANIZADORA_2026-06-14.md).
