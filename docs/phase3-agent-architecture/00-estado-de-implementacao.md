# 00 - Estado de Implementacao da Fase 3

**Atualizado: 2026-05-15.**

Este e o estado vivo da Fase 3. Historico detalhado anterior permanece no git;
este arquivo deve ficar curto, direto e util para decidir a proxima tarefa.

## Resumo Executivo

Organizadora esta em producao e calibrada no prompt v3.4. A Atendente passou
pela migração para Responses API + structured outputs, ganhou structured
claims (Etapa 2), perdeu regex de customer text no Planner (Etapa 3), e tem
agora prompt few-shot v1.5.0 atrás de feature flag (Etapa 5). Worker emite
escalate sintética quando Planner=`escalar_humano`.

**Nada responde cliente automaticamente.** Sistema está em Fase D estendida
(shadow assistido, ADR-008).

## Status Por Bloco

| Bloco | Status |
| --- | --- |
| Fase 1 - webhook/raw/core/admin | Concluida e em prod |
| Fase 1.5 - hardening | Concluida |
| Fase 2a - enrichment deterministico | Concluida |
| Organizadora LLM | Em producao, `moto-pneus-hybrid-v3-4` |
| `analytics.fact_evidence` | Implementado |
| Analytics marts v1 | Implementadas |
| Commerce schema/views/helpers | Implementado |
| Agent schema base | Implementado |
| Atendente Sprints 1-6.9 | Todos concluidos |
| PRs 1-5 (audit, contexto, validators, ops, Say Validator comercial) | Todos concluidos |
| **Planner-input fix** (commit `4963701`) | Concluído — Planner v1.2.7 + sanitize defensivo |
| **Fase 3 residual** (commit `0a40e0d`) | A1 fitment hedge, A3 anti-soma, A4 delivery sem endereço |
| **Refactor A2 auto-chain** (commit `0ba7988`) | Auto-chain determinístico sem regex |
| **B1+B2+B3 housekeeping** (commit `ce16830`) | safeRollback, dead branch, sha256 UUID |
| **B4 action_id** (commit `d0c5da3`) | Metadados em cart/escalate/confirmation/selectSkill |
| **B5 escalação real** (commit `9888bd7`) | Worker emite `escalate` quando Planner=escalar_humano |
| **Etapa 3 Planner cleanup** (commit `b6bc9d9`) | Planner v1.2.8 sem regex de customer text |
| **Etapa 2 structured claims** (commit `408f058`) | Generator v1.4.0 + ClaimValidator |
| **Audit claims** (commit `1edd3a2`) | Claims em event_payload + claims_count + claim_types |
| **v1.5.0 few-shot** (commit `cc93a05`) | 10 exemplos canônicos atrás de flag |
| **Audit prompt_version fix** (commit `6f7e7c5`) | DB grava versão real (v1.4 ou v1.5) |
| Critic (Sprint 7 original) | DESCARTADO (ADR-005). SayValidator+ActionValidator+ClaimValidator são o gate. |
| Supervisora batch | ADIADA para Fase G (ADR-006). |
| Envio Chatwoot (Sprint 8) | Adiado. `ATENDENTE_SEND_ENABLED` não existe. |
| Catálogo commerce.* técnico | 78 produtos, 308 vehicle_models, 166 fitments populados. Comercial (preço/marca/foto) escasso. |
| **Fase D estendida (coleta humana)** | EM ANDAMENTO (ADR-008) |

## Migrations Aplicadas

`0001` até **`0030_vehicle_resolver_variant_precision.sql`** (todas em prod).

Lista chave da Fase 3:
- `0013-0015`: commerce layer (products, fitments, views)
- `0016-0017`: agent schema + triggers
- `0018`: fact_evidence (Organizadora)
- `0019`: ops Phase 3 (atendente_jobs, agent_incidents, etc)
- `0020-0021`: validações cross-table + env_match guards
- `0022`: append-only ledger em conversation_facts
- `0023`: analytics marts v1
- `0024-0028`: state extensions Atendente + Planner + Tool Executor + Generator
- `0029`: cart action events hardening
- `0030`: vehicle resolver variant precision (prioriza match por modelo+versao em `commerce.resolve_vehicle_model`)

## Versões Ativas (2026-05-15)

