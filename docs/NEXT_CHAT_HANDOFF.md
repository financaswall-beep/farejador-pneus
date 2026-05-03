# Next Chat Handoff - Farejador

Atualizado: 2026-05-03 (Sprint 6 concluida).

Use este resumo para continuar em outro chat sem reler a conversa inteira.

## Onde Estamos

Estamos construindo a Atendente por camadas, mas ela ainda nao envia mensagem ao
cliente. O sistema atual em producao captura Chatwoot, normaliza, roda
Organizadora LLM, roda a fundacao da Atendente em shadow incluindo o Generator
(que gera resposta candidata auditavel, mas nao envia nada).

## Ja Implementado

Base:

- Fase 1: webhook Chatwoot, `raw.*`, `core.*`, admin replay/reconcile.
- Fase 1.5: hardening de imutabilidade, idempotencia e guards.
- Fase 2a: enrichment deterministico.
- Fase 3 Organizadora: LLM em background escrevendo facts/evidence em
  `analytics.*`.
- Analytics marts v1.

Atendente:

- Sprint 1: estado reentrante com `agent.session_items`,
  `agent.session_slots`, `action_id`, versionamento e `applyAction`.
- Sprint 2: tools deterministicas:
  `buscarProduto`, `verificarEstoque`, `buscarCompatibilidade`,
  `calcularFrete`, `buscarPoliticaComercial`.
- Sprint 3: Context Builder + Planner foundation:
  `planner_decided`, `PlannerOutput`, `tool_requests` com input validado,
  `POLICY_VALUE_SCHEMAS`, `resolve_vehicle_model`.
- Sprint 4: Tool Executor + guardrails:
  `tool_executed/tool_failed`, `executeToolRequests`, `SayValidator` inicial,
  `ActionValidator` reforcado.
- Hardening pos-auditoria:
  logger estruturado, dinheiro com milhar, ids deterministicos compartilhados,
  idempotencia por turno no Planner.
- Sprint 5: Worker Shadow minimalista:
  `src/atendente/worker.ts`, consumo de `ops.atendente_jobs`,
  `buildPlannerContext`, `planTurn`, `recordPlannerDecision`,
  `executeToolRequests`, `recordToolExecutionResults`. Desligado por default
  via `ATENDENTE_SHADOW_ENABLED=false`.
- Enqueue da Atendente:
  `src/normalization/dispatcher.ts` enfileira `ops.atendente_jobs` em
  `message_created` quando `ATENDENTE_SHADOW_ENABLED=true`, via
  `ops.enqueue_atendente_job` idempotente por `trigger_message_id`. Antes do
  enqueue, cria/atualiza `agent.session_current` para a conversa.
- Sprint 6: Generator Shadow:
  `src/atendente/generator/service.ts`, gera resposta candidata auditavel,
  valida com `SayValidator`/`ActionValidator`, grava em `agent.turns`
  (status='generated'|'blocked') e `agent.session_events`
  (event_type='generator_produced'). Nunca envia ao Chatwoot. Nunca escreve
  em raw/core/analytics/commerce. Controlado por `GENERATOR_LLM_ENABLED`
  (default false). Migration `0027_generator_shadow_events.sql` aplicada no
  Supabase atual em 2026-05-03 (adiciona 'generator_produced' ao CHECK de
  `agent.session_events`). Em producao atual, LLM real esta habilitado em
  shadow com `GENERATOR_OPENAI_API_KEY` e `GENERATOR_MODEL` configurados.
- Organizadora v3.4 calibrada:
  prompt `moto-pneus-hybrid-v3-4`, com valores permitidos gerados a partir
  de `FACT_KEY_SCHEMAS`; corrigiu aliases/tipos que causavam `schema_violation`.

## O Que Ainda Nao Existe

- Critic.
- Reflection loop.
- Envio Chatwoot pela Atendente.
- Atendimento automatico.

## Validacao Atual

Ultima validacao local (pos Sprint 6 + Organizadora v3.4):

- `npm test`: 296/296 verde.
- `npm run typecheck`: verde.
- `npm run build`: verde.
- Migration `0027` aplicada/verificada no Supabase atual.
- Teste em producao com 6 conversas Chatwoot: Atendente shadow criou jobs,
  turns e eventos `generator_produced`; Generator LLM real gerou respostas
  candidatas em `agent.turns` sem envio ao cliente.
- Organizadora v3.4 extraiu facts novos sem novos `schema_violation`.
- Scripts operacionais locais foram higienizados em 2026-05-03 para depender de
  `.env` e nao manter secrets/endpoints reais hardcoded no repo.

Ultimos commits enviados para `origin/main` e `pneus/main`:

- `56dfc0e feat: tune organizadora prompt v3.4`
- `b9757ba fix: seed atendente shadow sessions`
- `706d9f9 feat: enqueue atendente shadow jobs`
- `866bae6 feat: add atendente generator shadow (sprint 6)`

## Proxima Fase

Sprint 7: Critic Shadow da Atendente.

Objetivo: avaliar a resposta candidata do Generator antes de qualquer envio ao
cliente. O Critic deve ser capaz de bloquear ou aprovar o candidato, registrando
auditoria em `agent.*` e `ops.*`.

Fluxo esperado:

```text
ops.atendente_jobs
  -> worker pega job
  -> buildPlannerContext
  -> planTurn
  -> executeToolRequests
  -> Generator cria resposta candidata
  -> Critic avalia o candidato
  -> grava auditoria shadow
  -> para (sem envio Chatwoot)
```

Nao fazer ainda:

- nao enviar Chatwoot;
- nao ativar envio automatico;
- nao criar pedido automatico.
- nao remover o modo shadow/log-only.

## Pergunta Para Comecar O Proximo Chat

"Quero abrir a Sprint 7: desenhar o Critic shadow da Atendente, sem envio
Chatwoot. Antes de codar, confira o estado do repo e proponha o menor plano
seguro."
