# Next Chat Handoff - Farejador

Atualizado: 2026-05-08 (PR 3 Validators/eventos implementado e testado).

Use este resumo para continuar em outro chat sem reler a conversa inteira.

## Onde Estamos

Estamos construindo a Atendente por camadas, mas ela ainda nao envia mensagem ao
cliente. O sistema atual em producao captura Chatwoot, normaliza, roda
Organizadora LLM, roda a fundacao da Atendente em shadow incluindo o Generator
(que gera resposta candidata auditavel, mas nao envia nada).

**Ultimo marco (2026-05-08):** PR 3 de validators/eventos implementado e
testado. Action Validator agora bloqueia carrinho/draft/escalacao sem
pre-condicao, `session_events` separa eventos de carrinho/draft
(`cart_added`, `cart_removed`, `cart_updated`, `cart_cleared`,
`draft_updated`), e `update_cart_item` grava `updated` em `agent.cart_events`.
Migration `0029_cart_action_events_hardening.sql` aplicada e verificada no
Supabase atual antes dos testes.

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
- PR 1 Generator audit (2026-05-07): migration
  `0028_generator_blocked_turn_audit.sql` adiciona `blocked_say_text`,
  `blocked_actions`, `blocked_payload` em `agent.turns`; `recordGeneratorResult`
  grava o candidato bloqueado; `update_draft` agora exige e recebe
  `action_id`, `turn_index`, `emitted_at`, `emitted_by`. Migration aplicada e
  verificada no Supabase atual.
- PR 2 Estado/contexto (2026-05-08): `ATENDENTE_CONTEXT_MESSAGES_LIMIT`
  controla quantas mensagens recentes entram no contexto (default 20);
  `loadCurrent` deriva `stale_slots` dos slots persistidos com `stale != 'fresh'`;
  `set_active_item` invalida oferta do item antigo e marca slots antigos como
  `stale_strong`; `INVALIDATION_RULES` cobre posição, marca, município,
  pagamento, cilindrada, quantidade e faixa de preço.
- PR 3 Validators/eventos (2026-05-08): `ActionValidator` valida
  `remove_from_cart`/`update_cart_item` contra item vivo no carrinho; bloqueia
  `clear_cart` com confirmacao aberta; bloqueia `update_draft` de delivery sem
  endereco; bloqueia `escalate reason=ready_to_close` sem carrinho confirmado.
  `applyAction` emite eventos semanticos de carrinho/draft e `cart_events`
  usa `updated` para alteracao de quantidade. Migration `0029` aplicada.
- Generator `generator_v1.3.2` (2026-05-08): apos smoke PR3, reforcado que
  dados de fechamento (`pode fechar`, nome, pagamento, endereco, entrega)
  devem gerar `update_draft` mesmo sem estoque confirmado. A resposta deve
  anotar dados e chamar humano para confirmar produto/estoque, sem dizer
  "tem disponivel" nem "nao encontrei disponivel" sem evidencia especifica.
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
- Fix planner_v1.2.5 (2026-05-06):
  Bug: Planner ignorava `organizer_facts` e pedia dados ja conhecidos.
  Correcao: nova regra de prompt + normalizer deterministico pos-LLM em
  `normalizePlannerOutputCandidate` que promove `pedir_dados_faltantes` para
  `buscar_e_ofertar+buscarCompatibilidade` quando: (a) skill e
  `pedir_dados_faltantes`, (b) cliente fez pergunta de compatibilidade, (c)
  `organizer_facts` tem `moto_modelo` com conf>=0.85, (d) tool disponivel.
  Novos helpers: `mentionsProductCompatibilityQuestion`, `findOrganizerStringFact`,
  `findOrganizerNumberFact`. 1 novo teste. Commit `cb5a7f8`.
