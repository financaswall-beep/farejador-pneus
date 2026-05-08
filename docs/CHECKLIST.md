# Checklist Master - Farejador

Atualizado: 2026-05-08

> Nota: este checklist preserva historico das Fases 1/2a. Para o estado vivo
> da Fase 3 e proximo passo, use `docs/NEXT_CHAT_HANDOFF.md` e
> `docs/phase3-agent-architecture/00-estado-de-implementacao.md`.

## 0. Estado Atual Resumido

- [x] Fase 1 em prod.
- [x] Fase 2a concluida.
- [x] Organizadora LLM em prod.
- [x] Atendente Sprint 1: estado reentrante.
- [x] Atendente Sprint 2: tools deterministicas.
- [x] Atendente Sprint 3: Planner foundation.
- [x] Atendente Sprint 4: Executor/guardrails.
- [x] Atendente Sprint 5: Worker Shadow minimalista.
- [x] Atendente Sprint 6: Generator shadow.
- [x] Generator LLM real validado em shadow, sem envio Chatwoot.
- [x] Atendente Sprint 6.5: loop de estado (applyActionAndPersistInTx).
- [x] Atendente Sprint 6.6: bridge Organizadora → Context Builder.
- [x] Atendente Sprint 6.7: Say Validator endurecido.
- [x] Atendente Sprint 6.8: filtro sender_type no dispatcher.
- [x] Atendente Sprint 6.9: nota interna Chatwoot ao escalar.
- [x] Ajuste pre-Critic: memoria operacional do Generator (create_item, update_slot em tempo real).
- [x] Fix planner_v1.2.5: Planner usa organizer_facts para buscarCompatibilidade.
- [x] Fix generator_v1.3.1: Generator proibe SAFE_FALLBACK em pedir_dados_faltantes.
- [x] Fix phase3 dedup: facts identicos nao geram nova linha no ledger.
- [x] PR 1 Generator audit: turns bloqueados preservam candidato em
  `blocked_say_text`/`blocked_payload`; `update_draft` tem metacampos.
- [x] PR 2 Estado/contexto: Context Builder com limite configuravel,
  `stale_slots` carregado do banco e invalidações ampliadas de oferta/slots.
- [x] Validacao qualidade end-to-end Organizadora+Planner+Generator em prod (2026-05-06).
- [ ] Critic (Sprint 7).
- [ ] Envio Chatwoot pela Atendente (Sprint 8).
- [ ] Seed catalogo commerce.* (Sprint 6.10).

Legenda: feito, em andamento, proximo, futuro.

## 1. Infraestrutura

- [x] Stack definida: TypeScript, Node.js, Fastify, Zod, pg, Pino, Vitest.
- [x] Arquitetura em fases documentada.
- [x] Invariantes documentadas: raw imutavel, dedup, environment, watermark, LLM fora de raw/core.
- [x] Repositorio local em `C:\Farejador agente`.
- [x] Dependencias instaladas.
- [x] `.env.codex` configurado para validacao local.
- [x] Conexao Supabase validada.
- [x] Migrations aplicadas no Supabase usado na validacao.
- [x] Scripts operacionais higienizados para usar `.env` em vez de secrets ou
  endpoints reais hardcoded.
- [x] GitHub remoto atualizado ate F1-03.
- [x] Deploy Coolify do Farejador validado.
- [x] Supabase Connection Pooler validado no Coolify.
- [x] Chatwoot real conectado ao Farejador em shadow mode.
- [x] Teste de 6 conversas Chatwoot em prod validou Organizadora v3.4 e
  Generator LLM real em shadow.

## 2. Schema do banco

- [x] `0001_init_schemas.sql`
- [x] `0002_raw_layer.sql`
- [x] `0003_core_layer.sql`
- [x] `0004_analytics_layer.sql`
- [x] `0005_ops_layer.sql`
- [x] `0006_concurrency_guards.sql`
- [x] `db/migrations/README.md`

## 3. Documentacao de controle

- [x] `AGENTS.md`
- [x] `docs/PROJECT.md`
- [x] `docs/KIMI_RULES.md`
- [x] `docs/CONTRACTS.md`
- [x] `docs/CONFIG.md`
- [x] `docs/LOGGING.md`
- [x] `docs/REVIEW_PROTOCOL.md`
- [x] `docs/HANDOFF.md`
- [x] `docs/CHECKLIST.md`
- [x] `docs/DATA_DICTIONARY.md`
- [x] `docs/BASE_FORK_POINT.md`
- [x] `docs/TIRE_SALES_SYNTHETIC_SCENARIOS.md`
- [x] `docs/phases/PHASE_01.md`
- [x] `docs/tasks/F1-01-webhook.md`
- [x] `docs/tasks/F1-02-normalization.md`
- [x] `docs/tasks/F1-03-admin.md`
- [x] `docs/tasks/F1-04-tests.md`

