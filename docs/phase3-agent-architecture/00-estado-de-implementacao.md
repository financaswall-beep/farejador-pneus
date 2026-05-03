# 00 - Estado de Implementacao da Fase 3

Atualizado: 2026-05-03.

Este e o estado vivo da Fase 3. Historico detalhado anterior permanece no git;
este arquivo deve ficar curto, direto e util para decidir a proxima tarefa.

## Resumo Executivo

Organizadora esta em producao e calibrada no prompt v3.3. A Atendente ja tem
fundacao de estado, tools, Planner, Executor/guardrails, Worker Shadow e
Generator Shadow (gera resposta candidata auditavel, nao envia ao Chatwoot).

Nada responde cliente automaticamente.

## Status Por Bloco

| Bloco | Status |
| --- | --- |
| Fase 1 - webhook/raw/core/admin | Concluida e em prod |
| Fase 1.5 - hardening | Concluida |
| Fase 2a - enrichment deterministico | Concluida |
| Organizadora LLM | Em producao |
| `analytics.fact_evidence` | Implementado |
| Analytics marts v1 | Implementadas |
| Commerce schema/views/helpers | Implementado |
| Agent schema base | Implementado |
| Atendente Sprint 1 - estado reentrante | Implementado |
| Atendente Sprint 2 - tools deterministicas | Implementado |
| Atendente Sprint 3 - Planner foundation | Implementado |
| Atendente Sprint 4 - Executor/guardrails | Implementado |
| Atendente Sprint 5 - Worker Shadow | Implementado, desligado por default |
| Atendente Sprint 6 - Generator Shadow | Implementado, desligado por default |
| Critic | Nao existe |
| Envio Chatwoot pela Atendente | Nao existe |

## Migrations Relevantes Da Fase 3

- `0013_commerce_layer.sql`
- `0014_commerce_indexes.sql`
- `0015_commerce_views.sql`
- `0016_agent_layer.sql`
- `0017_agent_triggers.sql`
- `0018_analytics_evidence.sql`
- `0019_ops_phase3_additions.sql`
- `0020_vehicle_fitment_validation.sql`
- `0021_environment_match_guards.sql`
- `0022_conversation_facts_append_ledger.sql`
- `0023_analytics_marts_v1.sql`
- `0024_atendente_v1_state_extensions.sql`
- `0025_planner_foundation.sql`
- `0026_tool_executor_events.sql`
- `0027_generator_shadow_events.sql` (aplicada/verificada no Supabase atual em 2026-05-03)

## Codigo Da Organizadora

Arquivos principais:

- `src/organizadora/worker.ts`
- `src/organizadora/prompt.ts`
- `src/shared/llm-clients/openai.ts`
- `src/shared/zod/llm-organizadora.ts`
- `src/shared/zod/fact-keys.ts`
- `src/shared/repositories/analytics-phase3.repository.ts`
- `src/shared/repositories/ops-phase3.repository.ts`
- `src/shared/repositories/core-reader.repository.ts`

Escreve:

- `analytics.conversation_facts`
- `analytics.fact_evidence`
- `ops.agent_incidents`

Nao escreve:

- `raw.*`
- `core.*`
- `commerce.*`

## Codigo Da Atendente Ja Implementado

Estado:

- `src/atendente/state/apply-action.ts`
- `src/shared/zod/agent-state.ts`
- `agent.session_items`
- `agent.session_slots`

Tools:

- `src/atendente/tools/commerce-tools.ts`
- `buscarProduto`
- `verificarEstoque`
- `buscarCompatibilidade`
- `calcularFrete`
- `buscarPoliticaComercial`

Planner:

- `src/atendente/planner/context-builder.ts`
- `src/atendente/planner/schemas.ts`
- `src/atendente/planner/service.ts`
- `src/atendente/planner/prompt.ts`

Executor/Guardrails:

- `src/atendente/executor/tool-executor.ts`
- `src/atendente/validators/say-validator.ts`
- `src/atendente/validators/action-validator.ts`
- `src/atendente/validators/tool-results.ts`
- `src/shared/deterministic-id.ts`

Worker Shadow:

- `src/atendente/worker.ts`
- `src/shared/repositories/ops-atendente.repository.ts`
- `ATENDENTE_SHADOW_ENABLED=false` por default
- `src/normalization/dispatcher.ts` enfileira `ops.atendente_jobs` em
  `message_created` quando `ATENDENTE_SHADOW_ENABLED=true` e garante
  `agent.session_current` para a conversa antes do enqueue
- log-only: gera candidato shadow, sem envio Chatwoot

## Organizadora v3.3

- `extractor_version`: `moto-pneus-hybrid-v3-3`
- Prompt atual: `src/organizadora/prompt.ts`, 151 linhas no arquivo.
- Matriz sintetica expandida: 46/48 aprovados em 2026-05-03.
- Falhas restantes registradas em `docs/ORGANIZADORA_EVAL.md`.
- Proxima acao da Organizadora: observar conversas reais antes de novo ajuste.

## Validacao Atual

Ultima validacao (pos Sprint 6):

- `npm test`: 289/289 verde.
- `npm run typecheck`: verde.
- `npm run build`: verde.

## Proxima Fase

Sprint 7: Critic Shadow da Atendente.

Fluxo desejado:

```text
ops.atendente_jobs
  -> Worker Shadow
  -> buildPlannerContext
  -> planTurn
  -> executeToolRequests
  -> Generator cria resposta candidata
  -> Critic avalia o candidato
  -> grava auditoria shadow
  -> para
```

Limites da Sprint 7:

- sem envio Chatwoot;
- sem atendimento automatico;
- `GENERATOR_LLM_ENABLED=false` por default;
- log-only/shadow-only.

## Documentos De Apoio

- `docs/NEXT_CHAT_HANDOFF.md`
- `docs/HANDOFF.md`
- `docs/CODEX_BRIEFING.md`
- `docs/phase3-agent-architecture/21-atendente-v1-state-design.md`
- `docs/adr/ADR-004-fase-3-arquitetura-agente.md`