- Fix generator_v1.3.1 (2026-05-06):
  Bug: Generator usava SAFE_FALLBACK quando skill era `pedir_dados_faltantes`.
  Correcao: regras 5a/5b no prompt do Generator + novo bloco no SayValidator.
  `SayValidationContext` ganhou campo `selected_skill?: string`.
  `runValidators` e `toValidationCtx` passam `skill` para o validator.
  Razao de bloqueio: `safe_fallback_not_allowed_for_pedir_dados_faltantes`.
  2 novos testes. Commit `cb5a7f8`.
- Fix phase3 dedup (2026-05-06):
  Bug: facts identicos (mesmo valor, mesma truth_type, conf>=existente) eram
  inseridos como nova linha e depois supersedidos, poluindo o ledger.
  Correcao: `writeFactWithEvidence` faz deep-equal check via `deepEqualJsonValue`
  + `canonicalJson` antes do INSERT. Se identico, apenas anexa evidence ao fact
  existente e retorna o id existente. 1 novo teste. Commit `cb5a7f8`.
- Suite verde naquele ciclo. Deploy 2026-05-06, ativo em prod em ~50s.

## O Que Ainda Nao Existe

- Critic (Sprint 7).
- Reflection loop.
- Envio Chatwoot pela Atendente (Sprint 8).
- Seed do catalogo `commerce.*` (Sprint 6.10 — depende de dados da loja).
  Este e o principal gap operacional: buscarCompatibilidade e buscarProduto
  retornam [] porque nao ha vehicles, products, fitments cadastrados.
- Atendimento automatico.

## Validacao Atual

Ultima validacao (2026-05-08, PR 3):

- `npm run typecheck`: verde.
- `npm test`: 380/380 verde, 51 arquivos.
- `npx vitest run --config vitest.integration.config.ts tests/integration/atendente-state-persistence.integration.test.ts`: 8/8 verde.
- `npm run build`: verde.
- Migration `0029_cart_action_events_hardening.sql`: aplicada/verificada no
  Supabase atual (`session_events` aceita `cart_added`; `cart_events` aceita
  `updated`).
- Smoke LLM real via Chatwoot fake `pr12-chatwoot-1778211526899`, conversa
  Chatwoot `451`: Organizadora salvou 15 facts (`moto-pneus-hybrid-v3-4`),
  Planner LLM usou `planner_v1.2.5` com `buscar_e_ofertar` e tools
  `buscarCompatibilidade`, `calcularFrete`, `buscarPoliticaComercial`;
  Generator LLM usou `generator_v1.3.1`, gerou 5 actions e 0 bloqueios.
  Conversa teve 13 mensagens, validando o caminho de contexto longo do PR 2
  com default 20. `agent.turns` tem colunas de auditoria PR 1 presentes.
- Nota qualitativa do smoke: Organizadora **9/10**, Planner **9/10**,
  Generator **8/10**, fluxo geral **8,7/10**. Limite: não foi cenário de
  bloqueio forçado; falta smoke específico de desconto/marca/frete sem lastro
  para provar `blocked_say_text` preenchido quando `status='blocked'`.
- Smoke PR3 pos-deploy via Chatwoot conversa `452`: Organizadora salvou 12
  facts (`moto-pneus-hybrid-v3-4`); Planner LLM `planner_v1.2.5` usou
  `buscar_e_ofertar`/`responder_logistica` com tools (`buscarProduto`,
  `buscarCompatibilidade`, `calcularFrete`, `verificarEstoque`,
  `buscarPoliticaComercial`); Generator gerou 2 turns e bloqueou 1 com
  `stock_claim_without_verificar_estoque`, preservando `blocked_say_text`.
  Nenhuma mensagem foi enviada ao cliente. Limite: o Generator nao emitiu
  `update_draft`; portanto `draft_updated` ficou coberto por unit/integration,
  nao por smoke LLM.
- Correcao pos-smoke: `generator_v1.3.2` adiciona regra explicita e teste
  unitario para esse caso. Exemplo esperado: cliente diz "pode fechar no pix,
  meu nome e Joao, entrega na Rua X" -> action `update_draft` com nome, pix,
  delivery e endereco; resposta segura pede confirmacao humana de estoque.