## 4. Fase 1

### F1-04 - Fixtures e testes base

- [x] Fixtures Chatwoot sinteticas.
- [x] Fixtures sinteticas de cenarios de venda de pneus.
- [x] Helpers de HMAC.
- [x] Testes de contratos.
- [x] Fixtures sanitizadas.

### F1-01 - Webhook end-to-end

- [x] `POST /webhooks/chatwoot`.
- [x] HMAC timing-safe.
- [x] HMAC oficial do Chatwoot validado com `timestamp.raw_body`.
- [x] Timestamp expirado rejeitado.
- [x] Dedup via `raw.delivery_seen`.
- [x] Insert em `raw.raw_events`.
- [x] Resposta 2xx rapida.
- [x] Shutdown gracioso.
- [x] Validacao end-to-end contra Supabase.

### F1-02 - Normalizacao deterministica

- [x] Worker com `FOR UPDATE SKIP LOCKED`.
- [x] Uma transacao por raw_event.
- [x] `SAVEPOINT normalize_event` preservado para marcar `failed` sem soltar lock.
- [x] Dispatcher por event_type.
- [x] Mappers de contact, conversation, message, attachment, status event, assignment, reaction e tag.
- [x] Repositories para `core.*`.
- [x] Upserts com watermark em contacts/conversations/messages.
- [x] Idempotencia em tags, status events, assignments, attachments e reactions.
- [x] Stub de conversa para mensagem fora de ordem.
- [x] Attachments usam UUID de conversa retornado por `upsertMessage`.
- [x] Reaction placeholder gera `logger.warn`.
- [x] Sem analytics, sem ops.enrichment_jobs, sem LLM e sem chamada externa.
- [x] `npm test` 192/192.
- [x] `npm run typecheck` verde.
- [x] `npm run build` verde.

### F1-03 - Admin endpoints

- [x] `GET /healthz`.
- [x] Auth bearer timing-safe para `/admin/*`.
- [x] `POST /admin/replay/:raw_event_id`.
- [x] Replay com `FOR UPDATE` e reset apenas de campos operacionais.
- [x] `POST /admin/reconcile`.
- [x] Cliente API Chatwoot com timeout, retry e paginacao.
- [x] Reconcile injeta raw_events sinteticos com delivery_id deterministico.
- [x] Reconcile retorna resultado parcial quando a paginacao falha.
- [x] Testes unitarios de auth, health, replay, cliente Chatwoot, reconcile service e route.
- [x] `npm test` 192/192.
- [x] `npm run typecheck` verde.
- [x] `npm run build` verde.
- [x] Teste manual com Chatwoot real e Supabase real para webhook, contato, conversa e mensagem.

## 5. Fechamento da Fase 1 tecnica

- [x] `/admin/replay/:id` reprocessa uma linha `failed` no contrato unitario.
- [x] `/admin/reconcile` traz conversas faltantes sem duplicar no contrato unitario.
- [x] Farejador publicado no Coolify e conectado ao Supabase.
- [x] Webhook real Chatwoot -> Farejador confirmado em `raw.raw_events`.
- [x] Definir protecao contra ruido de `message_updated` antes de religar webhook da inbox API. Implementado via `SKIP_EVENT_TYPES` (CSV) com filtro no dispatcher; raw permanece gravado e o evento e marcado como `skipped`.
- [x] Webhook da inbox API religado com `SKIP_EVENT_TYPES=message_updated`.
- [x] Payload real aninhado do Chatwoot tratado nos mappers/dispatcher.
- [x] Teste final validou `core.contacts`, `core.conversations` e `core.messages` vinculados.
- [x] Cenarios sinteticos de venda de pneus processados no Supabase real com `environment=test`: 49/49 `processed`, 0 `failed`.
- [x] Idempotencia dos cenarios sinteticos validada: segunda execucao com 49/49 duplicatas ignoradas.
- [x] Replay real nao duplica `core.messages`: raw_event `111` reprocessado, contagem da conversa 8 permaneceu estavel.
- [x] Reconcile real em janela pequena injeta `raw_events` e e idempotente: primeira rodada inseriu reconcile events; segunda rodada retornou `inserted=0`, `skipped_duplicate=12`.
- [x] Bug real de duplicacao por precisao de timestamp corrigido em `core.messages`; replay dos eventos reconcile nao recriou duplicatas.
- [x] Dois workers concorrentes validados contra Supabase real em `environment=test`: 80 raw_events, 80 `processed`, 0 duplicatas em `core.messages`.
- [x] Fase 1 tecnica concluida e apta a abrir Fase 2a.

