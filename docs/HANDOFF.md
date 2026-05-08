# Handoff - Farejador

Atualizado: 2026-05-08.

Este arquivo e o handoff operacional curto. Para contexto completo da proxima
conversa, use tambem `docs/NEXT_CHAT_HANDOFF.md`.

## Estado Atual

O sistema esta em Fase 3, com a Organizadora em producao/calibrada e a
Atendente construida em camadas. A Atendente ainda nao responde clientes
automaticamente.

Implementado:

- Fase 1: webhook, raw, core, admin replay/reconcile.
- Fase 1.5: imutabilidade, constraints e guards.
- Fase 2a: enrichment deterministico.
- Fase 3 Organizadora: worker LLM, facts, evidence, incidentes.
- Analytics marts v1.
- Atendente Sprint 1: estado reentrante (`session_items`, `session_slots`,
  `action_id`, versionamento).
- Atendente Sprint 2: tools deterministicas de commerce.
- Atendente Sprint 3: Context Builder, Planner schema/service, policy schemas.
- Atendente Sprint 4: Tool Executor, eventos `tool_executed/tool_failed`,
  `SayValidator` inicial e `ActionValidator` reforcado.
- Atendente Sprint 5: Worker Shadow minimalista (`src/atendente/worker.ts`),
  log-only, desligado por default via `ATENDENTE_SHADOW_ENABLED=false`.
- Normalizacao enfileira `ops.atendente_jobs` em `message_created` quando
  `ATENDENTE_SHADOW_ENABLED=true`, usando `ops.enqueue_atendente_job`
  idempotente por mensagem. Antes do enqueue, garante `agent.session_current`
  para a conversa.
- Hardening de fila da Atendente: `src/atendente/reconcile-jobs.ts` busca
  mensagens publicas de cliente em `core.messages` sem job em
  `ops.atendente_jobs` e cria os jobs faltantes com o mesmo caminho idempotente
  (`ensureAtendenteSession` + `ops.enqueue_atendente_job`). O worker shadow roda
  essa reconciliacao a cada minuto para as ultimas 24h; admin pode chamar
  `POST /admin/reconcile/atendente-jobs` para uma janela controlada.
- Atendente Sprint 6: Generator Shadow (`src/atendente/generator/service.ts`).
  Gera resposta candidata auditavel, valida com SayValidator/ActionValidator,
  grava em `agent.turns` (status='generated'|'blocked') e auditoria em
  `agent.session_events` (event_type='generator_produced'). Nunca envia ao Chatwoot.
  Controlado por `GENERATOR_LLM_ENABLED` (default false). Em producao atual,
  o Generator LLM real foi habilitado em shadow com `GENERATOR_OPENAI_API_KEY`
  e `GENERATOR_MODEL` configurados.
- PR 1 de hardening do Generator (2026-05-07): `agent.turns` ganhou
  `blocked_say_text`, `blocked_actions` e `blocked_payload` para preservar
  candidatos bloqueados sem enviar nada ao cliente. `update_draft` agora e
  hidratado com `action_id`, `turn_index`, `emitted_at` e `emitted_by`, e o
  schema exige esses metacampos.
- PR 2 de estado/contexto (2026-05-08): Context Builder usa
  `ATENDENTE_CONTEXT_MESSAGES_LIMIT` (default 20), `loadCurrent` popula
  `derived_signals.stale_slots`, `set_active_item` invalida oferta do item
  antigo e marca slots antigos como `stale_strong`, e `INVALIDATION_RULES`
  cobre slots comerciais reais que faltavam.
- PR 3 de validators/eventos (2026-05-08): `ActionValidator` ganhou
  pre-condicoes para carrinho, draft de delivery e escalacao `ready_to_close`;
  `session_events` agora diferencia `cart_added`, `cart_removed`,
  `cart_updated`, `cart_cleared` e `draft_updated`; `cart_events` grava
  `updated` quando `update_cart_item` muda apenas quantidade. Migration `0029`
  aplicada e verificada no Supabase atual.
- Generator `generator_v1.3.2` (2026-05-08): reforco pos-smoke PR3 para gravar
  `update_draft` quando cliente informa fechamento/nome/pagamento/endereco,
  mesmo sem estoque confirmado. Resposta segura deve chamar humano para
  confirmar produto/estoque; nao pode afirmar disponibilidade sem evidencia.
  Smoke real pos-deploy na conversa Chatwoot `453` validou o caminho:
  `update_draft` com nome/pix/entrega/endereco e evento `draft_updated`.
- Organizadora v3.4: prompt `moto-pneus-hybrid-v3-4`, gerando a secao de
  valores permitidos a partir de `FACT_KEY_SCHEMAS`; corrige aliases e tipos
  que geravam `schema_violation`.
