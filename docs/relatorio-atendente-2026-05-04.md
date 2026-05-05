# Relatório técnico do Atendente — 2026-05-04

> Fontes: docs `phase3-agent-architecture/01..21`, código em `src/atendente/**` e `src/shared/zod/agent-*`, e Supabase `aoqtgwzeyznycuakrdhp` (read-only).
> Cada afirmação está ancorada em pelo menos uma das três fontes.

---

## 1. Sumário executivo

A Atendente está em modo Shadow Sprint 6: Worker → Context Builder → Planner LLM → Tool Executor → Generator LLM → auditoria, **sem envio Chatwoot, sem mutação de estado**. O fluxo está rodando em produção, mas a maior parte do estado reentrante projetado no Sprint 1 (`session_slots`, `session_items`) está **vazia**, porque (a) o Generator nunca consegue emitir actions válidas (schema do prompt incompleto) e (b) o Worker não chama `applyActionAndPersist`. Catálogo `commerce.*` está praticamente vazio (0 produtos, 0 estoque, 0 fitments) — qualquer skill `buscar_e_ofertar` real retorna lista vazia. O design (docs 01, 02, 12, 13, 14) está sólido; a implementação atual cobre 60% dos turnos com LLM real e respostas seguras (validators bloqueando alucinação de preço corretamente). A próxima decisão crítica é: **fechar o loop de mutação de estado antes de seguir para Sprint 7 (Critic), ou seguir Critic com estado vazio**.

---

## 2. Estado real (factual, com números)

### 2.1 População por tabela

| Camada | Tabela | Linhas |
|---|---|---|
| core | `messages` | 314 |
| core | `conversations` | 118 |
| core | `contacts` | 118 |
| analytics | `conversation_facts` | 500 |
| analytics | `fact_evidence` | 500 |
| commerce | `delivery_zones` | 115 |
| commerce | `store_policies` | 11 |
| commerce | `products` | **0** |
| commerce | `product_prices` | **0** |
| commerce | `stock_levels` | **0** |
| commerce | `tire_specs` | **0** |
| commerce | `vehicle_models` | **0** |
| commerce | `vehicle_fitments` | **0** |
| commerce | `orders` | 0 (esperado v1) |
| agent | `session_current` | 23 |
| agent | `session_events` | 79 |
| agent | `turns` | 35 |
| agent | `session_slots` | **0** |
| agent | `session_items` | **0** |
| agent | `cart_current` | 0 |
| agent | `order_drafts` | 0 |
| agent | `pending_confirmations` | 0 |
| agent | `escalations` | 0 |
| ops | `atendente_jobs` | 35 |
| ops | `enrichment_jobs` | 119 |
| ops | `agent_incidents` | 42 |

### 2.2 Distribuição de estados do Generator (35 turns no total)

| Estado | n | % |
|---|---|---|
| LLM real, OK | 21 | 60% |
| LLM real, bloqueado | 2 | 6% |
| Mock (LLM off), OK | 2 | 6% |
| Mock, bloqueado (chave faltando) | 10 | 28% |

Taxa de bloqueio: **34%** (12/35), concentrada em duas causas distintas.

### 2.3 Block reasons agregados

| Motivo | n | Janela |
|---|---|---|
| `generator_llm_enabled_without_key` | 10 | 2026-05-03 19:26 → 19:28 (curta janela com chave faltando) |
| `generator_schema_failed` (LLM omitiu `action_id`, `turn_index`, `emitted_at`, `emitted_by`, etc) | 2 | 2026-05-03 19:43 e 2026-05-04 04:48 (recente, ainda ocorrendo) |

### 2.4 Skills selecionadas pelo Planner (35 decisões)

| Skill | n | % |
|---|---|---|
| `escalar_humano` | 16 | 46% |
| `pedir_dados_faltantes` | 11 | 31% |
| `tratar_objecao` | 4 | 11% |
| `buscar_e_ofertar` | 3 | 9% |
| `responder_geral` | 1 | 3% |

