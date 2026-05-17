# Migrations — Farejador

Ordem de execução:

1. `0001_init_schemas.sql` — extensions (pgcrypto, pg_trgm, btree_gin), schemas (raw/core/analytics/ops), domínio `env_t`
2. `0002_raw_layer.sql` — `raw.raw_events` particionada mensalmente
3. `0003_core_layer.sql` — contacts, conversations, messages (particionada), attachments, tags, status_events, assignments, reactions
4. `0004_analytics_layer.sql` — conversation_facts (EAV com proveniência), signals, classifications, customer_journey, linguistic_hints
5. `0005_ops_layer.sql` — stock_snapshots, enrichment_jobs, bot_events, erasure_log + `ops.anonymize_contact()`
6. `0006_concurrency_guards.sql` — `raw.delivery_seen` (bouncer dedup), `last_event_at` + trigger watermark em core, helper `ops.ensure_monthly_partitions()`
7. `0007_raw_immutability_guard.sql` — trigger BEFORE UPDATE/DELETE em `raw.raw_events` enforçando imutabilidade do payload (whitelist: processing_status, processing_error, processed_at)
8. `0008_idempotency_constraints.sql` — UNIQUE constraints em `core.conversation_status_events` e `core.conversation_assignments` com script de dedup defensivo prévio
9. `0009_orphan_stub_monitor.sql` — view e função para detectar stubs órfãos
10. `0010_analytics_ruleset_auditability.sql` — auditoria de regras declarativas (F2A-02)
11. `0011_relax_hint_type_check.sql` — relaxa CHECK de hint_type em linguistic_hints
12. `0012_classification_ruleset_auditability.sql` — classificações determinísticas (F2A-03)

### Fase 3 — Agente Conversacional (novas migrations)

13. `0013_commerce_layer.sql` — schema `commerce.*`: products, tire_specs, vehicle_models, vehicle_fitments, product_media, stock_levels, product_prices, geo_resolutions, delivery_zones, store_policies, import_batches, import_errors, fitment_discoveries, orders, order_items
14. `0014_commerce_indexes.sql` — índices fuzzy (pg_trgm) em produtos, veículos, geo; índices de preço e estoque
15. `0015_commerce_views.sql` — views `current_prices`, `product_full`, `customer_profile`, `low_stock_alerts`
16. `0016_agent_layer.sql` — schema `agent.*`: session_current, session_events, turns, pending_confirmations, cart_current, cart_current_items, cart_events, order_drafts, escalations + view `pending_human_closures`
17. `0017_agent_triggers.sql` — triggers de validação cruzada (fitment position vs vehicle_type, cart promotion, draft promotion), updated_at automático, append-only enforcement em session_events e cart_events
18. `0018_analytics_evidence.sql` — `analytics.fact_evidence` (NOVA), views `current_facts` e `current_classifications`. NOTA: `superseded_by` em conversation_facts já existe desde 0004.
19. `0019_ops_phase3_additions.sql` — `ops.atendente_jobs` (NOVA), extensão de `ops.enrichment_jobs` (campos `conversation_id`, `last_message_id`, `not_before`, `locked_at`), `ops.unhandled_messages`, `ops.agent_incidents`, funções `enqueue_enrichment_job` e `enqueue_atendente_job`
20. `0020_vehicle_fitment_validation.sql` — validação de tipo de produto em fitment, validação de produto não-deletado em cart, helpers `find_compatible_tires`, `resolve_neighborhood`, `build_escalation_summary` + view `agent_dashboard`
21. `0021_environment_match_guards.sql` — função paramétrica `ops.validate_env_match` + 30+ triggers que enforçam invariante "prod nunca cruza com test" via FK cross-table. Também adiciona `ops.enforce_environment_immutable` + ~25 triggers que bloqueiam UPDATE de environment (sem isso, env_match seria burlado mudando só environment). Cobre todas as tabelas novas da Fase 3. Tabelas legadas ficam fora do escopo (ver TODO em `0022_environment_immutable_legacy.sql` futura).