Ressalvas antes de producao plena:

- [x] Shadow mode com webhooks reais validado em 2026-05-03.
  - Observacao: Organizadora v3.4 e Generator LLM real foram testados com 6
    conversas Chatwoot; sem envio ao cliente e sem novos `schema_violation`.
- [x] ~~Rotacionar secrets antes de producao plena.~~ Dispensado em 26/04/2026: o repo base `farejador-base-v1` sera arquivado como template; fork operacional sera repo novo com secrets novos por construcao.
- [x] ~~Configurar `DATABASE_CA_CERT` no Coolify para SSL com validacao de certificado.~~ Resolvido em 26/04/2026: Supabase connection pooler nao suporta validacao de cadeia. SSL permanece ativo via `rejectUnauthorized:false` (conexao criptografada). Variavel removida do `env.ts` e do `db.ts`.

## 5.1 F1.5 - Hardening pre-producao plena (2026-04-25)

Auditoria tecnica completa realizada antes de producao plena. Itens aplicados e deployados:

- [x] Trigger `raw.enforce_raw_event_immutability` em `raw.raw_events`: bloqueia UPDATE em payload/event_type/delivery_id e bloqueia DELETE. Whitelist: `processing_status`, `processing_error`, `processed_at`. Propagado para todas as particoes. Validado no Supabase real (rejeitou UPDATE em id=174).
- [x] UNIQUE constraint `status_events_dedup_key` em `core.conversation_status_events (environment, chatwoot_conversation_id, event_type, occurred_at)`: fecha race condition de dedup concorrente.
- [x] UNIQUE constraint `assignments_dedup_key` em `core.conversation_assignments (environment, conversation_id, agent_id, assigned_at)`: idem.
- [x] Repositories de status events e assignments usam `ON CONFLICT ON CONSTRAINT ... DO NOTHING`: duplicata concorrente vira no-op idempotente, nao `failed`.
- [x] Reconcile delivery_id versionado: formato `reconcile-v2:tipo:env:account_id:id:ts` inclui `account_id` para evitar colisao cross-account.
- [x] SSL ativo com `rejectUnauthorized:false` via Supabase pooler; `DATABASE_CA_CERT` removido porque o pooler nao suporta validacao de cadeia.
- [x] `first_seen_at` em `core.contacts`: nao zera mais no `ON CONFLICT DO UPDATE`; `COALESCE(now())` no INSERT garante preenchimento na primeira vez.
- [x] `MAX_PER_POLL` (renomeado de `BATCH_SIZE`): comportamento documentado - encerra ciclo cedo se fila vazia, nao e limite de tentativas.
- [x] View `ops.orphan_conversation_stubs` + funcao `ops.report_orphan_stubs()`: detecta conversas-stub com `last_event_at IS NULL` ha mais de 10 minutos. 80 stubs de teste identificados (environment=test, conc. test 25/04).
- [x] `db/migrations/README.md` atualizado: 0007 e 0008 na lista de ordem; pg_cron marcado como requisito de producao (nao opcional).
- [x] `.env.example` atualizado sem `DATABASE_CA_CERT`.

Pendente da F1.5:
- [x] Harness de integracao com Postgres real criado via Testcontainers e GitHub Actions. Execucao local pendente por falta de Docker Desktop.
- [ ] Zod permissivo nos mappers criticos (contact, conversation, message).
- [x] Limpar body legado do handler e migrar testes para caminho real de producao.

## 6. Futuro