Concentração em `escalar_humano` reflete cold start sem catálogo: Planner consistentemente conclui que falta lastro pra responder.

### 2.5 Tools (9 execuções totais)

| Tool | OK | Falha |
|---|---|---|
| `buscarPoliticaComercial` | 4 | 0 |
| `buscarProduto` | 2 | 0 (mas output `[]` — catálogo vazio) |
| `buscarCompatibilidade` | 2 | 0 |
| `verificarEstoque` | 0 | 1 (`exige product_id ou product_code`) |

### 2.6 Incidents (todos `schema_violation` da Organizadora)

42 incidents, severity `low`, último em 2026-05-03 07:45 (**antes** do prompt v3.4 do dia 2026-05-03 mais tarde). Distribuídos em `moto_cilindrada` (14), `forma_pagamento` (10), `modalidade_entrega` (7), `concorrente_citado` (6), outros (5). São histórico anterior ao fix v3.4; **zero incidents do Atendente registrados**.

### 2.7 Timing de uma conversa real (`693653b6-cccf-4286-9669-62f858c33d99`)

| Mensagem | Cliente em | Turn em | Δ | Skill |
|---|---|---|---|---|
| `[shadow-test] preciso de pneu dianteiro Titan 160` | 19:07:56 | 19:08:04 | **8.1s** | `buscar_e_ofertar` |
| repeat | 19:09:12 | 19:09:18 | **6.1s** | `buscar_e_ofertar` |

Dentro do alvo doc 14 (3-8s).

---

## 3. Arquitetura mapeada (real vs documentado)

| Schema | Função (doc) | Workers que escrevem | Workers que leem | Status real |
|---|---|---|---|---|
| `raw.*` | Webhook bruto imutável | Farejador API | Farejador (normalização) | OK em prod (Fase 1) |
| `core.*` | Mensagens normalizadas | Farejador (dispatcher) | Atendente (context), Organizadora | 314 msgs, 118 convs |
| `analytics.*` | Ledger interpretativo | Organizadora | (deveria ser) Atendente Context Builder | 500 facts em prod, **mas Atendente NÃO lê** (lacuna — ver 4C-1) |
| `commerce.*` | Catálogo, preço, estoque, geo | Admin/seed manual | Atendente (tools) | Vazio exceto `delivery_zones` (115) e `store_policies` (11) |
| `agent.session_current` | Snapshot da sessão | Worker (raw SQL) + applyActionAndPersist | Context Builder | 23 sessões; `version=0` em todas (lock otimista nunca exercitado) |
| `agent.session_events` | Ledger append-only | Planner, Executor, Generator | Repositório (rebuild de last_offer) | 79 eventos, ledger funciona |
| `agent.session_slots` | Slots reentrantes | applyActionAndPersist | Context Builder | **0 linhas** (Generator não persiste) |
| `agent.session_items` | Interesses (motos/pneus) | applyActionAndPersist | Context Builder | **0 linhas** |
| `agent.cart_current/order_drafts/pending_confirmations/escalations` | Carrinho, draft, confirmação, escalação | (deveria ser) action handlers | Context Builder | 0 linhas (handlers de cart/draft/confirm/escalate ainda não escrevem) |
| `ops.atendente_jobs` | Fila do Worker shadow | Dispatcher | Worker | 35 jobs |
| `ops.enrichment_jobs` | Fila da Organizadora | Dispatcher | Organizadora | 119 jobs |
| `ops.agent_incidents` | Auditoria de bloqueios | Organizadora; Worker em catch | Dashboard/manual | 42 (todas Organizadora pré-v3.4) |

Workers planejados que **não existem**: Critic (Sprint 7), Supervisora, sender Chatwoot, action handler de `escalate` que crie nota interna no Chatwoot, action handler de `add_to_cart`/`update_draft` que efetivamente persistam.

---

## 4. Achados — três categorias

### A. Bugs reais (código viola design documentado)