22. `0022_conversation_facts_append_ledger.sql` - remove UNIQUE legada de `analytics.conversation_facts` que bloqueava ledger append-only por mesma chave/source/version e cria dedup estreito para repeticao exata da Organizadora.
23. `0023_analytics_marts_v1.sql` - cria schema `analytics_marts.*` com views iniciais de BI: demanda por pneu, bairro/municipio, horario, objecao de preco, concorrentes, intencao e qualidade da Organizadora.
24. `0024_atendente_v1_state_extensions.sql` - extensoes aditivas para o Sprint 1 da Atendente v1: versionamento e idempotencia em `agent.session_current`/`agent.session_events`, novos `event_type`, `agent.session_items` e `agent.session_slots` para estado reentrante com procedencia.
25. `0025_planner_foundation.sql` - base do Sprint 3 Planner: adiciona `planner_decided`, `aliases` em `commerce.vehicle_models`, `commerce.resolve_vehicle_model` e realinha helpers para `fitment_position`, `fitment_source`, `match_similarity`.
26. `0026_tool_executor_events.sql` - base do Sprint 4 Executor: adiciona `tool_executed` e `tool_failed` ao ledger `agent.session_events`.
27. `0027_generator_shadow_events.sql` - base do Sprint 6 Generator Shadow: adiciona `generator_produced` ao ledger `agent.session_events` para auditoria da resposta candidata, sem envio Chatwoot.
28. `0028_generator_blocked_turn_audit.sql` - PR 1 de hardening: adiciona `blocked_say_text`, `blocked_actions` e `blocked_payload` em `agent.turns` para auditar o texto/actions candidatos quando o Generator e bloqueado pelo Say/Action Validator.
29. `0029_cart_action_events_hardening.sql` - PR 3 de hardening: adiciona eventos semânticos de carrinho/draft em `agent.session_events` e `updated` em `agent.cart_events`.
30. `0030_vehicle_resolver_variant_precision.sql` - prioriza match por modelo + versao em `commerce.resolve_vehicle_model`.
31. `0031_human_vs_bot_comparison_view.sql` - cria `ops.human_vs_bot_comparison` para comparar mensagem do cliente, resposta humana real e resposta shadow da Atendente na Fase D.

## Convenções

- Toda tabela tem coluna `environment` (prod/test) via domínio `env_t`
- Idempotência: webhooks usam `raw.delivery_seen (environment, chatwoot_delivery_id)` como bouncer; normalizadas usam `(environment, chatwoot_<entity>_id)`
- Soft-delete via `deleted_at` em contacts/conversations/messages (LGPD)
- Proveniência (truth_type/source/confidence_level/extractor_version) só em `analytics.*`
- FKs cross-schema e para tabelas particionadas são **lógicas** (validadas no ETL, não pelo Postgres)
- TEXT + CHECK em taxonomias voláteis. Promover a ENUM só após 4-8 semanas de dados estáveis

## População por fase

O projeto evolui em 3 fases. Responsabilidades **não** atravessam fronteira de fase.

### Fase 1 — Farejador determinístico (MVP, semanas 1-4)
**Runtime**: serviço Fastify recebendo webhook do Chatwoot.
**Popula**:
- `raw.raw_events` (via bouncer `raw.delivery_seen`)
- `core.contacts`, `core.conversations`, `core.messages`, `core.message_attachments`
- `core.conversation_tags`, `core.conversation_status_events`, `core.conversation_assignments`, `core.message_reactions`
- `ops.erasure_log` (quando houver solicitação LGPD)

**Não popula**: nada em `analytics.*`. `ops.enrichment_jobs`, `ops.stock_snapshots` e `ops.bot_events` permanecem vazias.

**Regra invariante**: zero LLM no runtime. Mapeamento payload → tabelas é 100% determinístico.

