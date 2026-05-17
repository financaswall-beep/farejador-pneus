# AGENTS.md

## Project
Farejador

## Goal
Farejador is a greenfield system for capturing, normalizing, and structuring conversation data from Chatwoot.

The current objective is **not** to build a conversational agent.
The objective is to build the data foundation that will support future analytics, classification, and LLM-based agents.

## Current Scope
- Ingest data only from the production Chatwoot instance.
- The test Chatwoot instance must never contaminate the production dataset.
- New database and new architecture. No coupling to any legacy schema.

## Stack
- TypeScript
- Node.js
- Fastify
- Supabase Postgres

## Data Handling Principles
- Treat all conversation and contact data as sensitive.
- Apply data minimization — store only what serves a defined purpose.
- Keep operational data and AI-ready data strictly separated.
- Anonymize before any downstream training, sharing, or external use.
- Formal LGPD legal basis and RIPD belong in a separate privacy document, not here.

## MVP Architecture
Modular monolith. No microservices.

Core modules:
- `webhooks/`
- `normalization/`
- `persistence/`

A small `admin/` module is acceptable if needed for replay and reconciliation endpoints.

## Data Layers
Three layers, clearly separated:

1. **raw_events** — raw webhook payloads; immutable; used for audit, replay, debugging, traceability.
2. **Normalized** — contacts, conversations, messages, message_attachments, conversation_tags, conversation_facts.
3. **Analytical / AI-ready** — derived business signals, stage and outcome classifications, future AI chunks and embeddings.

## Webhook Invariants
- Validate HMAC using `X-Chatwoot-Signature`.
- Reject requests with `X-Chatwoot-Timestamp` older than 5 minutes.
- Use `X-Chatwoot-Delivery` as the deduplication key for `raw_events`.
- Always persist raw events first, then return 2xx.
- Never block the webhook response on heavy normalization.
- Normalization and reprocessing must run asynchronously, after raw event persistence.

## Idempotency Rules
- Every table in raw, normalized, and derived layers must include an `environment` column.
- Production and test datasets must never mix, even accidentally.
- Raw webhook deduplication key: `(environment, chatwoot_delivery_id)`, enforced by `raw.delivery_seen`.
- `raw_events` is partitioned by `received_at`; do not rely on its partition-local uniqueness for deduplication.
- Normalized entities unique key: `(environment, chatwoot_<entity>_id)`.

## Taxonomy
Conversation analysis separates three axes:
- `stage_reached`
- `final_outcome`
- `loss_reason`

Start with **TEXT + CHECK constraints** in the MVP. Promote to ENUM only after observing real data for at least 4–8 weeks. Do not over-constrain early taxonomy.

## Provenance
Provenance metadata applies **only** to derived or interpreted data, not to transactional tables.

Use provenance in:
- `conversation_facts`
- analytical signals
- stage and outcome classifications
- future AI-ready derived tables

Do **not** add provenance metadata to:
- `raw_events`
- `messages`
- `contacts`
- `message_attachments`

Recommended provenance fields for derived tables:
- `source_type`
- `truth_type`
- `confidence_level`
- `source_reference`
- `extractor_version`

## Audio and Attachments
- MVP stores attachment metadata and reference URLs only.
- Audio transcription is not required on day one.
- Schema must allow transcription to be added later without migration pain.

## Phases
The project evolves in three phases. Do not mix responsibilities across phase boundaries.

- **Phase 1 — Deterministic Farejador (MVP).** Webhook ingestion, HMAC validation, dedup, raw persistence, structural normalization into `core.*`. No LLM calls. No interpretation.
- **Phase 2a — Deterministic enrichment.** Background workers using regex, heuristics, and SQL aggregation. Populate `analytics.conversation_signals`, `analytics.linguistic_hints`, basic `analytics.customer_journey`. Baseline for measuring LLM value in 2b.
- **Phase 2b — LLM enrichment.** Background workers that read conversations and extract structured facts, classifications, and transcriptions using an LLM. Writes only to `analytics.*`.
- **Phase 3 — Conversational agent.** Implemented in `src/atendente/` and `src/agent/` within the same Farejador process/container in production today (decision 2026-04-29). Controlled via feature flags (`ATENDENTE_SHADOW_ENABLED`, `GENERATOR_LLM_ENABLED`). Consumes `core.*` and `analytics.*` as read-only client; writes only to `agent.*` and `ops.*` via validated action handlers. Decisions 2026-05-10: Critic descartado (ADR-005), Supervisora adiada para Fase G (ADR-006), Fase D estendida e proximo passo (ADR-008).

A legacy Phase 4 (training a proprietary LLM from the captured dataset) is **out of the active plan**. It remains as a distant roadmap possibility only.

## LLM Invariants
These rules are absolute across every phase that introduces LLM usage (2b and 3).

- The LLM **never** writes to `raw.*` or `core.*`.
- The LLM **only** writes to `analytics.*`.
- Structural mapping (payload → tables/columns) is always deterministic. The LLM does not decide where data goes; it only interprets free-form content into fields already defined in the schema.
- Every derived row produced by an LLM must populate: `source`, `extractor_version`, `confidence_level`, `truth_type`.
- Corrections use `superseded_by` to preserve history. Never `UPDATE` a derived row in place — insert a new row and link back.
- Prompts are versioned in the repository. Changing the prompt requires bumping `extractor_version`.
- The Farejador MVP (Phase 1) must remain fully deterministic. No LLM calls in the webhook path, in the normalizer, or in `core.*` writes.

## Legacy Schema
A previous Chatwoot-linked schema exists in a separate database. It is preserved **read-only** as historical calibration corpus.
It must not be referenced as an operational dependency by Farejador code.

## MVP Priorities
Prioritize:
- reliable ingestion
- traceability and auditability
- clean normalization
- replayability
- low coupling
- maintainable schema evolution

## Out of Scope (MVP — Phase 1)
- LLM calls of any kind inside the Farejador runtime
- conversational agent logic
- dashboard frontend
- microservices
- audio transcription pipeline (scheduled for Phase 2b)
- premature AI pipelines
- multi-tenant support
- excessive documentation
- training a proprietary LLM from captured data (parked indefinitely)

## Agent Behavior
When proposing code or architecture changes in this repository:
- **Always respond in Brazilian Portuguese.**
- Prefer simple, maintainable solutions.
- Avoid overengineering and premature abstractions.
- Preserve immutability of `raw_events` at all costs.
- Preserve strict separation between raw, normalized, and derived data.
- Never propose hidden or deceptive data collection patterns.
- Question complexity before introducing it.
- Never commit service-role keys or webhook secrets.
