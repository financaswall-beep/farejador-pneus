# 00 - Estado de Implementacao da Fase 3

Atualizado: 2026-05-08.

Este e o estado vivo da Fase 3. Historico detalhado anterior permanece no git;
este arquivo deve ficar curto, direto e util para decidir a proxima tarefa.

## Resumo Executivo

Organizadora esta em producao e calibrada no prompt v3.4. A Atendente ja tem
fundacao de estado, tools, Planner, Executor/guardrails, Worker Shadow e
Generator Shadow (gera resposta candidata auditavel, nao envia ao Chatwoot).

Nada responde cliente automaticamente.

## Status Por Bloco

| Bloco | Status |
| --- | --- |
| Fase 1 - webhook/raw/core/admin | Concluida e em prod |
| Fase 1.5 - hardening | Concluida |
| Fase 2a - enrichment deterministico | Concluida |
| Organizadora LLM | Em producao, v3.4 |
| `analytics.fact_evidence` | Implementado |
| Analytics marts v1 | Implementadas |
| Commerce schema/views/helpers | Implementado |
| Agent schema base | Implementado |
| Atendente Sprint 1 - estado reentrante | Implementado |
| Atendente Sprint 2 - tools deterministicas | Implementado |
| Atendente Sprint 3 - Planner foundation | Implementado |
| Atendente Sprint 4 - Executor/guardrails | Implementado |
| Atendente Sprint 5 - Worker Shadow | Implementado, desligado por default |
| Atendente Sprint 6 - Generator Shadow | Implementado; LLM real em shadow |
| Atendente Sprint 6.5 - loop de estado | Implementado |
| Atendente Sprint 6.6 - bridge Organizadora | Implementado |
| Atendente Sprint 6.7 - Say Validator endurecido | Implementado |
| Atendente Sprint 6.8 - filtro sender_type | Implementado |
| Atendente Sprint 6.9 - nota Chatwoot ao escalar | Implementado em prod (e35ca31) |
| Ajuste pre-Critic - memoria operacional Generator | Implementado |
| Hardening fila Atendente - reconciliador de jobs | Implementado |
| PR 1 - auditoria de turns bloqueados | Implementado |
| PR 2 - estado/contexto | Implementado |
| PR 3 - validators/eventos | Implementado, testado e com smoke LLM pos-deploy |
| Generator v1.3.2 - fechamento seguro | Implementado e validado em smoke real |
| Critic (Sprint 7) | Nao existe |
| Envio Chatwoot pela Atendente (Sprint 8) | Nao existe |
| Seed catalogo commerce.* (Sprint 6.10) | Pendente dados da loja |

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
- `0028_generator_blocked_turn_audit.sql` (aplicada/verificada em 2026-05-07)
- `0029_cart_action_events_hardening.sql` (aplicada/verificada em 2026-05-08)

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
- `src/atendente/reconcile-jobs.ts`
- `ATENDENTE_SHADOW_ENABLED=false` por default
- `src/normalization/dispatcher.ts` enfileira `ops.atendente_jobs` em
  `message_created` quando `ATENDENTE_SHADOW_ENABLED=true` e garante
  `agent.session_current` para a conversa antes do enqueue
- `src/atendente/reconcile-jobs.ts` corrige lacunas: busca mensagens `contact`
  publicas em `core.messages` sem job correspondente e chama o mesmo
  `ensureAtendenteSession` + `ops.enqueue_atendente_job` idempotente. O worker
  shadow roda essa varredura leve a cada minuto para as ultimas 24h.
- endpoint admin `POST /admin/reconcile/atendente-jobs` permite reconciliar uma
  janela controlada, com limite maximo de 500 mensagens por chamada
- log-only: gera candidato shadow, sem envio Chatwoot

## Organizadora v3.4

- `extractor_version`: `moto-pneus-hybrid-v3-4`
- Prompt atual: `src/organizadora/prompt.ts`, com secao de valores permitidos
  gerada a partir de `FACT_KEY_SCHEMAS`.
- Fix validado em prod: `concorrente_citado` saiu como string,
  `moto_cilindrada` saiu como number e aliases de entrega/pagamento deixaram
  de gerar novos `schema_violation` nas conversas testadas.
- Matriz sintetica expandida v3.3: 46/48 aprovados em 2026-05-03; v3.4 cobre
  especificamente o gap de schema violations observado em producao.
- Proxima acao da Organizadora: observar conversas reais antes de novo ajuste.

## Atendente Generator Shadow Em Producao

- `ATENDENTE_SHADOW_ENABLED=true` no ambiente atual.
- `GENERATOR_LLM_ENABLED=true` no ambiente atual, com chave e modelo do
  Generator configurados.
- Teste com 6 conversas Chatwoot criou jobs, turns e eventos
  `generator_produced` em shadow.
- Respostas candidatas foram gravadas em `agent.turns`; nenhuma mensagem foi
  enviada ao cliente.
- Hardening PR 1 (2026-05-07): turns bloqueados passam a preservar candidato
  em `blocked_say_text`/`blocked_actions`/`blocked_payload`, e `update_draft`
  agora recebe metacampos (`action_id`, `turn_index`, `emitted_at`,
  `emitted_by`) como as demais actions emitidas pelo Generator.
