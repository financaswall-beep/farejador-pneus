# Next Chat Handoff - Farejador

Atualizado: 2026-05-05 (Sprints 6.5–6.9 concluidas, em producao).

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
- Sprint 6.5 (loop de estado):
  `worker.ts` itera `generatorResult.actions` e aplica cada action via
  `applyActionAndPersistInTx`. Persiste `session_items`, `session_slots`,
  `cart_current`, `cart_current_items`, `cart_events`, `order_drafts`,
  `pending_confirmations`, `escalations`. Commit `63e40e8`.
- Sprint 6.6 (bridge Organizadora → Context Builder):
  Context Builder le `analytics.conversation_facts` e entrega `organizer_facts`
  ao Planner. Atendente usa fatos extraidos de turnos anteriores. Commit `63e40e8`.
- Sprint 6.7 (Say Validator endurecido):
  Bloqueia afirmacoes comerciais sem evidencia: estoque exige `verificarEstoque`,
  prazo exige `calcularFrete`, compatibilidade exige `buscarCompatibilidade`.
  6 novos testes. Suite: 306 testes. Commit `79c0d19`.
- Sprint 6.8 (filtro sender_type no dispatcher):
  `dispatcher.ts` so enfileira job para `sender_type='contact'`. Mensagens de
  bot, agente humano e sistema descartadas com log `info`. 2 novos testes.
  Suite: 308 testes. Commit `193b4ef`.
- Sprint 6.9 (nota interna Chatwoot ao escalar):
  `ChatwootApiClient.createNote()` — POST `/messages` com `private: true`,
  retry em 5xx/429, timeout 10s. `src/atendente/handlers/escalate.ts` consulta
  `core.conversations`, formata nota com rotulo do motivo + summary_text do LLM,
  chama `createNote` fora da transacao (falha de API nao reverte estado DB).
  No-op silencioso se `CHATWOOT_API_BASE_URL`/`TOKEN`/`ACCOUNT_ID` ausentes.
  5 novos testes. Suite: 313 testes. Commit `e35ca31`. Deploy 2026-05-05.
- Ajuste pre-Critic (memoria operacional em tempo real):
  Generator prompt calibrado para emitir `create_item`, `update_slot` e
  `update_draft` sempre que o cliente informar dados novos na mensagem atual,
  inclusive multiplos pneus/produtos no mesmo turno. O contexto do Generator
  agora recebe `state.items`, `organizer_facts` e `derived_signals`, nao apenas
  o item ativo. 3 novos testes. Suite: 316 testes.

## O Que Ainda Nao Existe

- Critic (Sprint 7).
- Reflection loop.
- Envio Chatwoot pela Atendente (Sprint 8).
- Seed do catalogo `commerce.*` (Sprint 6.10 — depende de dados da loja).
- Atendimento automatico.

## Validacao Atual

Ultima validacao local (pos ajuste de memoria operacional, 2026-05-05):

- `npx vitest run`: 316/316 verde, 49 arquivos.
- `npm run typecheck`: verde.
- `npm run build`: verde.
- Smoke test prod 2026-05-05: mensagem 'oi, tem pneu 140/70-17 para Titan?',
  job processado < 7s, turn `skill=pedir_dados_faltantes, status=generated`,
  LLM real gpt-5.4, sem alucinacao comercial.
- Organizadora: 120 enrichment_jobs done, 4 facts corretos extraidos,
  confianca media > 0.95.

Ultimos commits enviados para `origin/main` e `pneus/main`:

- `e35ca31 feat(atendente): Sprint 6.9 restante — nota interna Chatwoot ao escalar`
- `193b4ef feat(dispatcher): Sprint 6.8 — filtrar sender_type`
- `79c0d19 feat(atendente): Sprint 6.7 — Say Validator endurecido`
- `63e40e8 feat(atendente): Sprints 6.5 + 6.6 — loop de estado e bridge Organizadora`

## Proxima Fase

Três frentes em paralelo (ordenadas por prioridade):

**Sprint 7 — Critic Shadow**:
- Segundo passe LLM avalia o candidato do Generator
- Bloqueia ou aprova, grava auditoria em `agent.*` e `ops.*`
- Nao envia ao Chatwoot no Critic
- Agora faz sentido seguir porque a memoria operacional do Generator foi calibrada.

**Sprint 6.10 — Seed catalogo `commerce.*`** (bloqueado por dados da loja):
- `commerce.products`, `tire_specs`, `vehicle_fitments` estao vazios
- `buscar_e_ofertar` retorna lista vazia — bot faz teatro
- Desbloqueio: Wallace traz CSV/dump real da loja

**Sprint 8 — Envio controlado ao Chatwoot**:
- `ChatwootApiClient.postMessage()` — POST `/messages` com `private: false`
- Worker envia turn `status='generated'` aprovado pelo fluxo de segurança
- Controlado por env var `ATENDENTE_SEND_ENABLED=false` (default off)
- Nao fazer: nao criar pedido automatico; nao enviar sem validator/Critic.

Fluxo alvo pos-Sprint 8:

```text
ops.atendente_jobs
  -> worker pega job
  -> buildPlannerContext
  -> planTurn
  -> executeToolRequests
  -> Generator cria resposta candidata
  -> [Sprint 7] Critic avalia
  -> [Sprint 8] envia ao Chatwoot se aprovado
```
- nao remover o modo shadow/log-only.

## Pergunta Para Comecar O Proximo Chat

"Quero abrir a Sprint 7: desenhar o Critic shadow da Atendente, sem envio
Chatwoot. Antes de codar, confira o estado do repo e proponha o menor plano
seguro."
