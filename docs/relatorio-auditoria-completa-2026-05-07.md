# Auditoria Completa — Estado e Cronograma de Hardening
**Data inicial:** 2026-05-07
**Última revisão:** 2026-05-10 (PR 1–5 fechados e validados por Codex)
**Escopo:** Auditoria linha a linha de 16 arquivos TypeScript críticos, 8 migrations, 13 docs de arquitetura, AGENTS.md, env config e estrutura de testes.
**Objetivo:** Mapear bugs reais com referência de linha, refutar suspeitas infundadas e produzir cronograma realista até Sprint 8 (envio Chatwoot).

> **Princípio desta auditoria:** afirmações com referência de arquivo:linha foram lidas. O que não foi lido está marcado como "fora de escopo desta auditoria". Sem chute disfarçado de fato.
>
> **Limitações cravadas pós-Codex:** esta auditoria foi feita sobre código + migrations + docs. **Não consultou o banco vivo em prod.** Codex revisou e cruzou com banco — correções incorporadas. Itens marcados **[REVISADO POR CODEX]** são correções dele em cima do parecer original. Itens **[DESCOBERTO POR CODEX]** são bugs que escaparam de mim. Itens **[VERIFICAR EM PROD]** são pendências de query SQL. Ver seção 4.5 para limitações detalhadas.

---

## 1. Sumário executivo

| Camada | Estado | Bloqueia Sprint 8? |
|---|---|---|
| Webhook + raw events | Em prod, hardenado | Não |
| Normalização raw → core | Em prod | Não |
| Enrichment determinístico (Fase 2a) | Implementado | Não |
| Organizadora LLM (v3.4) | Em prod | Não |
| Estado reentrante Atendente | Implementado e hardenado no PR 2 | Não para shadow; envio real depende do roadmap Sprint 8 |
| Skills (7 canônicas) | Implementadas | Não |
| Planner (v1.2.6) | Em prod shadow, com `verificarEstoque` protegido | Não |
| Tool Executor | Implementado | Não |
| Generator Shadow (v1.3.2) | Em prod shadow, com `update_draft` validado | Não |
| Validators (say + action) | PR 1–5 hardening fechado; Say Validator comercial validado com LLM real | Não para shadow; envio real depende do roadmap Sprint 8 |
| Catálogo `commerce.*` | **Subdimensionado** — 3 produtos, 3 specs, 3 estoques, 70 modelos, 25 fitments, 14 políticas, 624 bairros, 115 zonas [REVISADO POR CODEX] | **Sim — bloqueio funcional** (3 produtos não vendem 10/dia) |
| Supervisora/Critic (Sprint 7) | Não existe | Próximo ciclo de qualidade |
| Envio Chatwoot (Sprint 8) | Não existe | Próximo ciclo após catálogo + Supervisora |

**Verdict curto:** arquitetura sólida (schema fechado, append-only enforced em DB, optimistic lock, idempotência atômica, evidência literal exigida). O hardening PR 1–5 foi implementado, testado e validado com LLM real em shadow. **Bloqueio operacional principal agora não é o hardening, é catálogo subdimensionado** — tem dado de suporte (geo, modelos, políticas) bem populado, mas só 3 produtos cadastrados.

---

## 2. Pontos fortes confirmados (com referência)

| # | Componente | Referência | O que entrega |
|---|---|---|---|
| F1 | HMAC + timestamp + idempotência atômica | [chatwoot.handler.ts](../src/webhooks/chatwoot.handler.ts), [chatwoot.hmac.ts](../src/webhooks/chatwoot.hmac.ts), [raw-events.repository.ts:18](../src/persistence/raw-events.repository.ts) | Webhook não duplica, não vaza, valida assinatura com `timingSafeEqual` |
| F2 | Append-only enforced em DB | [0017:218-238](../db/migrations/0017_agent_triggers.sql) | UPDATE/DELETE em `session_events` e `cart_events` levanta exceção |
| F3 | Environment match cross-table | [0021](../db/migrations/0021_environment_match_guards.sql) | Função paramétrica genérica via `TG_ARGV`. Prod nunca referencia test |
| F4 | Optimistic lock real | [agent-state.repository.ts:349-368](../src/atendente/state/agent-state.repository.ts) | `UPDATE ... WHERE version = $7`, lança `AgentStateVersionConflictError` |
| F5 | SAVEPOINT por unidade independente | [worker.ts:110-141](../src/atendente/worker.ts), [organizadora/worker.ts:236-266](../src/organizadora/worker.ts) | Falha de uma action não derruba auditoria; falha de um fact não aborta o batch |
| F6 | `validate_cart_promotion` trigger | [0017:108-138](../db/migrations/0017_agent_triggers.sql) | Cart só vira `promoted` com TODOS items `confirmed` — segurança em DB |
| F7 | Evidência literal obrigatória | [evidence.ts:11-22](../src/organizadora/evidence.ts) | `messageContent.includes(evidence_text)` — Organizadora não pode parafrasear |
| F8 | Backup determinístico de fatos | [deterministic-facts.ts](../src/organizadora/deterministic-facts.ts) | Regex pra `forma_pagamento` + `modalidade_entrega` se LLM falhar; marca `'indefinido'` se ambíguo |
| F9 | Modelo configurável por papel | [env.ts:23,29,36](../src/shared/config/env.ts) | `OPENAI_MODEL` / `PLANNER_MODEL` / `GENERATOR_MODEL` independentes |
| F10 | Normalizador determinístico Planner v1.2.5 | [planner/service.ts:296-375](../src/atendente/planner/service.ts) | Trata LLM como sugestão, código como verdade |
| F11 | Sync prompt ↔ schema sem drift | [organizadora/prompt.ts:24-51](../src/organizadora/prompt.ts) | Seção "VALORES PERMITIDOS" gerada a partir de `FACT_KEY_SCHEMAS` |
| F12 | Idempotência via `deterministicUuid` | múltiplos arquivos | Retry não duplica auditoria |

---

## 3. Bugs CONFIRMADOS