- [ ] Fase 2a: enrichment deterministico em `analytics.*`.
  - [x] Arquitetura F2a documentada.
  - [x] Guia de implementacao para Kimi documentado.
  - [x] Prompt F2A-01 criado.
  - [x] F2A-01: `conversation_signals` genericos implementado, auditado e publicado.
  - [x] F2A-02: motor generico de regras declarativas, routing, `_template` e UNIQUE de hints.
  - [x] Auditoria pos-F2A-02: migration `0011` relaxa CHECK de `hint_type`; `SIGNAL_TIMEZONE` parametrizado; `SEGMENTS_BASE` via `import.meta.url`.
  - [x] F2A-03: classificacoes deterministicas genericas.
  - [x] F2A-04: fronteira do fork - checklist tecnico verde; tag farejador-base-v1 aguardando aprovacao do Wallace.
  - [x] Harness de integracao com Postgres real criado via Testcontainers e GitHub Actions.
  - [ ] Execucao local de `npm run test:integration` pendente porque Docker Desktop nao esta instalado nesta maquina.
  - [x] Stubs orfaos em `environment=test` documentados como dataset tecnico de concorrencia; nao bloqueiam a base.
  - [ ] F2A-05: pacote `segments/tires` completo continua pendente; hoje existe `segments/moto-pneus/extraction-schema.json` para a Organizadora.
- [ ] Fase 2b: enrichment com LLM escrevendo somente em `analytics.*`.
- [ ] Fase 3: agente conversacional separado, read-only sobre Farejador.

## 7. Fase 3 - Agente Conversacional

### 7.1 Etapa A - Documentacao de arquitetura (concluida)

- [x] `docs/phase3-agent-architecture/01-visao-geral.md`
- [x] `docs/phase3-agent-architecture/02-principios-operacionais.md`
- [x] `docs/phase3-agent-architecture/03-mapa-de-dados.md`
- [x] `docs/phase3-agent-architecture/04-blocos-do-banco.md`
- [x] `docs/phase3-agent-architecture/05-fact-ledger-organizadora.md`
- [x] `docs/phase3-agent-architecture/06-agent-state-atendente.md`
- [x] `docs/phase3-agent-architecture/07-commerce-grafo-veicular.md`
- [x] `docs/phase3-agent-architecture/08-business-intelligence-data-king.md`
- [x] `docs/phase3-agent-architecture/09-skills-router-e-validadores.md`
- [x] `docs/phase3-agent-architecture/10-plano-de-fases.md`
- [x] `docs/phase3-agent-architecture/11-perguntas-abertas.md`
- [x] `docs/phase3-agent-architecture/12-context-builder-e-slot-filling.md`
- [x] `docs/phase3-agent-architecture/13-fluxo-de-eventos-e-integracao.md`
- [x] `docs/phase3-agent-architecture/14-topologia-de-execucao.md`
- [x] `docs/phase3-agent-architecture/15-shadow-assisted-mode.md`
- [x] `docs/phase3-agent-architecture/16-planejamento-tabelas-em-portugues.md`
- [x] `docs/phase3-agent-architecture/17-mapa-portugues-ingles.md`
- [x] `docs/phase3-agent-architecture/18-diagrama-er.md`
- [x] `docs/adr/ADR-004-fase-3-arquitetura-agente.md`
- [x] `segments/moto-pneus/extraction-schema.json`
- [x] `docs/DATA_DICTIONARY.md` atualizado com Fase 3

### 7.2 Etapa B - Migrations SQL

- [x] `0013_commerce_layer.sql` (products, tire_specs, vehicle_models, fitments, media, stock, prices, geo, orders, etc.)
- [x] `0014_commerce_indexes.sql` (fuzzy via pg_trgm, indices de preco e estoque)
- [x] `0015_commerce_views.sql` (current_prices, product_full, customer_profile, low_stock_alerts)
- [x] `0016_agent_layer.sql` (session, turns, cart, order_drafts, escalations + view pending_human_closures)
- [x] `0017_agent_triggers.sql` (validacoes cross-table, updated_at, append-only enforcement)
- [x] `0018_analytics_evidence.sql` (fact_evidence + views current_facts e current_classifications)
- [x] `0019_ops_phase3_additions.sql` (atendente_jobs, enrichment_jobs upgrade, unhandled_messages, agent_incidents + funcoes enqueue)
- [x] `0020_vehicle_fitment_validation.sql` (validacoes finais + helpers find_compatible_tires, resolve_neighborhood, build_escalation_summary + agent_dashboard)
- [x] `0021_environment_match_guards.sql` (funcao parametrica + 30+ triggers env_match cross-table; enforce prod/test no banco)
- [x] `0022_conversation_facts_append_ledger.sql` (libera ledger append-only real em conversation_facts; aplicada em Supabase prod em 2026-04-29)
- [x] `0023_analytics_marts_v1.sql` (views `analytics_marts.*`)
- [x] `0024_atendente_v1_state_extensions.sql` (estado reentrante da Atendente)
- [x] `0025_planner_foundation.sql` (Planner foundation)
- [x] `0026_tool_executor_events.sql` (eventos do Tool Executor)
- [x] `0027_generator_shadow_events.sql` (evento `generator_produced`)
- [x] `0028_generator_blocked_turn_audit.sql` (candidato bloqueado em `agent.turns`)
- [x] Cada migration idempotente (CREATE/ALTER IF NOT EXISTS)
- [x] Migration `0028` aplicada/validada no Supabase atual para este deploy/push
- [ ] Testes de integracao por migration (Kimi escreve depois)