- Hardening PR 2 (2026-05-08): contexto recente deixou de ser fixo em
  10 mensagens e passa a usar `ATENDENTE_CONTEXT_MESSAGES_LIMIT` (default 20);
  `derived_signals.stale_slots` reflete slots persistidos com `stale != 'fresh'`;
  trocar item ativo invalida a oferta do item antigo e marca seus slots como
  `stale_strong`.
- Hardening PR 3 (2026-05-08): `ActionValidator` valida pre-condicoes de
  carrinho/draft/escalacao; `session_events` ganhou eventos especificos
  `cart_added`, `cart_removed`, `cart_updated`, `cart_cleared` e
  `draft_updated`; `cart_events` agora usa `updated` para mudanca de quantidade.
- Generator v1.3.2 (2026-05-08): dados de fechamento tem prioridade de memoria.
  Se o cliente informa nome/pagamento/endereco ou diz "pode fechar", o Generator
  deve emitir `update_draft` e responder que um atendente confirmara
  produto/estoque antes de fechar, sem inventar disponibilidade.
  Validado no Chatwoot conversa `453`: `update_draft` + `draft_updated` gravados.
- Exemplo validado: para pedido de par Pirelli/Biz 125, o Generator pediu
  dados faltantes sem inventar preco, estoque ou frete.

## Validacao Atual

Ultima validacao (PR 3):

- `npm run typecheck`: verde.
- `npm test`: 380/380 verde, 51 arquivos.
- `npx vitest run --config vitest.integration.config.ts tests/integration/atendente-state-persistence.integration.test.ts`: 8/8 verde.
- `npm run build`: verde.
- Migration `0029`: aplicada/verificada no Supabase atual antes do push.
- Smoke LLM real via Chatwoot fake `pr12-chatwoot-1778211526899`: 13 mensagens
  ingeridas, 15 facts da Organizadora, Planner LLM e Generator LLM em shadow,
  sem envio ao cliente.
- Avaliação qualitativa: Organizadora 9/10, Planner 9/10, Generator 8/10,
  fluxo geral 8,7/10. O teste validou correção de contexto e uso de tools;
  ainda falta smoke específico de bloqueio para validar `blocked_say_text`.
- Smoke PR3 pos-deploy (Chatwoot conversa `452`): Organizadora salvou 12 facts;
  Planner LLM `planner_v1.2.5` usou tools comerciais; Generator rodou em shadow
  e bloqueou 1 turno com `stock_claim_without_verificar_estoque`, preservando
  `blocked_say_text`. Sem envio ao cliente. Limite: nao houve `update_draft`
  nesse smoke, entao `draft_updated` ficou validado nos testes determinísticos.
- Smoke `generator_v1.3.2` pos-deploy (Chatwoot conversa `453`): segundo turn
  emitiu `update_draft` com nome, pix, delivery e endereco; `session_events`
  gravou `draft_updated`; resposta pediu confirmacao humana de produto/estoque.
- Smoke test prod 2026-05-05: mensagem 'oi, tem pneu 140/70-17 para Titan?',
  job processado < 7s, turn `skill=pedir_dados_faltantes, status=generated`,
  LLM real gpt-5.4, sem alucinacao comercial.
- Teste real 12 conversas Chatwoot em 2026-05-05 revelou lacuna operacional:
  12 mensagens `message_created/contact` foram normalizadas, mas 6 jobs nasceram
  so apos enfileiramento manual. O hardening de fila adiciona reconciliador
  automatico + endpoint admin para impedir mensagem de cliente sem job.
- Validacao pos-redeploy do hardening (`cc42bfa`), run
  `multiturn-20260505124936`: 6 conversas com 3 mensagens cada no Chatwoot real;
  18/18 mensagens normalizadas em `prod`, 18/18 jobs e 18/18 turns. Zero job
  faltante. Dois jobs tiveram atraso >30s, mas foram recuperados/processados.
  Auditoria de qualidade: 12/18 ok, 6/18 review por frase generica de escalacao,
  uma alegacao de politica/logistica e uma alegacao de disponibilidade de marca.
- Organizadora: 120 enrichment_jobs done, 4 facts corretos, confianca > 0.95.
- Deploy Coolify commit e35ca31: 2026-05-05 10:07, rolling update completed.

## Proxima Fase

Sprint 7: Critic Shadow da Atendente.
- Segundo passe LLM avalia candidato do Generator; bloqueia ou aprova.
- Sem envio Chatwoot no Critic.
- Memoria operacional do Generator ja calibrada antes desta sprint.
- Antes de envio real, Critic/SayValidator devem bloquear alegacoes comerciais
  sem lastro, especialmente `temos <marca> disponivel`, prazo/politica de
  entrega e frases genericas de escalacao em respostas que poderiam pedir dado
  faltante de forma mais natural.

Sprint 6.10 (bloqueado por dados): seed catalogo `commerce.*`.
- Tabelas `products`, `tire_specs`, `vehicle_fitments` vazias; `buscar_e_ofertar` retorna lista vazia.

Sprint 8: envio controlado ao Chatwoot.
- `ChatwootApiClient.postMessage()` + worker envia turn `generated` aprovado.
- Controlado por `ATENDENTE_SEND_ENABLED=false` (default off).

## Documentos De Apoio

- `docs/NEXT_CHAT_HANDOFF.md`
- `docs/HANDOFF.md`
- `docs/CODEX_BRIEFING.md`
- `docs/phase3-agent-architecture/21-atendente-v1-state-design.md`
- `docs/adr/ADR-004-fase-3-arquitetura-agente.md`