Todos com referência de arquivo:linha. Severidade: **A** (alta, bloqueia Sprint 8), **M** (média, afeta operação), **B** (baixa, polimento).

### Bug 1 [A] — `set_active_item` não invalida oferta nem slots de item antigo
- **Arquivo:** [apply-action.ts:250-261](../src/atendente/state/apply-action.ts)
- **Sintoma:** trocar item ativo só altera flag `is_active`. Oferta ligada ao item antigo permanece "válida". Slots não viram `stale_strong`.
- **Cenário real:** "minha moto é Bros 160" → oferta criada → "na verdade é Biz 125" → oferta da Bros continua sendo referenciada.
- **Fix:** estender `INVALIDATION_RULES` ou adicionar passo no `applySetActiveItem` que chama `invalidateOffer` + marca slots do item antigo como `stale_strong`.

### Bug 2 [M] — Eventos com nome semanticamente errado em `session_events`
- **Arquivo:** [apply-action.ts:381,392,403,412,435](../src/atendente/state/apply-action.ts)
- **Sintoma 2a:** Toda mudança de carrinho em `session_events` vira `cart_proposed` (genérico).
- **Sintoma 2b:** `applyUpdateDraft` emite `'fact_corrected'` — esse tipo é semanticamente da Organizadora corrigindo fato em `analytics`, não para checkout.
- **Atenuante:** [agent-state.repository.ts:537-548](../src/atendente/state/agent-state.repository.ts) escreve `cart_events` com tipos diferenciados (proposed/removed/replaced/cleared). Auditoria granular existe via `cart_events`.
- **Fix:** adicionar event types `cart_added`, `cart_removed`, `cart_updated`, `cart_cleared`, `draft_updated` ao CHECK constraint (nova migration) e atualizar emissão no `apply-action.ts`.