### 7.3 Etapa C - Codigo TypeScript

- [x] `src/shared/types/agent.ts` — interfaces para agent.* (session, turns, cart, drafts, escalations)
- [x] `src/shared/types/commerce.ts` — interfaces para commerce.* (products, tire_specs, fitments, orders, views)
- [x] `src/shared/types/analytics-phase3.ts` — fact_evidence, current_facts, current_classifications
- [x] `src/shared/types/ops-phase3.ts` — atendente_jobs, unhandled_messages, agent_incidents
- [x] `src/shared/zod/agent-actions.ts` — discriminated union das 8 actions + llmAtendenteResponseSchema
- [x] `src/shared/zod/fact-keys.ts` — schemas individuais dos 30 fact_keys + validateFactValue()
- [x] `src/shared/zod/llm-organizadora.ts` — envelope da Organizadora + parseOrganizadoraResponse()
- [x] `src/shared/llm-clients/openai.ts` — cliente OpenAI via fetch nativo (timeout, 1 retry)
- [x] `src/shared/repositories/ops-phase3.repository.ts` — pickEnrichmentJob, markJobRunning/Done/Failed, logIncident
- [x] `src/shared/repositories/analytics-phase3.repository.ts` — writeFactWithEvidence (fact + supersede + evidence)
- [x] `src/shared/repositories/core-reader.repository.ts` — listMessagesForOrganizadora, getContactByConversationId
- [x] `src/persistence/enrichment-jobs.repository.ts` — enqueueOrganizadoraJob via ops.enqueue_enrichment_job()
- [x] `src/normalization/dispatcher.ts` — enfileira job após message_created quando ORGANIZADORA_ENABLED=true
- [x] `src/organizadora/prompt.ts` — buildOrganizadoraPrompt (system + transcrição com msg_ids)
- [x] `src/organizadora/worker.ts` — loop completo: pickup → LLM → validate → write facts → mark done
- [x] `src/organizadora/index.ts` — entrypoint com graceful shutdown
- [x] `src/shared/config/env.ts` — ORGANIZADORA_ENABLED, OPENAI_API_KEY, OPENAI_MODEL, debounce, poll interval
- [x] `.env.example` — variáveis da Organizadora documentadas
- [x] `src/app/server.ts` — integra startOrganizadora() no boot quando ORGANIZADORA_ENABLED=true
- [x] `npm run typecheck` verde (0 erros)
- [x] `npm test` verde (296/296 em 2026-05-03)
- [x] `simulate-chatwoot.bat` / `simulate-chatwoot.cjs` — simulador direto ao Farejador (bypassa Chatwoot)
- [x] `chatwoot-chat.bat` / `chatwoot-chat.cjs` — simulador via API Chatwoot real (conversas aparecem no Chatwoot)
- [x] `src/atendente/validators/` - SayValidator, ActionValidator e validacao de tool results
- [x] `src/atendente/worker.ts` - Worker Shadow log-only da Atendente
- [x] `src/shared/repositories/ops-atendente.repository.ts` - fila da Atendente
- [x] Generator shadow da Atendente
- [x] Enqueue da Atendente em `message_created` atras de
  `ATENDENTE_SHADOW_ENABLED=true`, com seed de `agent.session_current` antes
  do job.

**Bugs encontrados e corrigidos em 2026-04-29:**
- [x] `src/shared/llm-clients/openai.ts`: `max_tokens` → `max_completion_tokens` (gpt-5.x rejeita `max_tokens` com HTTP 400)
- [x] `src/organizadora/worker.ts`: SAVEPOINT por fato no loop de gravação — sem isso, um erro SQL abortava a transação inteira e todos os fatos seguintes falhavam com "current transaction is aborted"
- [x] `src/organizadora/worker.ts`: incidentes fatais da Organizadora agora persistem fora da transacao que pode dar rollback; `markJobRunning` passa a ser commitado antes do processamento.
- [x] `src/organizadora/worker.ts`: valida `from_message_id` dentro da conversa e `evidence_text` literal antes de gravar fact/evidence.
- [x] `src/shared/repositories/analytics-phase3.repository.ts`: supersedencia deixa de ser cega; fato fraco nao derruba fato forte em `current_facts`.