| Componente | Versão | Onde |
|---|---|---|
| Organizadora prompt | `moto-pneus-hybrid-v3-4` | `src/organizadora/prompt.ts` |
| Planner prompt | `planner_v1.2.8` | `src/atendente/planner/prompt.ts` |
| Generator prompt (default) | `generator_v1.4.0` | `src/atendente/generator/prompt.ts` |
| Generator prompt (flag) | `generator_v1.5.0` | `src/atendente/generator/prompt-v1_5.ts` |
| Generator agent version | `atendente_v1.0.0` | (constante em `schemas.ts`) |

## Codigo Da Organizadora

Arquivos principais:
- `src/organizadora/worker.ts`
- `src/organizadora/prompt.ts`
- `src/shared/llm-clients/openai.ts` (função `callOpenAI` — chat completions)
- `src/shared/zod/llm-organizadora.ts`
- `src/shared/zod/fact-keys.ts`
- `src/shared/repositories/analytics-phase3.repository.ts`
- `src/shared/repositories/ops-phase3.repository.ts`
- `src/shared/repositories/core-reader.repository.ts`

Escreve: `analytics.conversation_facts`, `analytics.fact_evidence`,
`ops.agent_incidents`. Nao escreve: `raw.*`, `core.*`, `commerce.*`, `agent.*`.

## Codigo Da Atendente (estado 2026-05-15)

**Estado:**
- `src/atendente/state/apply-action.ts` (com `deterministicUuid` agora)
- `src/atendente/state/agent-state.repository.ts`
- `src/atendente/state/invalidation-rules.ts`
- `src/shared/zod/agent-state.ts`
- `src/shared/zod/agent-actions.ts` (com `stateActionBaseSchema.extend` em
  todas as actions, incluindo cart/escalate/confirmation/selectSkill após B4)

**Tools (commerce):**
- `src/atendente/tools/commerce-tools.ts`
- `buscarProduto`, `verificarEstoque`, `buscarCompatibilidade`,
  `calcularFrete`, `buscarPoliticaComercial`

**Planner:**
- `src/atendente/planner/context-builder.ts`
- `src/atendente/planner/schemas.ts` (versão `planner_v1.2.8`)
- `src/atendente/planner/service.ts` (sem regex de customer text após Etapa 3;
  funcões `mentionsPolicyQuestion` / `mentionsStoreInfoQuestion` mantidas como
  `@internal MOCK-ONLY`)
- `src/atendente/planner/prompt.ts` (regras explícitas por skill + REGRA DE OURO)

**Executor:**
- `src/atendente/executor/tool-executor.ts`
  - `sanitizeBuscarProdutoInput` — drop defensivo de marca/product_code alucinados
  - `maybeAutoChainVerificarEstoque` — auto-chain determinístico pós-buscarProduto

**Validators:**
- `src/atendente/validators/say-validator.ts` — regex sobre output do bot (rede)
- `src/atendente/validators/action-validator.ts` — pré-condições de actions
- `src/atendente/validators/claim-validator.ts` — **NOVO Etapa 2** — checa
  `price`/`stock_availability`/`fitment`/`delivery_fee` contra tool results
- `src/atendente/validators/tool-results.ts` — helpers compartilhados

**Generator:**
- `src/atendente/generator/schemas.ts`
  - `generatorPromptVersionV14 = 'generator_v1.4.0'`
  - `generatorPromptVersionV15 = 'generator_v1.5.0'`
  - `SUPPORTED_GENERATOR_PROMPT_VERSIONS` enum para schema strict
  - `generatorClaimSchema` (discriminated union)
  - `GeneratorResult.claims` + `GeneratorResult.prompt_version` (novos campos)
- `src/atendente/generator/prompt.ts` — v1.4.0 declarativo (14 regras numeradas + claims section)
- `src/atendente/generator/prompt-v1_5.ts` — **NOVO** v1.5.0 few-shot (10 exemplos)
- `src/atendente/generator/service.ts`
  - Roteia entre v1.4.0 e v1.5.0 via `env.GENERATOR_PROMPT_FEW_SHOT_ENABLED`
  - `runValidators` agora chama `validateClaims` antes do say-validator
  - `recordGeneratorResult` grava `prompt_version` real do LLM em vez de constante
  - Persiste `claims` + `claims_count` + `claim_types` em `event_payload` e `blocked_payload`

**Worker:**
- `src/atendente/worker.ts`
  - `safeRollback` helper (log explícito em rollback failed)
  - `maybeSynthesizeEscalate` — emite action `escalate` sintética quando
    Planner decide `escalar_humano`. Reason inferido de `risk_flags` + confidence.
  - Roteia tool execution → auto-chain → generator → record → loop apply actions