### Bug 3 [M-prospectivo] — `replace_cart_item` ausente; lacuna arquitetural [REVISADO POR CODEX]
- **Arquivo:** [agent-actions.ts:31-55](../src/shared/zod/agent-actions.ts)
- **Sintoma:** action set tem `add_to_cart, remove_from_cart, update_cart_item (só quantity), clear_cart`. **Não tem ação atômica de substituição de produto.**
- **Correção do parecer original:** o cenário "Generator emite remove + add" que dei estava errado. O Generator hoje só emite `update_slot, create_item, record_offer, update_draft` ([generator/schemas.ts:85-90](../src/atendente/generator/schemas.ts#L85-L90)). **Nenhum carrinho é manipulado pelo Generator hoje.** Quem mexe em carrinho são action handlers acionados manualmente ou via fluxo que ainda não existe.
- **Severidade real:** prospectiva. Vira problema atual quando o action set do Generator for expandido (provável Sprint 8 ou próxima sprint que expandir o que o agente pode fazer).
- **Fix:** criar `replace_cart_item` no zod + apply-action + repository **junto com a expansão do action set do Generator**, não antes. Pareá-lo com a sprint que adicionar `add_to_cart`/`remove_from_cart` ao set emitível pelo Generator.

### Bug 4 [M] — `update_cart_item` (quantity-only) emite `replaced` em cart_events
- **Arquivo:** [agent-state.repository.ts:566](../src/atendente/state/agent-state.repository.ts)
- **Sintoma:** `case 'update_cart_item': return { eventType: 'replaced', ... }`. **Mas `update_cart_item` no schema só muda quantity.** `replaced` deveria ser substituição de produto.
- **Fix:** retornar `'updated'` (adicionar ao CHECK do `cart_events.event_type` se necessário) ou renomear schema action.

### Bug 5 [B] — `intent_to_close_recorded` schema-vazio
- **Arquivos:** [0024:91](../db/migrations/0024_atendente_v1_state_extensions.sql) declara, mas nenhum TypeScript emite.
- [generator/service.ts:127-129](../src/atendente/generator/service.ts) na skill `registrar_intencao_fechamento` retorna `say` sem action equivalente.
- **Fix:** adicionar action `record_intent_to_close` no agent-actions, emitir no apply-action, ensinar Generator a emitir nessa skill.

### Bug 6 [M] — INVALIDATION_RULES com cobertura parcial [REVISADO POR CODEX]
- **Arquivo:** [invalidation-rules.ts:16-73](../src/atendente/state/invalidation-rules.ts)
- **Cobre:** `moto_modelo` (item), `moto_ano` (item), `bairro` (global), `medida_pneu` (item).
- **Não cobre slots reais que existem:** `posicao_pneu` (item), `marca_preferida` (item), `marca_recusada` (item), `municipio` (global), `forma_pagamento` (global), `moto_cilindrada` (item), `quantidade` (item), `faixa_preco_max` (item).
- **Correção do parecer original:** cravei `moto_marca` e `municipio_mencionado` na primeira versão — esses são `fact_keys` da Organizadora (em `analytics.conversation_facts`), **não slot_keys** (em `agent.session_slots`). Misturei namespaces. Slots reais conferidos em [agent-state.ts globalSlotKeySchema/itemSlotKeySchema](../src/shared/zod/agent-state.ts).
- **Cenário real:** cliente disse "dianteiro" → "na verdade é traseiro". `posicao_pneu` muda, oferta antiga continua válida porque INVALIDATION_RULES não lista esse slot.

### Bug 7 [B] — `syncSessionSlots` faz DELETE + reinsert a cada turno
- **Arquivo:** [agent-state.repository.ts:679-700](../src/atendente/state/agent-state.repository.ts)
- **Sintoma:** flush completo de slots toda escrita. `id` muda toda vez (gen_random_uuid no INSERT). Em conversa longa (50 turnos × 10 slots), 500 DELETEs + 500 INSERTs por turno.
- **Severidade:** zero hoje, alta em escala.
- **Fix:** UPSERT por (environment, conversation_id, scope, item_id, slot_key) preservando id estável.

### Bug 8 [M] — Context Builder limita histórico em 10 mensagens
- **Arquivo:** [context-builder.ts:73](../src/atendente/planner/context-builder.ts)
- **Sintoma:** `LIMIT 10` em `recent_messages`. Conversa de WhatsApp dura dias. Cliente que mandou 15 mensagens há 2 dias e volta hoje: agente vê só as 10 últimas.
- **Atenuante:** Organizadora preserva contexto via `analytics.current_facts` lido no Context Builder.
- **Fix:** tornar limit configurável via env (`ATENDENTE_CONTEXT_MESSAGES_LIMIT`, default 20).

### Bug 9 [B] — Tool execution sequencial
- **Arquivo:** [tool-executor.ts:22-31](../src/atendente/executor/tool-executor.ts)
- **Sintoma:** `for (const request of requests)` em série. 3 tools por turno = soma de latências.
- **Fix:** `Promise.all(requests.map(executeToolRequest))`. Tools são independentes.

### Bug 10 [M] — Performance latente em `buscarProduto` [REVISADO POR CODEX]
- **Arquivo:** [commerce-tools.ts:209](../src/atendente/tools/commerce-tools.ts)
- **Sintoma:** `replace(replace(lower(COALESCE(tire_size, '')), ' ', ''), 'r', '-') = $X` faz scan completo a cada query. Sem index funcional cobrindo essa expressão.
- **Correção do parecer original:** afirmei index em `commerce.products`. Errado. **`tire_size` mora em `commerce.tire_specs`**, e `commerce.product_full` é a view que joina os dois.
- **Severidade:** baixa hoje (3 produtos), alta quando catálogo crescer pra >100.
- **Fix correto:** index funcional em `commerce.tire_specs` OU coluna gerada (preferível pra Postgres 12+):
```sql
-- Opção A: index funcional puro
CREATE INDEX tire_specs_normalized_size_idx
  ON commerce.tire_specs (replace(replace(lower(COALESCE(tire_size, '')), ' ', ''), 'r', '-'));

-- Opção B: GENERATED COLUMN (mais idiomático)
ALTER TABLE commerce.tire_specs
  ADD COLUMN tire_size_normalized TEXT GENERATED ALWAYS AS
    (replace(replace(lower(COALESCE(tire_size, '')), ' ', ''), 'r', '-')) STORED;

CREATE INDEX tire_specs_normalized_size_idx
  ON commerce.tire_specs (tire_size_normalized);
```

### Bug 11 [M] — Sem lease/heartbeat em enrichment_jobs [feito PR4]
- **Arquivo:** [ops-phase3.repository.ts:30-43](../src/shared/repositories/ops-phase3.repository.ts)
- **Sintoma:** `WHERE status IN ('pending', 'queued')`. Worker que crashar com job em `'running'` deixa job zumbi. `locked_at` é gravado mas nunca consultado.
- **Atenuante:** Atendente tem reconciliador via [reconcile-jobs.ts](../src/atendente/reconcile-jobs.ts). Organizadora não tem.
- **Fix aplicado em 2026-05-08:** query de pickup recupera job `running` com lock vencido:
```sql
OR (status = 'running' AND locked_at < now() - interval '15 minutes')
```
- Implementado como `ORGANIZADORA_STALE_JOB_AFTER_SECONDS` (default `900`) em `pickEnrichmentJob`, ainda com `FOR UPDATE SKIP LOCKED`.

### Bug 12 [B] — Magic numbers hardcoded [parcialmente feito PR4]
- `MIN_CONFIDENCE = 0.55` virou `ORGANIZADORA_MIN_CONFIDENCE`.
- Lease de job zumbi virou `ORGANIZADORA_STALE_JOB_AFTER_SECONDS`.
- `LIMIT 5` de tool events virou `ATENDENTE_CONTEXT_TOOL_EVENTS_LIMIT`.
- `LIMIT 25` de organizer_facts virou `ATENDENTE_CONTEXT_ORGANIZER_FACTS_LIMIT`.
- **Ainda pendente fora do PR4:** expiração default de `request_confirmation` continua no handler puro para não acoplar `applyAction` ao parser global de env.

### Bug 13 [B] — `validateFactEvidence` quebra se mensagem foi editada [documentado PR4]
- **Arquivo:** [evidence.ts:11-22](../src/organizadora/evidence.ts)
- **Sintoma:** compara `messageContent` atual contra `evidence_text` capturado na extração. Mensagem editada → content novo ≠ evidence velho. Replay rejeita fact que era válido.
- **Severidade:** baixa. Edição no WhatsApp é raro.
- **Decisão PR4:** aceitar como limitação conhecida enquanto não existir histórico versionado de mensagens editadas. Não criar bypass no validator, porque isso enfraqueceria a garantia de evidence literal. Se o projeto precisar suportar replay perfeito de mensagem editada, o próximo passo correto é persistir versão anterior de `core.messages` ou evento de edição auditável antes de mudar `validateFactEvidence`.

### Bug 14 [A] — Say Validator comercial [FECHADO PR5]
- **Arquivo:** [say-validator.ts](../src/atendente/validators/say-validator.ts)
- **Cobre agora:** preço sem tool, estoque, prazo de entrega, compatibilidade, política, valores em R$, marca específica sem lastro (`brand_claim_without_buscar_produto`), desconto fora de `buscarPoliticaComercial`, brinde/promoção sem política promocional e oferta custom sem política comercial.
- **Exemplos cobertos pelo PR5:**
  - "Tem Pirelli sim" sem produto/marca retornada por `buscarProduto` ou `buscarCompatibilidade`.
  - "Consigo te dar 5% de desconto" sem `desconto_maximo`.
  - "Consigo te dar 10% de desconto" quando a política permite no máximo 5%.
  - "Levando 2 pneus ganha uma câmara de brinde" sem `brinde_promocao` / `promocao_ativa`.
  - "Se levar 2, faço por R$ 200" sem política comercial.
- **Severidade:** alta antes de Sprint 8. Esses são exatamente os tiros que o cliente vai testar quando souber que tem bot.
- **Smoke LLM pós-deploy:** fechado em 10/05/2026 nas conversas Chatwoot `470`-`473`. Resultado: 8/8 jobs processados, 23 facts da Organizadora, 6 turns `generated`, 2 turns `blocked`, com `blocked_say_text` persistido para brinde e oferta custom.

### Bug 15 [M] — Action Validator passa em branco para 5 ações
- **Arquivo:** [action-validator.ts:148-154](../src/atendente/validators/action-validator.ts)
- **Sintoma:**
```typescript
case 'remove_from_cart':
case 'update_cart_item':
case 'clear_cart':
case 'update_draft':
case 'escalate':
case 'select_skill':
  return { valid: true };
```
- `escalate` aceita qualquer reason sem checar pré-condição (ex: `ready_to_close` sem cart confirmado).
- `update_draft` aceita slots sem validar consistência (ex: `fulfillment_mode='delivery'` sem `delivery_address`).
- `clear_cart` ignora se há `pending_confirmation` aberta.
- **Fix:** adicionar validações por caso. ~meio dia.

### Bug 16 [M] — `loadCurrent` não popula `derived_signals.stale_slots`
- **Arquivo:** [agent-state.repository.ts:230-236](../src/atendente/state/agent-state.repository.ts)
- **Sintoma:** inicializa `stale_slots: []` e nunca atualiza, mesmo havendo slots com `stale != 'fresh'` no banco.
- **Consequência:** Planner recebe sinal vazio. Depende de prompts/normalizadores compensarem.
- **Fix:** após carregar slots (linha 241+), iterar e adicionar slot_keys com `stale != 'fresh'` ao `derived_signals.stale_slots`.

### Bug 17 [M] — `hydrateGeneratorAction` não espalha `base` em `update_draft` [DESCOBERTO POR CODEX, CONFIRMADO EM PROD]
- **Arquivo:** [generator/schemas.ts:178-186](../src/atendente/generator/schemas.ts#L178-L186)
- **Sintoma:** dos 4 cases na função, três usam `...base` (que adiciona `action_id, turn_index, emitted_at, emitted_by`) — `update_slot`, `create_item`, `record_offer`. **`update_draft` não.**
- **Confirmado em prod (V2 da seção 4.5):** `updateDraftSchema` aceita action sem metacampos (action legacy), e o banco já tem **22 turns + 25 eventos `update_draft`/`fact_corrected` com `action_id NULL`**. Não é especulação, é dívida acumulada.
- **Consequência:** retry de `update_draft` não cai em `ON CONFLICT (action_id) DO NOTHING` porque action_id é null — pode duplicar evento no `session_events` em caso de retry/reprocessamento. Auditoria também perde rastreabilidade determinística.
- **Decisão arquitetural a tomar:** padronizar **todas** as actions emitidas pelo Generator com metacampos (action_id, turn_index, emitted_at, emitted_by) ou manter `update_draft` como legacy?
  - **Recomendação minha:** padronizar. Auditoria/idempotência é princípio central do projeto (deterministicUuid em todo lugar). Manter legacy cria assimetria que vai morder em produção.
  - Para o legado (22 turns + 25 eventos): **não migrar retroativamente.** Esses são dados shadow, não vão pra cliente. Aceita o gap, marca pelo `prompt_version` no payload, e pra frente todos têm metacampos.
- **Fix:** adicionar `...base` ao case `update_draft` em `hydrateGeneratorAction`. 1 linha + teste unitário cobrindo `update_draft.action_id` não-nulo.
- **Pré-requisito:** atualizar `updateDraftSchema` em [agent-actions.ts](../src/shared/zod/agent-actions.ts) para exigir metacampos como required (alinhar com os outros 3 schemas).

---

## 4. Bugs REFUTADOS (transparência)

Coisas que afirmei em rodadas anteriores e que a leitura linha a linha desmentiu:

| Afirmação | Status | Onde provei errado |
|---|---|---|
| `cart_events` está vazia | **REFUTADO** | [agent-state.repository.ts:537-548](../src/atendente/state/agent-state.repository.ts) popula com tipos diferenciados |
| `applyEscalate` não escreve em `agent.escalations` | **REFUTADO** | [agent-state.repository.ts:635-654](../src/atendente/state/agent-state.repository.ts) `syncEscalation` faz INSERT idempotente |
| Event types `tool_executed`/`planner_decided`/`generator_produced` fora do CHECK | **REFUTADO** | Migrations [0025](../db/migrations/0025_planner_foundation.sql), [0026](../db/migrations/0026_tool_executor_events.sql), [0027](../db/migrations/0027_generator_shadow_events.sql) estendem cumulativamente |
| 11 skills (count errado) | **REFUTADO** | [planner/schemas.ts:13-21](../src/atendente/planner/schemas.ts) tem 7 canônicas |
| `commerce.*` vazio (afirmação inicial) | **REFUTADO POR CODEX via banco vivo** | 3 produtos, 70 modelos, 624 bairros, 115 zonas, 14 políticas. Subdimensionado, não vazio. |

---

## 4.5 Limitações desta auditoria (transparência pós-Codex)

**Esta auditoria foi parcialmente cega:**

1. **Não consultou banco vivo em prod.** Trabalhou só sobre código + migrations + docs. Codex cruzou com banco e me corrigiu em 2 pontos críticos:
   - "commerce.* vazio" → na verdade subdimensionado (3 produtos, 70 modelos, 624 bairros, 115 zonas, 14 políticas).
   - 294 turns existem em prod (243 generated, 51 blocked). Não analisei distribuição de `block_reason`.

2. **Leitura parcial do action set.** Li `agent-actions.ts` (action set total) mas não cruzei com `generator/schemas.ts` (subset emitível pelo Generator). Resultado: cenários hipotéticos atribuídos como atuais. Codex corrigiu em Bug 3.

3. **Não verifiquei origem de coluna antes de prescrever index.** Bug 10 fix estava no schema errado. Codex corrigiu (`tire_specs`, não `products`).

4. **Misturei namespaces de `fact_keys` (Organizadora) e `slot_keys` (Atendente).** Bug 6 saiu com nomes inexistentes. Codex corrigiu.

5. **Bug 17 me escapou.** Codex achou na hidratação do `update_draft`.

**Resultado consolidado:** 16 bugs originais cravados se mantêm depois das correções acima (com Bugs 3, 6, 10 refinados); +1 bug descoberto por Codex (Bug 17). Total: **17 bugs**, todos com referência de arquivo:linha.

**Verificações em prod (rodadas por Codex em 07/05):**

| # | Query | Resultado | Interpretação |
|---|---|---|---|
| V1 | Distribuição dos 51 turns blocked por `block_reason` | 31 `delivery_claim_without_calcular_frete`, 10 falta de chave Generator, 3 dinheiro sem tool, 3 estoque sem tool, 2 schema_failed, 1 item_not_found, 1 fitment sem tool | Maior bloqueio é `delivery_claim` — auditar amostra antes de mexer no Say Validator (pode ser regex agressiva) |
| V2 | `update_draft` em `session_events` com `action_id IS NULL` | **22 turns + 25 eventos sem metacampos** | Bug 17 confirmado em prod. Não é especulação. |
| V3 | `schema_violation` últimos 7 dias | 42 incidentes severity=`low` | Taxa ~5% do total (807 facts). Aceitável pra shadow, vale ver distribuição de `details.error` |
| V4 | Confiança média Organizadora últimos 7 dias | 807 facts, conf média **0.9406** | Excelente. Baseline sólido pra comparar se trocar pra mini |
| V5 | Performance `buscarProduto` | Hoje rápido (3 produtos) | Risco do Bug 10 é prospectivo — fica relevante quando catálogo crescer pra >100 |

**V1-V5 fechadas. Codex rodou em 07/05.**

**Pendência descoberta e já corrigida no PR 1:** auditar a amostra dos `delivery_claim_without_calcular_frete` não era trivial porque `agent.turns.say_text` era gravado como NULL/vazio quando `status='blocked'`. O PR 1 adicionou persistência auditável (`blocked_say_text`, `blocked_actions`, `blocked_payload`) para os candidatos bloqueados.

Implicação prática atual: o banco já consegue guardar o texto bloqueado; então o fechamento do Bug 14 depende de smoke LLM específico e leitura de `blocked_say_text`, não mais de migration.

- **Bug 14a [feito]:** `agent.turns` persiste candidato bloqueado para auditoria.
- **Bug 14b [feito PR5]:** marca, desconto, brinde/promoção e oferta custom têm bloqueios determinísticos e foram validados com LLM real em prod shadow.

Antes do PR 1, "auditar 31 textos" era palpite; agora a auditoria é possível quando houver novos bloqueios gravados.

---

## 5. Drift entre documentação e código

| Doc | Inconsistência | Recomendação |
|---|---|---|
| [docs/phase3-agent-architecture/09](phase3-agent-architecture/09-skills-router-e-validadores.md) | Lista 9 skills antigas (`confirmar_necessidade, calcular_entrega, fechar_pedido, responder_politica, pedir_confirmacao` + 4 atuais). Código tem 7. | Atualizar com mapping real: `responder_geral`, `pedir_dados_faltantes`, `buscar_e_ofertar`, `responder_logistica`, `tratar_objecao`, `registrar_intencao_fechamento`, `escalar_humano` |
| [docs/phase3-agent-architecture/11](phase3-agent-architecture/11-perguntas-abertas.md) | "LLM usada — ainda não definido" | Atualizar para "OpenAI gpt-4o-mini default, configurável por papel via env" |
| [docs/phase3-agent-architecture/14](phase3-agent-architecture/14-topologia-de-execucao.md) | Menciona `node dist/farejador.js` etc. (3 entrypoints) | Realidade: servidor único com workers internos via `startAtendenteShadow`/`startOrganizadora`. Ajustar ou implementar separação |

---

## 6. Hardening PR 1–5 — FECHADO

Esta seção substitui o cronograma antigo de checkboxes. O cronograma original misturava hardening já concluído com roadmap futuro; a partir de 2026-05-10, a leitura correta é:

- **Hardening PR 1–5:** fechado, testado localmente e validado com LLM real em shadow.
- **Roadmap pós-hardening:** catálogo, Supervisora/Critic, telemetria de custo, checkout dedicado e envio controlado ao Chatwoot.

### Fechado

| PR | Status | Validação |
|---|---|---|
| PR 1 — Auditoria de turns bloqueados + Bug 17 | Fechado | `blocked_say_text`/`blocked_payload` persistidos; `update_draft` com metacampos; migration `0028` aplicada/verificada |
| PR 2 — Estado e contexto | Fechado | Context Builder configurável; stale slots carregados; troca de item invalida oferta/slots antigos; smoke LLM real validou contexto longo |
| PR 3 — Validators de actions e eventos | Fechado | Action Validator endurecido; `session_events` com eventos semânticos; `cart_events.updated`; smoke LLM bloqueou estoque sem tool com auditoria |
| PR 4 — Organizadora e ops | Fechado | Reclaim de job zumbi; envs operacionais; limitação de mensagem editada documentada; smoke LLM pós-redeploy sem quebra de fluxo |
| PR 5 — Say Validator comercial | Fechado | Desconto, brinde/promoção, marca e oferta custom sem lastro protegidos; smoke LLM `470`–`473` validou 6 generated, 2 blocked e `blocked_say_text` preservado |

**Conclusão do hardening:** o agente em shadow ficou protegido contra os principais incidentes comerciais: preço sem tool, estoque sem tool, frete sem tool, compatibilidade sem tool, política comercial sem tool, marca sem lastro, desconto inventado, brinde inventado e oferta custom inventada.

## 6.1 Roadmap Pós-Hardening

Estes itens não bloqueiam o fechamento do hardening PR 1–5. Eles pertencem ao próximo ciclo operacional rumo à Sprint 8.

### Catálogo `commerce.*`

- Cadastrar produtos para as 5 medidas reais que cobrem 82,61% da demanda observada: `140/70-17`, `90/90-18`, `100/80-18`, `110/70-17`, `110/90-17`.
- Ter pelo menos 2 marcas por medida em `commerce.products` + `commerce.tire_specs` + `commerce.stock_levels`.
- Revisar `commerce.vehicle_fitments` para ligar medidas aos modelos mais citados.
- Consolidar aliases em `commerce.vehicle_models`: Titan/Titan 160/Titan 150, Biz/Biz 125, Bros/Bros 160, CG/CG 160 e variantes reais.

### Qualidade e Operação

- Implementar telemetria de tokens/custo em `agent.turns`.
- Rodar query de supersedência da Organizadora para validar correções de moto.
- Implementar Supervisora batch em vez de Critic em tempo real.
- Atualizar docs 09, 11 e 14 com mapping atual.

### Checkout e Fluxo Futuro

- Criar sub-fluxo `coletar_dados_pedido` dentro de `registrar_intencao_fechamento`.
- Criar normalizador de interrupção de checkout: se o cliente muda produto/medida/marca durante fechamento, voltar para `buscar_e_ofertar`.
- Adicionar teste unitário de checkout interrompido por troca de produto.
- Implementar `intent_to_close_recorded` se a sprint de checkout dedicado exigir esse evento.
- Manter `replace_cart_item` como prospectivo: só fazer quando o Generator passar a emitir ações de carrinho.

### Sprint 8 — Envio Controlado ao Chatwoot

- Implementar `ChatwootApiClient.postMessage()` e integração no worker.
- Criar `ATENDENTE_SEND_ENABLED=false` por default.
- Permitir piloto por tag/label do Chatwoot, por exemplo `agent-piloto`.
- Registrar cada envio como `agent_message_sent`.
- Rodar piloto com 5 conversas reais acompanhadas por Wallace.
- Auditar 50 conversas piloto antes de GO/NO-GO.

---

## 6.5 Status dos Bugs e Pendências

Esta matriz separa bug de hardening fechado, pendência prospectiva e roadmap pós-hardening.

| Item | Status | Observação |
|---|---|---|
| Bug 1 — `set_active_item` invalida oferta + slots antigos | Fechado PR2 | Validado em testes e smoke LLM de contexto |
| Bug 2 — Event types diferenciados em `session_events` | Fechado PR3 | Migration `0029` aplicada/verificada |
| Bug 3 — `replace_cart_item` ausente | Prospectivo | Só fazer quando Generator passar a emitir ações de carrinho |
| Bug 4 — `update_cart_item` emitia `replaced` | Fechado PR3 | `updated` reservado para quantity-only |
| Bug 5 — `intent_to_close_recorded` | Roadmap checkout | Fazer se o sub-fluxo dedicado exigir esse evento |
| Bug 6 — `INVALIDATION_RULES` incompleto | Fechado PR2 | Slot keys reais adicionados |
| Bug 7 — UPSERT em `syncSessionSlots` | Pós-piloto | Baixa severidade; não bloqueia shadow nem piloto inicial |
| Bug 8 — Context Builder limit hardcoded | Fechado PR2 | Limits configuráveis via env |
| Bug 9 — Tool execution paralela | Roadmap otimização | Ganho de latência; não bloqueia hardening PR1–5 |
| Bug 10 — Index funcional em `tire_specs` | Roadmap catálogo | Relevante quando catálogo crescer |
| Bug 11 — Lease/reclaim em `enrichment_jobs` | Fechado PR4 | Job zumbi recuperável |
| Bug 12 — Magic numbers hardcoded | Fechado parcialmente PR4 | Env principais movidos; TTL de `request_confirmation` fica como polimento |
| Bug 13 — Mensagem editada e evidence literal | Documentado PR4 | Só resolver se houver histórico versionado de mensagens editadas |
| Bug 14 — Say Validator comercial | Fechado PR5 | Validado com LLM real em 10/05 |
| Bug 14a — Persistir candidato bloqueado | Fechado PR1 | `blocked_say_text`, `blocked_actions`, `blocked_payload` |
| Bug 15 — Action Validator sem preconditions | Fechado PR3 | `escalate`, `update_draft`, `clear_cart`, `remove/update_cart_item` |
| Bug 16 — `stale_slots` não carregado | Fechado PR2 | `loadCurrent` lê slots stale do banco |
| Bug 17 — `update_draft` sem `...base` | Fechado PR1 | Metacampos padronizados |

**Verificações em prod V1–V5:** fechadas por Codex em 07/05, resultados na seção 4.5.

**Hardening PR1–PR5:** fechado.

**Próximo caminho crítico real:** catálogo `commerce.*` + Supervisora batch + envio controlado ao Chatwoot.

---

## 7. Critérios objetivos de saída do Shadow

A regra atual ("~5 semanas em shadow") é vaga. Cravando critérios concretos:

| Métrica | Target pra GO | Como medir |
|---|---|---|
| Say Validator block ratio | < 5% dos turnos | `SELECT count(*) FILTER (WHERE status='blocked') / count(*) FROM agent.turns WHERE created_at > now() - interval '7 days'` |
| Action Validator block ratio | < 3% das actions | Query similar via `ops.agent_incidents WHERE incident_type='validator_blocked'` |
| 0 alucinação grave em amostra de 50 conversas | obrigatório | Auditoria humana semanal, top 50 conversas |
| p95 latência turno (webhook → turn registrado) | < 12s | Calcular a partir de logs estruturados |
| Catálogo piloto populado | 5 medidas reais cobertas (82,61% da demanda), ≥ 2 marcas por medida, estoque/preço/fitments ativos | Queries em `commerce.products`, `commerce.tire_specs`, `commerce.stock_levels` e `commerce.vehicle_fitments` por medida |
| Conversas reais auditadas | ≥ 50, com ≥ 90% aprovação | Auditoria humana via Supervisora batch |
| Critérios comerciais sem incidente | 0 desconto inventado, 0 promoção inventada, 0 marca não-cadastrada afirmada | Logs de Say Validator + Supervisora batch |

**GO quando todos verdes simultaneamente em 7 dias consecutivos.**

---

## 8. O que está conscientemente fora do plano

| Item | Por quê |
|---|---|
| **Critic em tempo real (Sprint 7 original)** | Substituído por Supervisora batch. Custo de latência (3-5s adicional) inviabiliza p95 < 12s no gpt-5.4. |
| **Refator das 7 skills pra menos** | Sem dado de regressão. Fundir cedo demais joga fora calibração de Say Validator por skill. |
| **Audio transcription** | Phase 2b. Hoje só guarda URL. |
| **Multi-tenant** | Out of MVP. |
| **Phase 4 — LLM próprio** | Parqueada indefinidamente. |
| **Microservices / 3 containers separados** | Doc 14 menciona como ideal, mas servidor único cobre carga atual. Migrar quando volume justificar. |
| **LISTEN/NOTIFY no lugar de polling** | Polling 250-500ms basta pro volume atual. Migrar quando latência for problema medido, não suposto. |

---

## 9. Riscos e contramedidas

| Risco | Probabilidade | Mitigação |
|---|---|---|
| Catálogo demora mais que 2 semanas pra ser populado | Alta | Wallace começa hoje. Ajuda de estagiário/funcionário pra digitação. Cronograma já reserva 3 semanas. |
| Bug não previsto aparece em conversas piloto | Alta | Sprint 8 liga em 5 conversas, não 100. Wallace audita em tempo real. Rollback é flag `ATENDENTE_SEND_ENABLED=false`. |
| Cliente envia mensagem ofensiva / fora do escopo | Média | `responder_geral` + `escalar_humano` já cobrem. Adicionar Say Validator pra linguagem inadequada não bloqueia, mas vale incluir em retrabalho pós-piloto. |
| Custo de API explode | Baixa | Cap automático: alerta se > 100 USD/dia. Configurar billing alert na OpenAI. Telemetria de tokens (item D4) torna custo visível. |
| Latência p95 explode quando catálogo enche | Média | Bug 10 (index funcional) resolve. Validar com `EXPLAIN ANALYZE` antes de Sprint 8. |
| Supervisora batch não fornece sinal útil | Média | Iterar prompt da Supervisora baseado em primeiras 50 conversas. Custo baixo (~5 USD/mês). |

---

## 10. Resumo em 5 linhas (revisado pós-Codex)

1. **Arquitetura sólida.** Schema fechado, append-only enforced, optimistic lock, idempotência atômica. Trabalho de qualidade.
2. **17 bugs cravados em código** (16 originais + 1 descoberto por Codex), todos de hardening. Nenhum exige reescrita. 4 bugs revisados pós-Codex (Bug 3 prospectivo, Bug 6 slots reais, Bug 10 schema correto, novo Bug 17).
3. **Bloqueio funcional é catálogo subdimensionado** — 3 produtos em `commerce.products` (não vazio como afirmei inicialmente). Camada de suporte (geo/modelos/políticas) já populada.
4. **Cronograma realista de 4–5 semanas** até Sprint 8 com agente respondendo em 5 conversas piloto. Caminho crítico: ~13-14 dias dev + tempo Wallace pra cadastrar produtos cobrindo as 5 top medidas reais (140/70-17, 90/90-18, 100/80-18, 110/70-17, 110/90-17 — 82,61% da demanda).
5. **Critic em tempo real DEFERIDO.** Substituído por Supervisora batch — 1/3 do esforço, sem custo de latência, mesmo valor operacional.

---

## 11. Histórico de revisões

| Data | Revisão | Autor |
|---|---|---|
| 2026-05-07 | Auditoria inicial: 16 bugs cravados, cronograma 4-5 semanas até Sprint 8 | Claude (Opus) |
| 2026-05-07 | Revisão cruzada com banco vivo + leitura do subset emitível do Generator | Codex |
| 2026-05-07 | Incorporadas correções: Bug 0/catálogo (subdimensionado, não vazio), Bug 3 (prospectivo), Bug 6 (slot_keys reais), Bug 10 (tire_specs, não products). Adicionado Bug 17 (update_draft sem `...base`). Adicionada seção 4.5 (limitações) e seção 6.5 (cronograma específico dos 17 bugs) | Claude (Opus) |
| 2026-05-07 | **Limpeza pós-Codex (rodada 2):** removido Bug 3 da Semana 2 (estava contradizendo a própria seção 6.5). Trocado palpite de volume fixo de catálogo pelo critério data-driven com top 5 medidas reais (82,61% da demanda). V1-V5 marcadas como fechadas em vez de pendentes. Adicionado Bug 14a (persistir texto candidato bloqueado) como pré-requisito de Bug 14, porque `agent.turns.say_text` é null quando `status='blocked'`. Adicionada nota de aliases em `commerce.vehicle_models` antes de Wallace cadastrar | Claude (Opus) |
| 2026-05-08 | **Execução Codex PR 3:** Bug 15 implementado no Action Validator; Bug 2 implementado com migration `0029_cart_action_events_hardening.sql` e eventos semânticos em `session_events`; Bug 4 implementado com `cart_events.updated`. Migration `0029` aplicada/verificada no Supabase atual. Testes: typecheck verde, `npm test` 379/379, integração Atendente 8/8, build verde. Smoke LLM pós-deploy na conversa Chatwoot `452`: Organizadora 12 facts, Planner `planner_v1.2.5` com tools comerciais, Generator 2 generated + 1 blocked por `stock_claim_without_verificar_estoque`, com `blocked_say_text` preservado. Limite: sem `update_draft` no smoke; `draft_updated` validado por testes determinísticos. | Codex |
| 2026-05-08 | **Ajuste pós-smoke Codex:** Generator bumpado para `generator_v1.3.2` com regra explícita de fechamento seguro: cliente informou nome/pagamento/endereço ou "pode fechar" -> emitir `update_draft` mesmo sem estoque confirmado, e responder chamando humano para confirmar produto/estoque. Novo teste unitário cobre o caso; suíte 380/380 verde. | Codex |
| 2026-05-08 | **Smoke real generator_v1.3.2:** conversa Chatwoot `453` validou o caminho que faltava: Generator emitiu `update_draft` com nome, pix, delivery e endereço; `agent.session_events` gravou `draft_updated`; resposta não prometeu estoque e pediu confirmação humana. | Codex |

---

| 2026-05-08 | **Execucao Codex PR 4:** Bug 11 implementado com reclaim de `ops.enrichment_jobs` `running` vencido via `ORGANIZADORA_STALE_JOB_AFTER_SECONDS`; Bug 12 parcialmente implementado com `ORGANIZADORA_MIN_CONFIDENCE`, `ATENDENTE_CONTEXT_TOOL_EVENTS_LIMIT` e `ATENDENTE_CONTEXT_ORGANIZER_FACTS_LIMIT`; Bug 13 documentado como limitacao conhecida sem historico versionado de mensagem editada. Testes locais: `npm test` 381/381, typecheck e build verdes; integracao parcial passou em 2 suites e 3 suites dependentes de Testcontainers nao rodaram por falta de runtime Docker. | Codex |
| 2026-05-08 | **Smoke PR4 pos-redeploy:** conversas Chatwoot `454`-`459`. Organizadora processou 6/6 `enrichment_jobs` como `done`, tentativa 1, sem erro, com facts corretos para Titan 160, Biz 125/Pirelli/par, CB 300/140-70-17, Jardim America/entrega, Mercado Livre/achou_caro e Fazer 250. Planner `planner_v1.2.5` e Generator `generator_v1.3.2` rodaram com LLM real. Achados: Planner chamou `verificarEstoque` uma vez sem `product_id` (tool_failed seguro) e Generator fez claim de marca ("Tem Pirelli sim...") sem lastro; reforca prioridade do PR5 Say Validator comercial. | Codex |
| 2026-05-08 | **Fix pos-smoke PR4 / PR5 inicial:** Planner bumpado para `planner_v1.2.6`, com contrato de `verificarEstoque` exigindo `product_id` ou `product_code` no schema/prompt/normalizacao. Say Validator passa a bloquear claim positivo de marca sem `buscarProduto` (`brand_claim_without_buscar_produto`), cobrindo o caso "Tem Pirelli sim..." visto no smoke. Testes: `npm test` 384/384, typecheck, build e integracao `atendente-commerce-tools` 5/5 verdes. | Codex |
| 2026-05-08 | **Smoke pos-deploy `planner_v1.2.6`:** conversas Chatwoot `460`-`465`. Organizadora processou 6/6 jobs como `done`, tentativa 1, sem erro. Planner rodou com `planner_v1.2.6` e auditoria retornou `BAD_STOCK_TOOL_CALLS []`, sem `verificarEstoque` sem produto. Generator nao repetiu "Tem Pirelli sim" sem lastro; respondeu pedindo ano da Biz ou dizendo que precisava confirmar compatibilidade/valor antes de passar. Sem envio ao cliente. | Codex |
| 2026-05-08 | **PR5 comercial implementação local:** Say Validator passou a tratar desconto, brinde/promoção e oferta custom como política comercial obrigatória. Bloqueia "Consigo 5% de desconto" sem `desconto_maximo`, bloqueia desconto acima do máximo cadastrado, bloqueia "levando 2 ganha brinde" sem política promocional e bloqueia "faço por R$ 200" sem política comercial. Teste focado: `say-validator.test.ts` 49/49 verde. | Codex |
| 2026-05-10 | **Smoke LLM PR5 pós-deploy:** conversas Chatwoot `470`-`473`, run `pr5-commercial-20260510190449`. Organizadora extraiu 23 facts; Planner processou 8/8 jobs; Generator gerou 6 turns seguros e bloqueou 2 turns comerciais perigosos. Brinde foi bloqueado com `policy_claim_without_tool_result`; oferta "faz por R$ 200" foi bloqueada com `money_not_supported_by_tool_result:200`; ambos preservaram `blocked_say_text`. Desconto de 10% foi respondido de forma segura sem promessa; Pirelli caiu em fallback seguro. | Codex |

## 12. Fechamento do Hardening

O plano original de execução dos 17 bugs em 5 PRs foi cumprido para o escopo de hardening da Atendente em shadow.

| Bloco | Status final |
|---|---|
| PR 1 — Auditoria de bloqueios + `update_draft` | Fechado |
| PR 2 — Estado/contexto | Fechado |
| PR 3 — Validators/eventos | Fechado |
| PR 4 — Organizadora/ops | Fechado |
| PR 5 — Say Validator comercial | Fechado e validado com LLM real |

**O que este fechamento significa:** o agente pode continuar em shadow com auditoria forte, sem envio ao cliente, e com proteção contra as principais alucinações comerciais.

**O que este fechamento não significa:** ainda não é autorização para envio automático ao cliente. Para isso, faltam catálogo real, Supervisora batch, piloto controlado e decisão GO/NO-GO.

**Próxima execução recomendada:** escolher entre começar pelo catálogo `commerce.*` ou pela Supervisora batch. Catálogo destrava venda; Supervisora destrava qualidade operacional.

---

**Auditoria assinada com referência de linha + cruzamento com banco vivo via Codex.** Tudo nas tabelas de pontos fortes e bugs foi lido. Itens fora de escopo estão marcados explicitamente. Itens refutados estão documentados em prol de transparência. **V1-V5 fechadas em 07/05.** PR1-PR5 de hardening foram implementados e validados; Bug 14/PR5 teve smoke LLM em 10/05. Catálogo Sprint 8: cobrir 5 medidas que somam 82,61% (140/70-17, 90/90-18, 100/80-18, 110/70-17, 110/90-17), com aliases consolidados em `commerce.vehicle_models` (Titan/Biz/Bros/CG e variantes).