- Sprint 6.5: loop de estado — worker itera actions e aplica via
  `applyActionAndPersistInTx`. Persiste `session_items`, `session_slots`,
  `cart_current`, `cart_events`, `order_drafts`, `pending_confirmations`,
  `escalations`. Commit `63e40e8`.
- Sprint 6.6: bridge Organizadora -> Context Builder — lê
  `analytics.conversation_facts` e entrega `organizer_facts` ao Planner.
  Commit `63e40e8`.
- Sprint 6.7: Say Validator endurecido — bloqueia afirmacoes comerciais sem
  evidencia (estoque/prazo/compatibilidade exigem tool correspondente).
  6 novos testes. Commit `79c0d19`.
- Sprint 6.8: filtro sender_type no dispatcher — so enfileira job para
  `sender_type='contact'`; bots/agentes/sistema descartados com log info.
  2 novos testes. Commit `193b4ef`.
- Sprint 6.9: nota interna Chatwoot ao escalar — `ChatwootApiClient.createNote()`
  posta nota `private: true` quando `escalate` é emitido, fora da transacao.
  No-op se variaveis Chatwoot ausentes. 5 novos testes. Commit `e35ca31`.
  Deploy 2026-05-05.
- Ajuste pre-Critic: Generator calibrado para memoria operacional em tempo real.
  Emite `create_item`, `update_slot` e `update_draft` para dados novos do cliente
  na propria mensagem; contexto inclui `state.items`, `organizer_facts` e
  `derived_signals`. 3 novos testes.
- Sprint 6.9 calibracao de prompts: SayValidator endurecido com 3 novos padroes
  (`mixed_safe_fallback_with_other_content`, variante de stock Michelin, variantes
  de prazo/entrega). Planner bumped para `planner_v1.2.0` com secao ROTEAMENTO
  CONVERSACIONAL (7 regras). Generator bumped para `generator_v1.3.0` com regras
  9 e 10 sobre fallback. 8 novos testes. 328/328 verde. Build verde.
- Fix planner_v1.2.5 + generator_v1.3.1 (2026-05-06):
  Tres bugs diagnosticados via auditoria de producao e corrigidos:
  (1) Planner ignorava `organizer_facts` com alta confianca e pedia dados ja
  conhecidos (`pedir_dados_faltantes` em vez de `buscar_e_ofertar`). Corrigido
  via regra de prompt + normalizer deterministico pos-LLM que promove a skill
  quando `moto_modelo` conf>=0.85 e cliente pergunta compatibilidade.
  Versao: `planner_v1.2.5`. 1 novo teste.
  (2) Generator usava SAFE_FALLBACK quando skill era `pedir_dados_faltantes`,
  em vez de perguntar o slot ausente. Corrigido via regra de prompt (regras 5a/5b)
  e novo bloco no SayValidator (`safe_fallback_not_allowed_for_pedir_dados_faltantes`).
  Versao: `generator_v1.3.1`. 2 novos testes.
  (3) Facts identicos eram inseridos como nova linha e depois supersedidos,
  poluindo o ledger. Corrigido com deep-equal check em `writeFactWithEvidence`
  antes do INSERT — se ativo e identical, apenas annexa evidence ao fact existente.
  1 novo teste. Commit `cb5a7f8`. Deploy 2026-05-06. Suite verde naquele ciclo.
- Validacao end-to-end prod 2026-05-06:
  Conv 441 — "Qual pneu traseiro serve pra ela?" (moto Biz 125 2019 ja em
  organizer_facts) -> Planner v1.2.5 escolheu `buscar_e_ofertar +
  buscarCompatibilidade({moto_modelo:'Biz', moto_ano:2019, posicao:'rear'})`
  com confidence 0.96. Antes (v1.2.4) retornava `pedir_dados_faltantes`.
  buscarCompatibilidade retornou [] (catálogo vazio — comportamento correto).
  Generator nao aluciou; usou SAFE_FALLBACK por ausencia de resultado de tool.

Nao implementado/nao ligado:

- Critic (Sprint 7).
- Envio Chatwoot pela Atendente (Sprint 8).
- Seed do catalogo commerce.* (Sprint 6.10).
- Qualquer atendimento automatico ao cliente.

## Ultimas Validacoes

- `npm run typecheck`: verde.
- `npm test`: 380/380 verde, 51 arquivos.
- `npx vitest run --config vitest.integration.config.ts tests/integration/atendente-state-persistence.integration.test.ts`: 8/8 verde.
- `npm run build`: verde.
- Smoke LLM real via Chatwoot fake `pr12-chatwoot-1778211526899`
  (conversa `451`): Organizadora, Planner e Generator rodaram em shadow.
  Organizadora salvou 15 facts; Planner LLM (`planner_v1.2.5`) selecionou
  `buscar_e_ofertar`; Generator LLM (`generator_v1.3.1`) gerou 5 actions,
  sem bloqueio. Nenhuma mensagem foi enviada ao cliente pelo Farejador.