- Deploy anterior: commit `cb5a7f8` -> `pneus/main` -> Coolify -> prod em ~50s.
- Probe prod: planner_v1.2.5 ativo confirmado via `agent.session_events`.
- Validacao end-to-end conv 441:
  "Minha moto e Biz 125 2019." + "Qual pneu traseiro serve pra ela?"
  -> Planner v1.2.5: skill=buscar_e_ofertar, buscarCompatibilidade({Biz,2019,rear}), conf=0.96.
  -> buscarCompatibilidade retornou [] (catalogo vazio — correto).
  -> Generator nao aluciou; SAFE_FALLBACK por ausencia de resultado de tool.
- Auditoria qualidade Organizadora (convs 441/442/445):
  Conv 441: 8 facts corretos, incluindo autocorrecao moto_modelo CG->Biz (truth_type=corrected), conf 0.84-0.99.
  Conv 442: 3 facts corretos (bairro, municipio, intencao), conf 0.98-0.99.
  Conv 445: 6 facts corretos (Bros 160 2022, Michelin, traseiro), conf 0.94-0.99.

Ultimos commits em `pneus/main` (producao):

- `cb5a7f8 fix: planner v1.2.5 promove organizer_facts a buscarCompatibilidade; generator v1.3.1 proibe SAFE_FALLBACK em pedir_dados_faltantes; phase3 dedup facts identicos`
- `e35ca31 feat(atendente): Sprint 6.9 restante — nota interna Chatwoot ao escalar`
- `193b4ef feat(dispatcher): Sprint 6.8 — filtrar sender_type`
- `79c0d19 feat(atendente): Sprint 6.7 — Say Validator endurecido`
- `63e40e8 feat(atendente): Sprints 6.5 + 6.6 — loop de estado e bridge Organizadora`

## Proxima Fase

Duas frentes (ordenadas por prioridade):

**Sprint 6.10 — Seed catalogo `commerce.*`** (desbloqueante principal):
- `commerce.vehicle_models`, `commerce.products`, `commerce.vehicle_compatibilities`,
  `commerce.delivery_zones` estao vazios ou incompletos.
- Enquanto vazio, `buscarCompatibilidade` e `buscarProduto` retornam `[]` e o
  Generator cai no SAFE_FALLBACK em qualquer pergunta de produto.
- Desbloqueio: Wallace traz CSV/dump real da loja com modelos e pneus.
- Apos seed: pipeline completo funcionara — Organizadora extrai moto, Planner
  chama buscarCompatibilidade, Generator oferta produto real.

**PR 4 — Organizadora/ops**:
- Bug 11: lease/reclaim em `ops.enrichment_jobs` para recuperar job zumbi.
- Bug 12: mover magic numbers para env com defaults.
- Bug 13: decidir/documentar tratamento de mensagem editada em evidence.

Depois disso, voltar para **PR 5 Say Validator comercial** ou **Sprint 7
Supervisora/Critic shadow**, dependendo do resultado do smoke PR3 e da
prioridade comercial.

**Sprint 8 — Envio controlado ao Chatwoot**:
- `ChatwootApiClient.postMessage()` com `private: false`.
- Controlado por `ATENDENTE_SEND_ENABLED=false` (default off).
- Dependencia: Sprint 7 (Critic) antes de habilitar envio.

## Pergunta Para Comecar O Proximo Chat

"Quero popular o catalogo commerce.* com dados reais da loja. Mostre o schema
das tabelas relevantes e o formato de importacao esperado (CSV ou SQL direto)."

Ou, se catalogo nao estiver disponivel:

"Quero abrir o PR 4: hardening de Organizadora/ops. Primeiro leia o estado do
repo, implemente lease/reclaim de enrichment_jobs, parametrizacao de magic
numbers e documente a decisao sobre evidence em mensagem editada."