### Fase 2a — Enrichment determinístico (semanas 3-6, em paralelo ao final da Fase 1)
**Runtime**: workers async consumindo `ops.enrichment_jobs` com `FOR UPDATE SKIP LOCKED`.
**Popula**:
- `analytics.conversation_signals` via agregação SQL pura (latências, counts, handoff_count)
- `analytics.linguistic_hints` via regex e heurística (sem LLM)
- `analytics.customer_journey` básico (contagem de conversas, canal, migração entre canais)
- `analytics.conversation_classifications` para regras manuais determinísticas (ex: tag `oferta_enviada` → `stage_reached='cotacao'`)

**Propósito**: baseline barato e recomputável. Existe antes da Fase 2b para permitir medir o ganho real do LLM.

### Fase 2b — Enrichment com LLM (mês 2-3)
**Runtime**: worker async separado. Lê conversas de `ops.enrichment_jobs`, chama LLM com prompt versionado.
**Popula**:
- `analytics.conversation_facts` (produto, medida, marca, preço cotado, frete, bairro, motivo de perda)
- `analytics.conversation_classifications` (`stage_reached`, `final_outcome`, `loss_reason` via classificador LLM)
- Transcrição de áudio (Whisper ou similar) → `core.message_attachments.transcription_available = true` + `analytics.conversation_facts` com `fact_key='audio_transcription'`

**Invariantes obrigatórias (toda linha escrita em `analytics.*`)**:
- `source` preenchido (ex: `llm_gpt4o_v3`, `whisper_v2`)
- `extractor_version` preenchido (bumpa quando mudar prompt)
- `confidence_level` entre 0 e 1
- `truth_type` em `('observed', 'inferred', 'predicted', 'corrected')`
- Correção = nova linha com `superseded_by` apontando pra antiga. **Nunca UPDATE**.

**LLM nunca escreve em `raw.*` ou `core.*`**. Se precisar, abre um `ops.enrichment_jobs` para humano revisar.

### Fase 3 — Agente atendente

Migrations 0013-0023 nesta pasta criam o schema `commerce.*` (catálogo + pedidos), `agent.*` (estado vivo do atendimento), estendem `analytics.*`/`ops.*` e adicionam `analytics_marts.*` para BI inicial.

**Topologia (ver `docs/phase3-agent-architecture/14-topologia-de-execucao.md`):**

- **Farejador API** (síncrono, leve): webhook do Chatwoot, grava `raw.*`+`core.*`, enfileira `ops.atendente_jobs` e `ops.enrichment_jobs`. Responde 200 rápido.
- **Atendente Worker** (async, baixa latência): consome `ops.atendente_jobs`, monta contexto, chama LLM Atendente, valida `{ say, actions }`, action handlers gravam `agent.*`, posta resposta no Chatwoot via API.
- **Organizadora Worker** (async, debounce 60-120s): consome `ops.enrichment_jobs`, lê `core.messages`, chama LLM Organizadora com schema fechado (`segments/moto-pneus/extraction-schema.json`), grava `analytics.*` (append-only com `superseded_by` e `fact_evidence` literal).

**Princípios sagrados:**

- Webhook nunca dispara LLM síncrona (200-rápido obrigatório)
- LLM Atendente nunca toca o banco — apenas via `action handler` validado
- LLM Organizadora extrai apenas `fact_keys` da whitelist (chave fora vira `ops.agent_incidents.schema_violation`)
- `analytics.*` é append-only: mudança de fato vira nova linha + `superseded_by`. Nunca UPDATE de valor.
- `agent.*` é rascunho/estado vivo. `commerce.*` é venda confirmada. Promoção via `agent.order_drafts.promoted_order_id`.

**Shadow Assistido** (5 semanas): Wallace atende manualmente. Farejador captura. Organizadora processa. Atendente fica desligada por feature flag. Calibração antes de ligar.

### Fase 4 — Fora do plano ativo
Treinar LLM próprio a partir do dataset capturado permanece apenas como possibilidade de roadmap distante. Não planejar, não pré-otimizar para isso.

## Extensão de partições