- Avaliação do smoke: Organizadora 9/10, Planner 9/10, Generator 8/10,
  fluxo geral 8,7/10. O principal acerto foi respeitar a correção
  "Bros 160" -> "Biz 125 2019" e usar tools antes da resposta comercial.
  Próximo smoke desejável: forçar bloqueio para validar `blocked_say_text`.
- Smoke PR3 pos-deploy (Chatwoot conversa `452`): Organizadora salvou 12 facts;
  Planner LLM `planner_v1.2.5` chamou tools comerciais; Generator rodou em
  shadow, gerou 2 turns e bloqueou 1 com `stock_claim_without_verificar_estoque`,
  com `blocked_say_text` preservado. Nenhuma mensagem enviada ao cliente.
  Limite: nao houve `update_draft` nesse smoke; `draft_updated` esta coberto
  pelos testes unitarios/integracao.
- Smoke `generator_v1.3.2` pos-deploy (Chatwoot conversa `453`): segundo turn
  gerou `update_draft` com `customer_name=Joao Teste`, `payment_method=pix`,
  `fulfillment_mode=delivery`, `delivery_address=Rua das Flores 123, Meier`;
  `session_events` gravou `draft_updated`. Resposta nao prometeu estoque.
- Commit `cb5a7f8` — fix planner_v1.2.5 + generator_v1.3.1 + phase3 dedup.
  Deploy 2026-05-06 via `pneus/main`. Ativo em prod em ~50s (probe).
- Validacao prod conv 441: Planner v1.2.5 usou organizer_facts corretamente,
  buscarCompatibilidade chamado com {Biz, 2019, rear}, confidence 0.96.
- Qualidade Organizadora confirmada: todos os facts das convs 441/442/445
  extraidos corretamente, confianca 0.84-0.99. Autocorrecao de truth_type
  (corrected) funcionando quando cliente corrigiu moto no mesmo dialogo.
- Catalogo commerce.* ainda vazio — proximo desbloqueio operacional.

## Ultimos Commits Relevantes

- `e35ca31 feat(atendente): Sprint 6.9 restante — nota interna Chatwoot ao escalar`
- `193b4ef feat(dispatcher): Sprint 6.8 — filtrar sender_type`
- `79c0d19 feat(atendente): Sprint 6.7 — Say Validator endurecido`
- `63e40e8 feat(atendente): Sprints 6.5 + 6.6 — loop de estado e bridge Organizadora`
- `56dfc0e feat: tune organizadora prompt v3.4`
- `866bae6 feat: add atendente generator shadow (sprint 6)`

Remotes sincronizados:

- `origin/main`
- `pneus/main`

## Proxima Fase Recomendada

PR 4: Organizadora/ops concluido localmente.
- `ops.enrichment_jobs` agora recupera job `running` zumbi apos
  `ORGANIZADORA_STALE_JOB_AFTER_SECONDS` (default 900s).
- `ORGANIZADORA_MIN_CONFIDENCE`, `ATENDENTE_CONTEXT_TOOL_EVENTS_LIMIT` e
  `ATENDENTE_CONTEXT_ORGANIZER_FACTS_LIMIT` removem magic numbers do codigo.
- Bug 13 documentado: mensagem editada segue como limitacao conhecida ate
  existir historico versionado de `core.messages`; nao foi criado bypass no
  validator de evidence.

Depois do PR 4, escolher entre PR 5 (Say Validator comercial, depende de
amostra real de `blocked_say_text`) e Sprint 7/Supervisora shadow.

Sprint 6.10 (bloqueado por dados): seed catalogo `commerce.*`.
- `commerce.products`, `tire_specs`, `vehicle_fitments` estao vazios; `buscar_e_ofertar` retorna lista vazia.
- Desbloqueio: trazer CSV/dump real da loja.

Sprint 8: envio controlado ao Chatwoot.
- `ChatwootApiClient.postMessage()` + worker envia turn `generated` aprovado.
- Controlado por `ATENDENTE_SEND_ENABLED=false` (default off).

## Cuidados

- Nao limpar nem reverter arquivos que o usuario criou sem revisar.
- Nao recriar scripts com token, connection string, endpoint real ou dados
  operacionais sensiveis hardcoded. Use `.env` local.
- `.env` e `.env.codex` nunca devem ser commitados.
- `ATENDENTE_SHADOW_ENABLED` pode rodar em log-only; envio Chatwoot continua
  inexistente/desligado ate Wallace mandar ativar explicitamente.