- `src/atendente/reconcile-jobs.ts` — varredura periódica
- `src/atendente/handlers/escalate.ts` — `postEscalateNote` (nota Chatwoot)
- `ATENDENTE_SHADOW_ENABLED=true` em prod

## Atendente Generator Shadow Em Producao

- `ATENDENTE_SHADOW_ENABLED=true` em prod
- `GENERATOR_LLM_ENABLED=true` em prod
- `GENERATOR_PROMPT_FEW_SHOT_ENABLED` controla v1.4/v1.5 (default false)
- Auto-chain `verificarEstoque` ativo
- Worker emite escalate quando Planner=`escalar_humano`
- `agent.escalations` recebe linhas reais (5 confirmadas em DB em 2026-05-15)
- Nenhuma mensagem enviada ao cliente

## Resultados das Baterias Recentes (2026-05-15)

**catalog15-rerun com v1.5.0:**
- 45/45 generated, 0 blocked
- 2 fallbacks exatos (eram 6 com v1.4.0)
- 64.4% turns com claims, média 1.4 claims/turn
- Tipos: price 32, stock_availability 24, fitment 4, delivery_fee 1
- 0 `claim_invalid:*` blocks
- Notas: Planner 9/10, Generator 9/10 provisório, Organizadora 8.5/10 provisório
- Input médio Generator: 7068 tokens (era 6890 com v1.4 pós-claims)
- Output médio: 347 tokens

**Bateria custom 8 casos coloquiais:**
- 8/8 generated, 0 blocked
- Cobre: "tem aí?", "vc traz em Belford Roxo?", "pega na minha Bros?",
  "tá salgado?", "dois pneus, quanto cada e tem?", "ia querer X, mas é Y",
  "pode separar, pago pix, busco hoje"
- 1 caso ("tá salgado") caiu em fallback — Planner falhou em rotear pra
  `tratar_objecao`; não é bug do Generator

## Validacao Atual

- `npm run typecheck`: verde
- `npm test`: 463/463 verde, 55 arquivos
- `npm run build`: verde
- 10 commits push em `pneus/main` desde `4963701`

## Próxima Fase

**Fase D estendida (ADR-008)** — EM ANDAMENTO, não mais "próximo passo".

Frentes paralelas:
1. **Coleta humana 2-4 semanas:** Wallace atende manual, agente em shadow,
   dataset humano vs bot.
2. **Catálogo comercial:** preço, marca, foto, estoque (78 produtos técnicos
   prontos). Ver `docs/COMMERCE_CATALOG_STATUS.md`.
3. **6 blocos de infra paralela:**
   - Particões julho/agosto 2026 (urgente, pg_partman não instalado)
   - Reconciliar migration history (banco em 0030, CLI registra 0021)
   - LGPD: endpoint erasure + base legal
   - Runbook de desligamento de emergência
   - Rate limit / circuit breaker OpenAI
   - Auditoria RLS: confirmar service_role-only

**NÃO fazer agora:**
- Tunar mais prompts (sistema em diminishing returns)
- Critic (descartado, ADR-005)
- Supervisora (adiada, ADR-006)
- Sprint 8 envio (adiado até Fase D + catálogo)

**Fase G (futura, após Sprint 8):** Supervisora batch.

## Documentos De Apoio

- `docs/NEXT_CHAT_HANDOFF.md` — resumo curto
- `docs/HANDOFF.md` — operacional médio
- `docs/CODEX_BRIEFING.md` — briefing técnico
- `docs/PROJECT.md` — visão executiva
- `docs/CONFIG.md` — env vars (inclui `GENERATOR_PROMPT_FEW_SHOT_ENABLED`)
- `docs/adr/ADR-004-fase-3-arquitetura-agente.md`
- `docs/adr/ADR-005-critic-descartado.md`
- `docs/adr/ADR-006-supervisora-batch-adiada.md`
- `docs/adr/ADR-007-validators-como-gate-sincrono.md`
- `docs/adr/ADR-008-fase-d-estendida-coleta-humana.md`
- `docs/adr/ADR-009-claims-and-few-shot.md` — **NOVO**, decisão Etapa 2 + v1.5.0
- `docs/phase3-agent-architecture/21-atendente-v1-state-design.md`