**Teste manual em prod (2026-04-29):**
- [x] Webhook real Chatwoot → Farejador → Supabase validado
- [x] Organizadora processou conversa real e extraiu fatos: `moto_modelo=Bros` (93%), `posicao_pneu=traseiro` (78%)
- [x] Evidence corretamente vinculada (frase exata da conversa como evidência)
- [x] Teste com conversa longa/densa sintetica validado na matriz v3.3: `S24` extraiu nome, bairro, medida, modelo, posicao, pagamento e entrega.
- [x] Organizadora v3.3 avaliada em 48 cenarios sinteticos: 46 passaram, 2 falhas pequenas documentadas em `docs/ORGANIZADORA_EVAL.md`.
- [x] Organizadora v3.4 validada em prod: corrigiu aliases/tipos que geravam
  `schema_violation` (`cartao`, `retirada_na_loja`, `moto_cilindrada` string,
  `concorrente_citado` boolean).

### 7.4 Etapa D - Shadow Assistido (5 semanas)

- [x] Feature flag `ATENDENTE_SHADOW_ENABLED=false` por default em producao
- [x] LLM Organizadora rodando, populando `analytics.*`
- [ ] Wallace atende manualmente
- [ ] Calibracao semanal:
  - [ ] fact_keys reais vs teoricas (extraction-schema.json ajustado se necessario)
  - [ ] taxa de evidence_not_literal abaixo de 5%
  - [ ] taxa de schema_violation zero
  - [ ] taxonomia de classifications estavel (promove TEXT->ENUM apos 4-8 semanas)
- [ ] Volume esperado: ~100 conversas/dia x 35 dias = ~3.500 conversas
- [ ] Decisao final de ligar Atendente baseada em metricas reais

### 7.5 Etapa E - Atendente em v1

- [x] Generator shadow
- [x] Generator LLM real rodando em shadow e gravando respostas candidatas em
  `agent.turns`, sem envio Chatwoot
- [x] Turns bloqueados mantem auditoria do candidato em `blocked_say_text` e
  `blocked_payload`, sem enviar a frase ao cliente
- [ ] Critic shadow
- [ ] Sugestao assistida para humano
- [ ] Atendente liga envio Chatwoot somente apos autorizacao explicita
- [ ] Pedido NAO criado automaticamente; humano fecha via escalacao
- [ ] Monitoramento: taxa de validator_blocked, llm_timeout, fallback_responder_geral
- [ ] Auditoria semanal de `agent.turns` e `ops.agent_incidents`

### 7.6 Etapa F - BI (Rei dos Dados)

- [x] `0023_analytics_marts_v1.sql` aplicado em Supabase prod (2026-04-29): schema `analytics_marts.*`
- [x] Views v1 criadas e validadas: demanda por pneu, bairro/municipio, horario, objecao de preco, concorrentes, intencao e qualidade da Organizadora
- [x] Doc `20-analytics-marts-v1.md` criado para explicar uso e expansao
- [ ] Marts agregadas com refresh diario
- [ ] Dashboard (Metabase ou similar)
- [ ] Materializar as views mais usadas depois de volume real

### 7.7 Deploy

- [x] Organizadora integrada ao servidor Farejador via `ORGANIZADORA_ENABLED=true` (um serviço único no Coolify)
- [x] Deploy em prod validado em 2026-04-29 (Coolify + Supabase + OpenAI gpt-5.4)
- [x] `NIXPACKS_NODE_VERSION=22` configurado (evita Node 18 EOL)
- [ ] 3 entrypoints definidos: `dist/farejador.js`, `dist/atendente.js`, `dist/organizadora.js`
- [ ] Healthcheck por servico (`/healthz` em portas separadas)
- [ ] Logs estruturados JSON com campo `service`
- [ ] Metricas: latencia webhook->200, latencia job->resposta, backlog por fila

### 7.8 Decisoes ainda em aberto (doc 11)

- [ ] Provider de LLM definitivo
- [ ] Politica de PII no prompt (nome, telefone, endereco)
- [ ] Comportamento fora de horario comercial
- [ ] Politica de retry/fallback de LLM
- [ ] Marts analiticos prioritarios (sessao com Wallace)