#### ~~A-1. Generator nunca persiste actions; estado reentrante fica permanentemente vazio~~ ✅ Corrigido — Sprint 6.5

> **O que foi feito.** `worker.ts` agora itera `generatorResult.actions` após `recordGeneratorResult`, aplicando cada action via `applyActionAndPersistInTx` (sem BEGIN/COMMIT próprio — usa a transação do worker). Um `SAVEPOINT` por action isola falhas individuais: action que quebra faz rollback ao savepoint, as anteriores ficam. `AgentStateVersionConflictError` interrompe o loop e sinaliza conflito no log.

~~**Descrição.** O Worker chama `recordGeneratorResult` ([worker.ts:78](src/atendente/worker.ts#L78)), que grava só em `agent.turns` e em `session_events.generator_produced`. Não há call para `applyActionAndPersist` ([agent-state.repository.ts:279](src/atendente/state/agent-state.repository.ts#L279)). Resultado: das 23 sessões com 35 turnos, **session_slots=0 e session_items=0**.~~

~~**Doc.** [13-fluxo-de-eventos-e-integracao.md:170](docs/phase3-agent-architecture/13-fluxo-de-eventos-e-integracao.md): "Action handler executa: INSERT agent.cart_events, UPDATE agent.cart_current_items". [21-atendente-v1-state-design.md:73](docs/phase3-agent-architecture/21-atendente-v1-state-design.md#L73): "Mutação só por: Generator → action[] → ActionValidator → ActionHandler → applyAction(state, action) → DB."~~

~~**Evidência banco.** `SELECT count(*) FROM agent.session_slots` = 0; `agent.session_items` = 0; `agent.session_current.version` = 0 em todas as 23 sessões (lock otimista nunca incrementado).~~

~~**Severidade.** Crítica. Sem isso, Atendente é amnésica turn-a-turn — Context Builder lê estado vazio mesmo após 5 turnos coletando dados.~~

#### ~~A-2. Generator schema obriga campos que o LLM não preenche → 2 schema_failed reais~~ ✅ Corrigido — Sprint 6.5 (Caminho B)

> **O que foi feito.** Implementado o "Caminho B": LLM retorna apenas campos semânticos (sem `action_id`, `turn_index`, `emitted_at`, `emitted_by`). O código hidrata esses campos deterministicamente — `action_id` via UUID v5 derivado de `(conversation_id, turn_index, raw_action)`, `emitted_at` = `now()`, `emitted_by = 'generator'`. Novos schemas `updateSlotRawSchema`, `createItemRawSchema`, `recordOfferRawSchema` validam o que o LLM manda; `hydrateGeneratorAction()` constrói a `AgentAction` completa. Prompt reescrito para mostrar exatamente os 3 templates que o LLM deve retornar. Versão do prompt bumped para `generator_v1.1.0`.

~~**Descrição.** [generator/schemas.ts:27-31](src/atendente/generator/schemas.ts#L27) usa `updateSlotSchema` direto, que herda de `stateActionBaseSchema` exigindo `action_id`, `turn_index`, `emitted_at`, `emitted_by` ([agent-actions.ts:133-138](src/shared/zod/agent-actions.ts#L133)). O prompt do Generator ([prompt.ts:43](src/atendente/generator/prompt.ts#L43)) só pede "actions: AgentAction[]" — não enumera campos meta nem mostra que `action_id` precisa ser UUID. LLM omite, schema falha, turno é bloqueado.~~

~~**Evidência banco.** 2 eventos `generator_produced` com `block_reason='generator_schema_failed:[...path:[actions,0,action_id]: Required, ...emitted_by: Required ...]'` em 2026-05-03 19:43 e 2026-05-04 04:48. **Recorrente, não one-off**.~~

~~**Doc.** [21-atendente-v1-state-design.md:120](docs/phase3-agent-architecture/21-atendente-v1-state-design.md#L120): "Toda action carrega `action_id: uuid`". Doc não diz quem deve preencher; código manda LLM preencher, mas prompt não pede.~~

~~**Severidade.** Alta. Combina com A-1 para garantir 0 actions persistidas em 35 turnos.~~

#### ~~A-3. Mock fallback do Generator alucina "Encontrei algumas opções" com tool result vazio~~ ✅ Corrigido — Sprint 6.5

> **O que foi feito.** `service.ts` agora usa `hasNonEmptyOutput(r.output)` — checa `Array.isArray(output) && output.length > 0` além de `ok=true`. `buscarProduto` retornando `ok=true` com `output=[]` é tratado como ausência de dado; mock cai no `SAFE_FALLBACK_SAY` em vez de afirmar que encontrou opções.

~~**Descrição.** [generator/service.ts:87](src/atendente/generator/service.ts#L87): `const hasOkToolResults = toolResults.some((result) => result.ok)` checa só `ok`. Tool `buscarProduto` retorna `ok=true` com `output=[]` quando catálogo está vazio. Mock então responde: *"Encontrei algumas opções para você. Posso detalhar mais?"* — **falsa**.~~

~~**Evidência banco.** Conversa `693653b6-cccf-4286-9669-62f858c33d99`, turno `237ebd1c`: `tool_executed.output=[]`, `say_text="Encontrei algumas opções para você. Posso detalhar mais?"`.~~

~~**Doc.** [02-principios-operacionais.md:18](docs/phase3-agent-architecture/02-principios-operacionais.md#L18): "Ela não pode: inventar estoque, prometer entrega sem dado". Mock viola isso.~~

~~**Severidade.** Média (só atinge mock; LLM real foi correto). Vira alta quando shadow rodar sem chave e cair em mock.~~

#### A-4. Say Validator só checa preço (R$); estoque, prazo e fitment passam livres
**Descrição.** [say-validator.ts:11-28](src/atendente/validators/say-validator.ts#L11) só extrai padrões `R$`. Não valida menção a estoque ("temos em estoque", "tem disponível"), prazo de entrega ("entrego amanhã", "chega hoje") nem certeza de fitment.

**Doc.** [09-skills-router-e-validadores.md:138-145](docs/phase3-agent-architecture/09-skills-router-e-validadores.md#L138): "Estoque: se `say` diz que tem em estoque, a skill precisa ter retornado disponibilidade; Promessa de prazo: se `say` promete entrega hoje/amanha, `calcular_entrega` precisa ter retornado prazo; Fitment descoberto: discovery `pending` ou `approved` nao vira certeza de venda no texto."

**Evidência banco.** Turno `01:51:40` ("Entregamos sim, mas para confirmar o prazo em Nova Iguaçu preciso do seu bairro"): contém promessa de entrega, sem ter chamado `calcularFrete`. Validator não bloqueou.

**Severidade.** Alta antes de ligar envio Chatwoot. Hoje é shadow, então só polui auditoria.

#### A-5. ~~Worker faz raw SQL em `session_current` quebrando otimistic locking~~ ⚠️ Parcialmente resolvido — Sprint 6.5

> **O que foi feito.** `applyActionAndPersistInTx` incrementa `version` corretamente via `WHERE version = $5` com `rowCount` check — lança `AgentStateVersionConflictError` se outro processo avançou antes. A função `markShadowTurnProcessed` ainda faz raw UPDATE (só `turn_index` e `last_customer_message_id`, **sem tocar `version`**), então as duas coexistem sem conflito: versioning real é controlado exclusivamente pelo loop de actions. `version` vai deixar de ser 0 assim que o primeiro turno com actions for processado em produção.

**O que resta.** Confirmar em banco após deploy: sessões com actions aplicadas mostram `version > 0`.

~~**Descrição.** [worker.ts:245-258](src/atendente/worker.ts#L245) `markShadowTurnProcessed` faz `UPDATE agent.session_current SET turn_index=…, last_customer_message_id=…` sem incrementar `version`. `applyActionAndPersist` ([agent-state.repository.ts:300](src/atendente/state/agent-state.repository.ts#L300)) só funciona se `version` for monotonicamente crescido por ele. Hoje as duas formas de update coexistem; `version` permanece 0.~~

~~**Evidência banco.** 23 sessões; todas com `version=0` apesar de `turn_index` chegando a 2.~~

**Doc.** [21-atendente-v1-state-design.md:113](docs/phase3-agent-architecture/21-atendente-v1-state-design.md#L113): "Lock pessimista em `agent.session_current` via `SELECT ... FOR UPDATE`. Otimistic versioning: campo `version` em `session_current`, action falha se conflito."

~~**Severidade.** Baixa hoje (shadow); alta quando o loop de mutação for fechado (A-1) e duas escritas concorrentes existirem.~~

#### A-6. Dispatcher enfileira atendente_job para mensagens `sender_type='user'` (atendente humano)
**Descrição.** [dispatcher.ts:233-245](src/normalization/dispatcher.ts#L233) chama `enqueueAtendenteJob` para qualquer `message_created`, sem filtrar `sender_type`. Função SQL `ops.enqueue_atendente_job` também não filtra (verificada via `pg_get_functiondef`). Doc 13 timeline 2 manda filtro explícito.

**Doc.** [13-fluxo-de-eventos-e-integracao.md:54-66](docs/phase3-agent-architecture/13-fluxo-de-eventos-e-integracao.md#L54): "Filtro: `sender_type IN ('bot','agent_admin')` nao dispara Atendente."

**Evidência banco.** `SELECT m.sender_type, COUNT(j.id) FROM core.messages m LEFT JOIN ops.atendente_jobs j ON j.trigger_message_id=m.id`: `contact=311 msgs / 33 jobs`, `user=3 msgs / 2 jobs`. Os 2 jobs em `user` são a violação.

**Severidade.** Baixa hoje (volume mínimo, e os "user" são teste). Crítica quando ligar envio Chatwoot — bot poderia responder a si mesmo.

#### A-7. Context Builder não lê `analytics.conversation_facts` — Atendente ignora trabalho da Organizadora
**Descrição.** [context-builder.ts:42-72](src/atendente/planner/context-builder.ts#L42) busca `core.messages` e `agent.session_events` (tool history). Não consulta `analytics.conversation_facts` nem `analytics.customer_journey`.

**Doc.** [12-context-builder-e-slot-filling.md:114-123](docs/phase3-agent-architecture/12-context-builder-e-slot-filling.md#L114) pipeline item 4: "facts confiaveis da Organizadora (analytics.conversation_facts)". [21-atendente-v1-state-design.md:104](docs/phase3-agent-architecture/21-atendente-v1-state-design.md#L104): "Context Builder lê facts e propõe updates ao Planner via campos auxiliares".

**Evidência banco.** Conversa `693653b6`: Organizadora extraiu `medida_pneu=120/80-18`, `marca_pneu_preferida=Michelin`, `posicao_pneu=traseiro` em `analytics.conversation_facts`. Atendente turnos da mesma conversa nunca usaram esses dados — Planner pediu `buscarProduto` só com `marca=Michelin` (sem medida).

**Severidade.** Alta. Anula o ROI do Shadow Assistido (doc 15) — o objetivo do shadow é Organizadora calibrar fact_keys que Atendente usará; sem leitura, calibração não chega na ponta.

### B. Comportamento intencional (não confundir com bug)

#### B-1. Atendente não espera Organizadora terminar
**Doc.** [01-visao-geral.md:51-57](docs/phase3-agent-architecture/01-visao-geral.md#L51): "A Atendente nao depende da Organizadora pra responder o turno atual. Ela usa facts ja existentes de turnos anteriores. A Organizadora melhora a proxima interacao, nao a atual."
**Implicação.** A defasagem de 60-120s entre turno do Atendente e fact extraído pela Organizadora é **desacoplamento intencional**, não race condition. Não tentar "bridge analytics→agent em tempo real".

#### B-2. Generator shadow nunca envia ao Chatwoot
**Doc.** [15-shadow-assisted-mode.md:60-64](docs/phase3-agent-architecture/15-shadow-assisted-mode.md#L60), [00-estado-de-implementacao.md:31-36](docs/phase3-agent-architecture/00-estado-de-implementacao.md#L31).
**Implicação.** Logs `'atendente shadow: job processed'` sem POST Chatwoot são esperados. Cliente continua respondido manualmente por Wallace.

#### B-3. v1 não cria `commerce.orders` — `escalate ready_to_close` é o caminho
**Doc.** [06-agent-state-atendente.md:162-168](docs/phase3-agent-architecture/06-agent-state-atendente.md#L162), [13-fluxo-de-eventos-e-integracao.md:251-272](docs/phase3-agent-architecture/13-fluxo-de-eventos-e-integracao.md#L251).
**Implicação.** `commerce.orders=0` não é bug. Qualquer alteração que crie pedido automático antes de Sprint 8+ viola o design.

#### B-4. Skill `escalar_humano` em 46% reflete cold start, não crise
**Doc.** [02-principios-operacionais.md:80-86](docs/phase3-agent-architecture/02-principios-operacionais.md#L80) regras negativas; [09-skills-router-e-validadores.md:104-131](docs/phase3-agent-architecture/09-skills-router-e-validadores.md#L104) `responder_geral` como skill de salvação.
**Implicação.** Sem catálogo, sem session_slots populados, faltando dado fresco — `escalar_humano` é a resposta segura. Concentração só vira sinal vermelho depois que A-1 + A-7 + catálogo estiverem resolvidos.

### C. Lacunas (faltando ou parcial)

#### C-1. Bridge `analytics.conversation_facts` → Context Builder
Falta o item 4 do pipeline doc 12. Não há ADR descartando — é só atraso de implementação. **Bloqueador real** do ROI do Shadow.

#### C-2. Catálogo `commerce.products`/`prices`/`stock_levels`/`tire_specs`/`vehicle_models`/`vehicle_fitments` vazios
Schema existe (`0013_commerce_layer.sql`), seed manual nunca foi feito. **Sem isso, `buscar_e_ofertar` é teatro.** Não bloqueia Sprint 7 (Critic), mas bloqueia qualquer avaliação séria de qualidade.

#### C-3. Action handlers de cart/draft/confirmation/escalation
Tabelas `agent.cart_current`, `order_drafts`, `pending_confirmations`, `escalations` permanecem vazias. `applyAction` ([apply-action.ts:282-371](src/atendente/state/apply-action.ts#L282)) trata `add_to_cart`, `update_draft`, etc como `applyNoStateMutation` (só emite evento, não escreve nas tabelas). Esperado pela arquitetura, código atual não cumpre.

#### C-4. Critic (Sprint 7) ainda não existe
Doc 00 lista como próxima fase. Brief sugere validar se ainda faz sentido — ver Seção 5.

#### C-5. `derived_signals.intencao` e `urgencia` documentados (doc 21 §1.10) não existem no schema TS
[agent-state.ts:173-181](src/shared/zod/agent-state.ts#L173) `derived_signals` só tem `missing_for_close`, `stale_slots`, `recent_objections`, `has_pending_human_request`, `offer_expired`. Sem impacto operacional hoje (Planner não usa); cosmético.

#### C-6. `evidence_text`, `set_by_message_id`, `set_by_skill` em slots — colunas existem no schema, código não preenche
Como Generator não emite slots (A-1, A-2), o atributo nunca é exercitado. Vai virar problema quando A-1/A-2 forem corrigidos: ActionValidator exige `set_by_message_id` quando `source='confirmed'` ([action-validator.ts:70-72](src/atendente/validators/action-validator.ts#L70)), mas prompt do Generator não pede.

---

## 5. Plano em fases

> Restrição: nenhuma proposta contradiz princípio documentado. Cada fase tem dependências explícitas e critério mensurável.

### Sprint 6.5 — Fechar loop de mutação de estado (1 semana)
**Objetivo.** Garantir que `session_slots` e `session_items` deixem de ser zero.
**Arquivos.** `src/atendente/worker.ts` (chamar `applyActionAndPersist` para cada action válida do Generator); `src/atendente/generator/prompt.ts` (enumerar campos meta `action_id`, `turn_index`, `emitted_at`, `emitted_by`); `src/atendente/generator/service.ts` (passar `turn_index` e timestamps esperados; gerar `action_id` server-side se faltar como fallback resiliente).
**Dependência.** Nenhuma — bloqueia tudo abaixo.
**Critério pronto.** Em 50 turnos shadow seguidos, ≥80% têm `actions` aplicadas em `session_slots/session_items`; `version` em `session_current` cresce; zero `generator_schema_failed` por ausência de campos meta.
**Esforço.** 3-5 dias. Estimativa baseada em editar 3 arquivos confirmados com Read.

### Sprint 6.6 — Bridge Organizadora → Context Builder (3 dias)
**Objetivo.** Atendente lê facts.
**Arquivos.** `src/atendente/planner/context-builder.ts` (adicionar query a `analytics.conversation_facts WHERE conversation_id=$1 AND superseded_by IS NULL`); `src/atendente/planner/prompt.ts` (anexar facts ao prompt rotulados como "facts confirmados pela Organizadora — sujeitos a re-confirmação se críticos").
**Dependência.** Independente de 6.5; pode ser paralelo.
**Critério pronto.** Em conversa real testada (ex: `693653b6`), Planner pede `buscarProduto` com `medida_pneu=120/80-18` (extraído pela Organizadora) sem o cliente repetir.

### Sprint 6.7 — Endurecer Say Validator (2 dias)
**Objetivo.** Cobrir estoque/prazo/fitment, não só preço.
**Arquivos.** `src/atendente/validators/say-validator.ts` (lexicons negativos por categoria + correlação com tool result presente); `src/atendente/validators/tool-results.ts` (exportar `collectStockClaims`, `collectDeliveryPromises`).
**Dependência.** Nenhuma. Pré-requisito antes de Sprint 8 (envio Chatwoot).
**Critério pronto.** Suite de testes Vitest cobrindo: "tem em estoque" sem `verificarEstoque` → block; "entrego amanhã" sem `calcularFrete` → block.

### Sprint 6.8 — Filtrar dispatcher por sender_type (1 dia)
**Arquivos.** `src/normalization/dispatcher.ts` linha 233 (early return se `sender_type IN ('bot','user','agent_admin')`).
**Critério pronto.** Mensagem do bot não cria `atendente_job`. Verificar via SQL após teste.

### Sprint 6.9 — Action handlers reais (cart/draft/escalation) (1-2 semanas)
**Arquivos.** `src/atendente/state/apply-action.ts` (substituir `applyNoStateMutation` por handlers que efetivamente escrevem em `agent.cart_current_items`, `agent.order_drafts`, `agent.pending_confirmations`, `agent.escalations`); novo `src/atendente/handlers/escalate.ts` (criar nota interna no Chatwoot via API — usa env `CHATWOOT_API_TOKEN` já existente).
**Dependência.** 6.5 (loop de persistência aberto primeiro).
**Critério pronto.** Após 1 turno simulando "cliente confirma compra", `agent.escalations` recebe linha e Chatwoot mostra nota interna estruturada (doc 13 §"Promocao carrinho -> pedido v1").

### Sprint 6.10 — Catálogo mínimo (paralelo, depende de Wallace) (variável)
**Objetivo.** Popular `commerce.products`, `product_prices`, `stock_levels`, `tire_specs`, `vehicle_models`, `vehicle_fitments` com pelo menos top-20 medidas/marcas reais da loja.
**Dependência.** Não bloqueia Sprint 7. Bloqueia avaliação real de `buscar_e_ofertar`.
**Critério pronto.** `buscarProduto({medida_pneu:'140/70-17'})` retorna ≥1 produto com preço e estoque.

### Sprint 7 — Critic Shadow (revisão de prioridade)
**Recomendação:** **adiar até 6.5 + 6.6 estarem prontos**. Critic avalia `{say, actions}` candidato; sem actions persistidas (A-1) e sem facts (A-7), Critic mede um sistema que ainda não está exercitando o estado reentrante. Justificativa baseada em achado, não em opinião: 0 actions em 35 turnos.

### Sprint 8 — Envio controlado Chatwoot (após Sprint 7)
**Pré-requisitos.** 6.7 completo (Say Validator endurecido), 6.8 (filtro sender_type), 6.9 (handler escalate funcional).
**Critério pronto.** Whitelist de skills permitidas + flag por contato; 100 envios em piloto sem incidente de say bloqueado pós-envio.

---

## 6. Riscos e armadilhas

1. **Não tente "bridge analytics→agent em tempo real" pra resolver C-1**. Doc 01 é taxativo: Atendente é desacoplada. A bridge correta é Context Builder lendo `analytics.*` no início do turno (já-consolidado), não webhook reverso.
2. **Não use `version=0` como sinal de bug**. Hoje é sintoma de A-5/A-1 combinados; vai resolver junto.
3. **Não popule `commerce.products` com mock**. Catálogo errado é pior que vazio: gera proposta de venda inexistente. Espera Wallace fornecer dump real ou csv.
4. **Não confunda "Generator schema failed" com bug do Generator LLM**. É bug do **prompt** (incompleto). LLM faz o que prompt pede.
5. **Não inventar nome de modelo**. `planner_decided.event_payload.model='gpt-5.4'` aparece nos eventos. Esse modelo é o que está no env `PLANNER_MODEL`. Se a IA revisora não conhecer, é por desatualização da própria; não chamar de "modelo inválido".
6. **Não considerar `escalar_humano=46%` como falha**. Cold start sem catálogo + sem session_slots populados — é a resposta segura. Métrica vira válida depois de 6.5+6.6+6.10.
7. **Não excluir os 42 schema_violations sem entender histórico**. São pré-v3.4; já há fix em produção (doc 00). Apagar perde rastro de calibração.
8. **Não pular para Sprint 7 (Critic) por estar no roadmap**. O Critic mede a saída do Generator; hoje Generator emite 0 actions persistidas, então o Critic vai medir só `say` (parcial) e perder o ponto principal.

---

## 7. Decisões pendentes

1. **Antecipar Sprint 6.5 antes do Sprint 7?** Recomendação técnica: sim. Ganho: estado reentrante deixa de ser teórico. Custo: 1 semana a mais antes do Critic.
2. **Quando popular `commerce.*`?** Bloqueia avaliação real de `buscar_e_ofertar`/`verificarEstoque`/`calcularFrete`. Wallace tem dump da loja em formato exportável (csv/excel)? Quem faz o seed (humano via SQL ou via admin endpoint que ainda não existe)?
3. **`evidence_text` e `set_by_message_id` no Generator: prompt obriga ou ActionValidator preenche server-side com `null` quando faltar?** Hoje ActionValidator bloqueia quando `source='confirmed'` sem `set_by_message_id` ([action-validator.ts:70](src/atendente/validators/action-validator.ts#L70)). Decisão arquitetural: trade-off entre prompt mais longo vs validator mais permissivo.
4. **Filtrar `sender_type='user'` (atendente humano) ou só `'bot'`?** Doc 13 lista `('bot','agent_admin')`. Hoje as mensagens humanas vêm como `sender_type='user'`. Confirmar mapping Chatwoot.
5. **Critic Shadow (Sprint 7) avalia o quê exatamente?** Sem actions persistidas, só `say` faz sentido. Definir métrica de sucesso antes de prompt: similarity vs Wallace? Heurística "respondeu o que cliente perguntou"? Score 0-5?

---

*Relatório anchored. Sem recomendação que contradiga doc sem justificativa. Sem estimativa sem ter aberto o arquivo. Pronto para revisão.*