As migrations criam partições iniciais até 2026-06. A migration `0006` adiciona o helper `ops.ensure_monthly_partitions(p_months_ahead)` que cria partições mensais para `raw.raw_events` e `core.messages` de forma idempotente.

**Dev/staging** — rode quando precisar:
```sql
SELECT * FROM ops.ensure_monthly_partitions(6);
```

**Produção** — agende via `pg_cron` (disponível no Supabase). **Isso é requisito de produção, não opcional.** Sem o cron, as partições de julho em diante não existem e inserções falham silenciosamente:

```sql
-- Rodar UMA VEZ para ativar o agendamento:
SELECT cron.schedule(
  'farejador-ensure-partitions',
  '0 3 20 * *',  -- dia 20 de cada mês, 03:00 UTC — antes do fim do mês
  $$ SELECT ops.ensure_monthly_partitions(3) $$
);

-- Verificar que ficou ativo:
SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'farejador-ensure-partitions';
```

Para habilitar pg_cron no Supabase: Dashboard → Database → Extensions → buscar `pg_cron` → Enable.

Alternativa industrial: instalar `pg_partman` para gestão automática com retenção/detach. Para o volume atual, o helper é suficiente.

## Concorrência — regras obrigatórias do ETL

### 1. Dedup de webhook (retry do Chatwoot)
Antes de inserir em `raw.raw_events`, reivindicar o `delivery_id` em `raw.delivery_seen`:

```sql
WITH claim AS (
  INSERT INTO raw.delivery_seen (environment, chatwoot_delivery_id)
  VALUES ($1, $2)
  ON CONFLICT DO NOTHING
  RETURNING 1
)
INSERT INTO raw.raw_events (environment, chatwoot_delivery_id, ...)
SELECT $1, $2, ... WHERE EXISTS (SELECT 1 FROM claim);
```

Se `claim` vier vazio, webhook é duplicata. Responde 200 pro Chatwoot sem tocar em nada.

### 2. Watermark de ordem em `core.*`
Todo upsert em `core.contacts`, `core.conversations`, `core.messages` **deve** passar `last_event_at` (= `X-Chatwoot-Timestamp` ou `payload.updated_at`). O trigger `core.skip_stale_update` converte em no-op qualquer UPDATE com watermark menor.

Redundância defensiva recomendada no SQL da aplicação:
```sql
INSERT INTO core.conversations (..., last_event_at) VALUES (..., $N)
ON CONFLICT (environment, chatwoot_conversation_id) DO UPDATE
SET ..., last_event_at = EXCLUDED.last_event_at
WHERE EXCLUDED.last_event_at >= core.conversations.last_event_at;
```

### 3. Workers de `ops.enrichment_jobs`
**Obrigatório** `FOR UPDATE SKIP LOCKED` no pull:

```sql
SELECT id, target_type, target_id, job_type
FROM ops.enrichment_jobs
WHERE status = 'queued' AND scheduled_at <= now()
ORDER BY priority, scheduled_at
LIMIT 10
FOR UPDATE SKIP LOCKED;
```

Sem `SKIP LOCKED`, dois workers em paralelo processam o mesmo job — custo real em chamadas LLM.

### 4. Upsert de agregados analíticos
`analytics.conversation_signals` e `analytics.customer_journey` são recomputados. Upsert deve preservar `computed_at` mais recente:

```sql
ON CONFLICT (conversation_id) DO UPDATE
SET computed_at = GREATEST(conversation_signals.computed_at, EXCLUDED.computed_at),
    ... = CASE WHEN EXCLUDED.computed_at >= conversation_signals.computed_at
               THEN EXCLUDED.... ELSE conversation_signals.... END;
```

## Anonimização LGPD

```sql
SELECT ops.anonymize_contact(
  p_contact_id   => '<uuid>',
  p_requested_by => 'cliente_via_whatsapp',
  p_executed_by  => 'sistema_automatico',
  p_reason       => 'solicitação formal direito ao esquecimento'
);
```

Zera PII do contato, mantém agregados, registra em `ops.erasure_log`.
