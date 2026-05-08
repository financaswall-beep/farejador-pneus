# Auditoria Completa — Estado e Cronograma de Hardening
**Data inicial:** 2026-05-07
**Última revisão:** 2026-05-08 (PR 3 implementado por Codex)
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
| Estado reentrante Atendente | Implementado, com gaps | **Sim** |
| Skills (7 canônicas) | Implementadas | Não |
| Planner (v1.2.5) | Em prod shadow | Não |
| Tool Executor | Implementado | Não |
| Generator Shadow (v1.3.1) | Em prod shadow | Não |
| Validators (say + action) | Implementados, com gaps | **Sim** |
| Catálogo `commerce.*` | **Subdimensionado** — 3 produtos, 3 specs, 3 estoques, 70 modelos, 25 fitments, 14 políticas, 624 bairros, 115 zonas [REVISADO POR CODEX] | **Sim — bloqueio funcional** (3 produtos não vendem 10/dia) |
| Critic (Sprint 7) | Não existe | Decidir: substituir por Supervisora batch |
| Envio Chatwoot (Sprint 8) | Não existe | Aguarda hardening |

**Verdict curto:** arquitetura sólida (schema fechado, append-only enforced em DB, optimistic lock, idempotência atômica, evidência literal exigida). Código com **17 bugs cravados** (16 originais + 1 descoberto por Codex), todos de hardening — nenhum exige reescrita. **Bloqueio operacional principal não é código, é catálogo subdimensionado** — tem dado de suporte (geo, modelos, políticas) bem populado, mas só 3 produtos cadastrados.

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

### Bug 14 [A] — Say Validator não cobre 4 categorias críticas
- **Arquivo:** [say-validator.ts](../src/atendente/validators/say-validator.ts)
- **Cobre:** preço sem tool, estoque, prazo de entrega, compatibilidade, política, valores em R$.
- **NÃO cobre:**
  - Menção a desconto não cadastrado ("te dou 5% off")
  - Menção a brinde/promoção ("levou 2, ganha câmara")
  - Menção a marca específica não validada ("temos Pirelli")
  - Condição comercial nova ("se levar 2, faço por R$ 200")
- **Severidade:** alta antes de Sprint 8. Esses são exatamente os tiros que o cliente vai testar quando souber que tem bot.
- **Fix:** novos blocos `mentionsDiscountClaim`, `mentionsPromotionClaim`, `mentionsBrandWithoutToolEvidence`, `mentionsCustomCommercialOffer` em say-validator.

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

**Pendência nova descoberta na rodada de fechamento:** auditar a amostra dos 31 `delivery_claim_without_calcular_frete` **não é trivial** porque `agent.turns.say_text` é gravado como NULL/vazio quando `status='blocked'` ([generator/service.ts:340](../src/atendente/generator/service.ts#L340) — `result.blocked ? null : result.say_text`). Hoje o sistema **não persiste o texto candidato bloqueado**.

Implicação prática: pra separar bug real (regex agressiva) de validator funcionando, **precisa primeiro adicionar persistência auditável do texto bloqueado**, ANTES de mexer no Bug 14. Essa virou pré-requisito do Bug 14:

- **Pré-requisito Bug 14a:** adicionar coluna `blocked_say_text` em `agent.turns` (ou um JSONB `blocked_payload` que guarde say + actions cruas + block_reason). Migration trivial. Worker grava mesmo quando blocked.
- **Bug 14b (depois):** com texto persistido por 7 dias, Codex roda amostra, eu leio, cravamos se a regex tem que afrouxar ou se basta adicionar regras de desconto/promoção/marca.

Sem isso, "auditar 31 textos" é palpite — eles não existem em forma legível no banco hoje.

---

## 5. Drift entre documentação e código

| Doc | Inconsistência | Recomendação |
|---|---|---|
| [docs/phase3-agent-architecture/09](phase3-agent-architecture/09-skills-router-e-validadores.md) | Lista 9 skills antigas (`confirmar_necessidade, calcular_entrega, fechar_pedido, responder_politica, pedir_confirmacao` + 4 atuais). Código tem 7. | Atualizar com mapping real: `responder_geral`, `pedir_dados_faltantes`, `buscar_e_ofertar`, `responder_logistica`, `tratar_objecao`, `registrar_intencao_fechamento`, `escalar_humano` |
| [docs/phase3-agent-architecture/11](phase3-agent-architecture/11-perguntas-abertas.md) | "LLM usada — ainda não definido" | Atualizar para "OpenAI gpt-4o-mini default, configurável por papel via env" |
| [docs/phase3-agent-architecture/14](phase3-agent-architecture/14-topologia-de-execucao.md) | Menciona `node dist/farejador.js` etc. (3 entrypoints) | Realidade: servidor único com workers internos via `startAtendenteShadow`/`startOrganizadora`. Ajustar ou implementar separação |

---

## 6. Cronograma de Hardening — 4 a 5 semanas até Sprint 8

Cronograma realista com base em velocidade observada (commits dos últimos 30 dias) e considerando que **catálogo é tarefa do Wallace, não de código**.

> **Nota pós-Codex (07/05):** o cronograma original assumia "encher catálogo do zero". Como prod já tem 70 modelos, 14 políticas, 624 bairros e 115 zonas (camada de suporte populada), a tarefa se reduz a **cadastrar produtos/specs/estoques cobrindo as top medidas reais que aparecem em conversas**, não um número redondo. Codex rodou a query: as **5 primeiras medidas somam 82,61% da demanda observada — `140/70-17`, `90/90-18`, `100/80-18`, `110/70-17`, `110/90-17`**. Critério de catálogo Sprint 8 piloto: cobrir essas 5 medidas com pelo menos 2 marcas cada (10–15 produtos de pneu) + estoques + fitments para os modelos correspondentes. Isso encurta o caminho crítico do catálogo de "1-7 dias" pra "2-3 dias" do Wallace.

### Semana 1 (07–13/maio) — Quick wins + começa catálogo

**Wallace (paralelo, segue toda semana):**
- [ ] D0 (hoje): trocar env vars no Coolify pra configuração definida (orçamento até R$ 1.500/mês):
  ```
  OPENAI_MODEL=gpt-4o-mini       # Organizadora
  PLANNER_MODEL=gpt-5.4-mini     # Planner (reasoning + família 5.4)
  GENERATOR_MODEL=gpt-5.4        # Generator (cliente lê esse texto, não toca)
  ```
  → **Economia ~R$ 800/mês imediata.** Reverter é trocar var e redeploy (30s).
- [ ] D1–D4: **cadastrar produtos cobrindo as 5 top medidas reais (82,61% da demanda):** `140/70-17`, `90/90-18`, `100/80-18`, `110/70-17`, `110/90-17`. Mínimo 2 marcas por medida em `commerce.products` + `commerce.tire_specs` + `commerce.stock_levels`. Revisar `commerce.vehicle_fitments` pra ligar essas medidas aos 70 modelos já cadastrados.
  - **Pré-requisito:** consolidar aliases nos `commerce.vehicle_models` (`aliases TEXT[]`) — ex.: Titan/Titan 160/Titan 150, Biz/Biz 125, Bros/Bros 160, CG/CG 160. Sem isso, a busca por compatibilidade vai fragmentar.
- [ ] **V1-V5 já foram rodadas por Codex em 07/05** (resultados na seção 4.5). Não rodar de novo.
- [ ] D1: rodar query de auditoria de supersedência da Organizadora:
```sql
WITH moto_versions AS (
  SELECT contact_id, COUNT(*) AS versoes,
         COUNT(CASE WHEN superseded_by IS NULL THEN 1 END) AS ativos
  FROM analytics.conversation_facts
  WHERE fact_key = 'moto_modelo' AND environment = 'prod'
  GROUP BY contact_id
  HAVING COUNT(*) > 1
)
SELECT COUNT(*) AS contatos_com_troca,
       SUM(CASE WHEN ativos > 1 THEN 1 ELSE 0 END) AS contatos_bug
FROM moto_versions;
```
Se `contatos_bug > 0`, abrir incidente.

**Dev (PR 1 primeiro; depois quick wins de estado/validator):**
- [ ] D1: **PR 1 / Bug 14a** — persistir candidato bloqueado do Generator (`blocked_say_text` / `blocked_actions` / `blocked_payload`) para permitir auditoria real do Say Validator.
- [ ] D1-D2: **PR 1 / Bug 17** — `update_draft` com `...base` em `hydrateGeneratorAction` + `updateDraftSchema` exigindo metacampos.
- [x] D2: Bug 15 — Action Validator: pre-condição em `escalate`, `update_draft`, `clear_cart`.
- [ ] D2: Bug 8 — Context Builder limit configurável via env. Default sobe pra 20.
- [ ] D3: Bug 1 — `applySetActiveItem` invalida oferta + slots de item antigo.
- [ ] D3: Bug 16 — `loadCurrent` popula `derived_signals.stale_slots`.
- [ ] D4: Telemetria de tokens em `agent.turns` (colunas `prompt_tokens`, `completion_tokens`, `cached_tokens`, `model`, `cost_estimated_brl`). Já vem da OpenAI, só falta persistir.
- [ ] D5: Bug 6 — Expandir INVALIDATION_RULES com slot_keys reais que faltam: `posicao_pneu`, `marca_preferida`, `marca_recusada`, `municipio` (global), `forma_pagamento` (global), `moto_cilindrada`, `quantidade`, `faixa_preco_max`. (Correção pós-Codex — versão original tinha fact_keys em vez de slot_keys.)

**Saída da semana 1:** PR 1 concluído; Bug 14a ativo em shadow; Bug 14 aguardando amostra real para PR 5. Quick wins de estado/validator podem avançar depois do PR 1.

### Semana 2 (14–20/maio) — Sub-fluxo + ações atômicas

**Wallace:**
- [ ] D8–D14: continua catálogo pelo critério data-driven: 5 medidas reais cobertas, pelo menos 2 marcas por medida, preço, estoque, fitments e aliases consolidados. Não perseguir número redondo de produtos.
- [ ] D10: refazer query de supersedência. Validar que correções de moto estão limpas.

**Dev:**
- [ ] D8–D10: Sub-fluxo checkout linear nomeado. Skill `coletar_dados_pedido` interna ao `registrar_intencao_fechamento` com slot order fixo: `nome → bairro → modalidade → pagamento → confirmação`. Generator dentro dessa skill tem prompt restrito.
- [ ] **REMOVIDO da Semana 2 (correção Codex):** Bug 3 (`replace_cart_item`) é prospectivo — fazer junto com sprint de expansão do action set do Generator, não antes. Não consome capacidade de dev nesta semana.
- [x] D11: Bug 4 — Mapeamento correto de cart_events (`replaced` só pra mudança de produto).
- [ ] D12: Normalizador determinístico de "interrupção de checkout": se `current_skill='registrar_intencao_fechamento'` e mensagem cita produto/medida/marca/troca, força saída pra `buscar_e_ofertar`. Em código TS, igual ao fix v1.2.5.
- [ ] D13: Teste unitário "checkout interrompido por troca de produto" cobrindo:
  - cart com item A
  - cliente pede substituir por B
  - planner sai do checkout
  - oferta anterior invalidada
  - dados globais (nome, bairro, pagamento) preservados
- [ ] D14: Bugs 5, 11 — `intent_to_close_recorded` action emitida + lease em enrichment_jobs.

**Saída da semana 2:** estado/checkout endurecidos e sem corrupção de troca de produto. Bug 14 continua aguardando amostra real para PR 5.

### Semana 3 (21–27/maio) — Supervisora batch + bugs M

**Wallace:**
- [ ] D15–D21: catálogo piloto completo pelo critério data-driven. Validar cobertura das 5 medidas reais, fitments dos modelos mais citados e zonas de entrega atendidas.
- [ ] D17: definir critérios objetivos de saída do shadow (seção 7 deste doc).

**Dev:**
- [ ] D15–D17: Supervisora batch. Worker noturno que:
  - Lê conversas das últimas 24h
  - Amostra: top 50 com `responder_geral`, top 20 escaladas, todas com Say Validator block, todas fechadas
  - Chama LLM com prompt de auditoria (modelo barato, gpt-4o-mini)
  - Grava em nova tabela `ops.quality_flags`
  - Notifica Wallace via email/Chatwoot nota interna
- [x] D18: Bug 2 — Diferenciar event types de carrinho em session_events (nova migration estendendo CHECK).
- [ ] D19: Bug 9 — Tool execution paralela (Promise.all). Bug 10 — index funcional em tire_size normalizado (migration).
- [x] D20: Bug 12 — Mover magic numbers para env (MIN_CONFIDENCE e limits de contexto; TTL de `request_confirmation` fica pendente).
- [ ] D21: Atualizar docs 09, 11, 14.

**Saída da semana 3:** Supervisora rodando, gerando flags do dia anterior. Code freeze pra Sprint 8.

### Semana 4 (28/maio–03/jun) — Sprint 8 envio controlado

**Dev:**
- [ ] D22–D23: Implementar `ChatwootApiClient.postMessage()` + integração no worker.
- [ ] D24: Variável `ATENDENTE_SEND_ENABLED=false` por default. Override por conversa via tag/label do Chatwoot (ex: `agent-piloto`).
- [ ] D25: Logging dedicado: cada mensagem enviada vira evento `agent_message_sent` em session_events com payload completo.
- [ ] D26: Smoke test em 3 conversas internas (você manda mensagem pro número, agente responde).
- [ ] D27: Liga `agent-piloto` em 5 conversas reais pré-selecionadas (clientes recorrentes que aceitam ser piloto).
- [ ] D28: Wallace acompanha as 5 conversas em tempo real. Auditoria turno a turno.

**Saída da semana 4:** agente respondendo cliente real em 5 conversas piloto. Métricas de Sprint 8 começam a sair.

### Semana 5 (04–10/jun) — Calibração e decisão de expansão

**Wallace:**
- [ ] Audita 50 conversas piloto (5/dia × 10 dias).
- [ ] Calcula taxa de aprovação (target ≥ 90%).
- [ ] Lista top 10 problemas pra calibrar.

**Dev:**
- [ ] D29–D30: ajustes de prompt baseados em conversas reais.
- [ ] D31: decisão GO/NO-GO de expansão.
- [ ] Se GO: liga `ATENDENTE_SEND_ENABLED=true` em todas as conversas. Mantém Supervisora batch noturna.
- [ ] Se NO-GO: lista de retrabalho específico, mantém piloto rodando, retorna em 2 semanas.

---

## 6.5 Cronograma específico dos 17 bugs

Matriz Bug → Severidade → Semana/PR → Esforço. Inclui os 17 bugs cravados nas seções 3 e 4.5 + o pré-requisito operacional Bug 14a.

| Bug | Sev | Semana | Esforço | Onde está cravado |
|---|---|---|---|---|
| **Bug 14a** — Persistir candidato bloqueado para auditoria do Say Validator | pré-req A | PR 1 | meio dia + migration | [generator/service.ts](../src/atendente/generator/service.ts) + `agent.turns` |
| **Bug 14** — Say Validator: bloquear desconto/promoção/marca/oferta custom | **A** | PR 5, depois de PR 1 + 5 dias shadow | 1 dia após auditoria da amostra | [say-validator.ts](../src/atendente/validators/say-validator.ts) |
| **Bug 15** — Action Validator: pre-condição em escalate, update_draft, clear_cart | **A** | 1 (D2) | meio dia | [action-validator.ts:148-154](../src/atendente/validators/action-validator.ts) |
| **Bug 1** — `set_active_item` invalida oferta + slots antigo | **A** | 1 (D3) | meio dia | [apply-action.ts:250-261](../src/atendente/state/apply-action.ts) |
| **Bug 16** — `loadCurrent` popula `derived_signals.stale_slots` | **M** | 1 (D3) | 1 hora | [agent-state.repository.ts:230-236](../src/atendente/state/agent-state.repository.ts) |
| **Bug 8** — Context Builder limit configurável via env | **M** | 1 (D2) | 30 min | [context-builder.ts:73](../src/atendente/planner/context-builder.ts) |
| **Bug 17** [DESCOBERTO POR CODEX] — `hydrateGeneratorAction` espalha `base` em `update_draft` | **M** | 1 (D2) | 1h + teste | [generator/schemas.ts:178-186](../src/atendente/generator/schemas.ts#L178-L186) |
| **Bug 6** [REVISADO POR CODEX] — INVALIDATION_RULES expandido com slots reais | **M** | 1 (D5) | 2h | [invalidation-rules.ts](../src/atendente/state/invalidation-rules.ts) — `posicao_pneu, marca_preferida, marca_recusada, municipio, forma_pagamento` |
| Telemetria de tokens em `agent.turns` | infra | 1 (D4) | meio dia | nova migration + worker |
| **Bug 3** [REVISADO POR CODEX] — `replace_cart_item` (PROSPECTIVO) | **M-prosp.** | Pareado com expansão do Generator | 2h | [agent-actions.ts](../src/shared/zod/agent-actions.ts). **Não fazer agora**, fazer junto com sprint que adicionar add_to_cart ao Generator |
| **Bug 4** — `update_cart_item` deve emitir `'updated'` em cart_events | **M** | 2 | 1h + migration | [agent-state.repository.ts:566](../src/atendente/state/agent-state.repository.ts) |
| Sub-fluxo checkout linear `coletar_dados_pedido` | infra | 2 | 2-3 dias | nova skill interna |
| Normalizador de interrupção de checkout | infra | 2 | 1 dia | [planner/service.ts](../src/atendente/planner/service.ts) |
| Teste unitário "checkout interrompido por troca de produto" | infra | 2 | meio dia | `tests/unit/atendente/` |
| **Bug 5** — `intent_to_close_recorded` action emitida | **B** | 2 | meio dia | [generator/schemas.ts](../src/atendente/generator/schemas.ts) + [apply-action.ts](../src/atendente/state/apply-action.ts) |
| **Bug 11** — Lease em enrichment_jobs | **M** | Feito PR4 | 1h | [ops-phase3.repository.ts](../src/shared/repositories/ops-phase3.repository.ts) |
| Supervisora batch (em vez de Critic) | infra | 3 | 2-3 dias | novo worker |
| **Bug 2** — Event types diferenciados em session_events | **M** | 3 | 2h + migration | [apply-action.ts](../src/atendente/state/apply-action.ts) + 0029 |
| **Bug 9** — Tool execution paralela | **B** | 3 | 1h | [tool-executor.ts:22-31](../src/atendente/executor/tool-executor.ts) |
| **Bug 10** [REVISADO POR CODEX] — Index funcional em `tire_specs` (não `products`) | **M** | 3 | 30 min + migration | `commerce.tire_specs` |
| **Bug 12** — Magic numbers para env | **B** | Parcial PR4 | meio dia | [env.ts](../src/shared/config/env.ts) |
| Atualizar docs 09, 11, 14 com mapping atual | drift | 3 | 30 min cada | [docs/phase3-agent-architecture/](../docs/phase3-agent-architecture/) |
| **Bug 7** — UPSERT em `syncSessionSlots` (DELETE→reinsert) | **B** | 4-5 (pós-piloto) | meio dia | [agent-state.repository.ts:679-700](../src/atendente/state/agent-state.repository.ts) |
| **Bug 13** — `validateFactEvidence` lida com message_updated | **B** | Documentado PR4 | 2h futuro se houver histórico de edição | [evidence.ts:11-22](../src/organizadora/evidence.ts) |

**Resumo por semana:**

| Semana | Bugs A | Bugs M | Bugs B | Esforço dev |
|---|---|---|---|---|
| 1 | 2 (15, 1) + 14a como pré-req do Bug 14 | 4 (8, 16, 17, 6) | 0 | ~3,5 dias + telemetria |
| 2 | 0 | 3 (4, 11) + sub-fluxo + teste | 1 (5) | ~5 dias |
| 3 | 0 | 3 (2, 10) + Supervisora | 2 (9, 12) + docs | ~5 dias |
| 4 (Sprint 8 piloto) | — | — | — | implementação envio + monitoramento |
| 5 (calibração) | — | — | 2 (7, 13) | conforme dado |

**Caminho crítico até Sprint 8:** itens das semanas 1-3 marcados bloqueantes na seção 6 + Supervisora batch + sub-fluxo checkout + teste unitário. Total: **~13-14 dias dev** + tempo do Wallace pra catálogo.

**Bug 3 (replace_cart_item) NÃO entra no caminho crítico.** Ele é prospectivo — só vira atual quando o Generator passar a emitir ações de carrinho. Pareá-lo com a sprint que fizer essa expansão.

**Verificações em prod V1-V5: FECHADAS por Codex em 07/05** (resultados na seção 4.5). Pendência nova: persistir texto candidato bloqueado em `agent.turns` antes de revisar regex de Bug 14 (caiu como Bug 14a no cronograma).

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

## 12. Ordem de Execução das Correções

Plano executável dos 17 bugs cravados em 5 PRs sequenciais + trabalho paralelo do Wallace no catálogo. Cada PR é independente e pode ser revisado/mergeado isoladamente.

### PR 1 — Auditoria de turns bloqueados + Bug 17

**Primeira implementação recomendada.** Sem este PR, não dá pra auditar regex do Say Validator (Bug 14) e idempotência de `update_draft` continua quebrada em prod shadow.

**Status Codex 2026-05-07:** implementação concluída e testada. Migration `0028_generator_blocked_turn_audit.sql` aplicada e verificada no banco alvo antes do push/deploy, porque `recordGeneratorResult` passa a inserir `blocked_say_text`, `blocked_actions` e `blocked_payload` em `agent.turns`.

- **Bug 14a (novo, descoberto na rodada Codex):** persistir o candidato bloqueado do Generator no banco. Hoje `agent.turns.say_text` é null quando `status='blocked'` ([generator/service.ts:340](../src/atendente/generator/service.ts#L340)) — não dá pra revisar falso positivo.
- Criar **migration 0028** adicionando campos auditáveis em `agent.turns` para `blocked_say_text` / `blocked_actions` / `blocked_payload` ou equivalente JSONB.
- Ajustar `recordGeneratorResult` em [generator/service.ts](../src/atendente/generator/service.ts) para salvar o candidato quando `status='blocked'`.
- **Bug 17:** corrigir `hydrateGeneratorAction` em [generator/schemas.ts:178-186](../src/atendente/generator/schemas.ts#L178-L186) — `update_draft` deve carregar `...base` igual aos outros 3 cases.
- Atualizar `updateDraftSchema` em [agent-actions.ts](../src/shared/zod/agent-actions.ts) para exigir metacampos (`action_id, turn_index, emitted_at, emitted_by`) como required, alinhando com `update_slot`, `create_item`, `record_offer`.
- Adicionar testes:
  - Unit test de `hydrateGeneratorAction` cobrindo `update_draft.action_id` não-nulo.
  - Unit test de `recordGeneratorResult` salvando `blocked_say_text` quando bloqueado.
  - Integration test cobrindo o ciclo bloqueio → persistência auditável.
- **Esse é o primeiro lote a implementar.**

### PR 2 — Estado e contexto

Quatro bugs de hardening do estado da Atendente. Independem de PR 1, mas faz sentido vir depois pra evitar conflito de migração.

**Status Codex 2026-05-08:** implementação concluída nos quatro itens. Na validação do PR 2: `npm run typecheck` verde, `npm test` 371/371, integração de persistência da Atendente 7/7. Após o PR 3, a suíte atual subiu para 379/379 e a integração da Atendente para 8/8. Smoke LLM real via Chatwoot fake `pr12-chatwoot-1778211526899` validou Organizadora + Planner + Generator em shadow: 13 mensagens ingeridas, 15 facts salvos, Planner `planner_v1.2.5` com `buscar_e_ofertar`, Generator `generator_v1.3.1` com 5 actions e 0 bloqueios. Sem envio ao cliente.

**Avaliação qualitativa do smoke LLM real (Codex, 2026-05-08):**

| Componente | Nota no smoke | Comportamento observado |
|---|---:|---|
| Organizadora | **9/10** | Extraiu corretamente os principais fatos da conversa longa: `moto_modelo=Biz 125`, `moto_ano=2019`, `posicao_pneu=traseiro`, `medida_pneu=110/90-17`, `marca_pneu_preferida=Pirelli`, `bairro_mencionado=Meier`, `forma_pagamento=pix`. Capturou a correção de contexto ("Bros 160" anterior → "Biz 125 2019" atual). |
| Planner | **9/10** | Escolheu `buscar_e_ofertar` e chamou tools antes de permitir resposta comercial: `buscarCompatibilidade(Biz 125, 2019, rear)`, `calcularFrete(Meier)` e `buscarPoliticaComercial`. Não pediu novamente dados que a Organizadora já tinha extraído. |
| Generator | **8/10** | Usou `generator_v1.3.1`, gerou 5 actions, não foi bloqueado e não enviou mensagem ao cliente. Ficou em shadow/auditoria. A nota não é 9/10 porque este smoke não forçou um bloqueio; ainda falta um cenário proposital de desconto/marca/frete sem lastro para provar `blocked_say_text` preenchido em produção. |

**Nota geral do fluxo no smoke:** **8,7/10**. O fluxo respeitou a correção "Bros 160" → "Biz 125 2019", usou 13 mensagens (acima do antigo limite 10), acionou tools antes de falar comercialmente e preservou o modo shadow sem envio ao cliente.

- **Bug 8 [feito local]** — Tornar limit de mensagens do Context Builder configurável via env (`ATENDENTE_CONTEXT_MESSAGES_LIMIT`, default 20). Substitui o `LIMIT 10` hardcoded em [context-builder.ts:73](../src/atendente/planner/context-builder.ts#L73).
- **Bug 16 [feito local]** — `loadCurrent` popula `derived_signals.stale_slots` lendo `agent.session_slots` onde `stale != 'fresh'` ([agent-state.repository.ts:230-236](../src/atendente/state/agent-state.repository.ts#L230-L236)).
- **Bug 1 [feito local]** — `applySetActiveItem` em [apply-action.ts:250-261](../src/atendente/state/apply-action.ts#L250-L261) invalida oferta ligada ao item antigo + marca slots do item antigo como `stale_strong`. Cenário "Bros 160 → Biz 125" passa a funcionar limpo.
- **Bug 6 [feito local]** — Expandir `INVALIDATION_RULES` em [invalidation-rules.ts](../src/atendente/state/invalidation-rules.ts) com slot_keys que faltam: `posicao_pneu`, `marca_preferida`, `marca_recusada` (item) + `municipio`, `forma_pagamento` (global) + `moto_cilindrada`, `quantidade`, `faixa_preco_max` (item). **Não usar fact_keys** (`moto_marca`, `municipio_mencionado`) — esses são da Organizadora.

### PR 3 — Validator de actions e eventos

Três bugs de pre-condition e semântica de eventos. Migration de evento types vai junto.

**Status Codex 2026-05-08:** implementado e testado deterministicamente. Migration `0029_cart_action_events_hardening.sql` aplicada/verificada no Supabase atual antes dos testes. Validação: `npm run typecheck` verde, `npm test` 379/379, integração `atendente-state-persistence` 8/8 e `npm run build` verde. Smoke LLM real pós-deploy na conversa Chatwoot `452`: Organizadora salvou 12 facts, Planner `planner_v1.2.5` chamou tools comerciais, Generator gerou 2 turns e bloqueou 1 com `stock_claim_without_verificar_estoque`, preservando `blocked_say_text`. O smoke não emitiu `update_draft`; por isso `draft_updated` está comprovado pelos testes unitários/integração, não por LLM.

- **Bug 15 [feito local]** — Adicionar pre-condition em [action-validator.ts:148-154](../src/atendente/validators/action-validator.ts#L148-L154) para os 5 cases que hoje retornam `{ valid: true }` em branco:
  - `escalate`: validar `reason='ready_to_close'` exige cart confirmado.
  - `update_draft`: validar consistência (ex.: `fulfillment_mode='delivery'` exige `delivery_address`).
  - `clear_cart`: bloquear se há `pending_confirmation` aberta de cart.
  - `remove_from_cart`, `update_cart_item`: validar `cart_item_id` existe.
- **Bug 2 [feito local]** — Diferenciar event types de carrinho em `agent.session_events`. Hoje toda mudança vira `cart_proposed`. Criar **migration 0029** estendendo CHECK constraint com `cart_added`, `cart_removed`, `cart_updated`, `cart_cleared`, `draft_updated`. Atualizar emissão em [apply-action.ts](../src/atendente/state/apply-action.ts).
- **Bug 4 [feito local]** — Corrigir mapeamento em [agent-state.repository.ts:566](../src/atendente/state/agent-state.repository.ts#L566) — `update_cart_item` (que só muda quantity) deve emitir `'updated'` em `cart_events`, não `'replaced'`. `replaced` fica reservado para troca real de produto (que entra com Bug 3 quando o action set do Generator for expandido).

### PR 4 — Organizadora e ops

Três bugs de hardening operacional. Não bloqueiam Sprint 8, mas são limpeza importante antes de operação contínua.

- **Bug 11 [feito PR4]** — Lease/reclaim de jobs zumbis em `ops.enrichment_jobs`. A query de pickup em [ops-phase3.repository.ts](../src/shared/repositories/ops-phase3.repository.ts) agora recupera `running` vencido:
  ```sql
  OR (status = 'running' AND locked_at < now() - interval '15 minutes')
  ```
- **Bug 12 [parcialmente feito PR4]** — Movidos para env: `ORGANIZADORA_MIN_CONFIDENCE`, `ORGANIZADORA_STALE_JOB_AFTER_SECONDS`, `ATENDENTE_CONTEXT_TOOL_EVENTS_LIMIT`, `ATENDENTE_CONTEXT_ORGANIZER_FACTS_LIMIT`. Pendente: TTL default de `request_confirmation`.
- **Bug 13 [documentado PR4]** — `validateFactEvidence` em [evidence.ts:11-22](../src/organizadora/evidence.ts#L11-L22): aceitar gap atual como limitação conhecida. Sem histórico versionado de mensagens editadas, não há evidence antiga confiável para replay perfeito.

### PR 5 — Say Validator comercial

Bug 14 — adicionar bloqueios de afirmação comercial sem lastro: desconto, brinde/promoção, marca não cadastrada, oferta custom.

**Pré-requisitos absolutos antes de mexer:**
1. **PR 1 já mergeado e rodando em shadow por pelo menos 5 dias**, salvando `blocked_say_text` no banco.
2. **Auditar amostra real** dos textos bloqueados para diagnosticar regex agressiva vs validator funcionando — especialmente os 31 `delivery_claim_without_calcular_frete` que apareceram no V1 do Codex.
3. Só **depois** ajustar regex existente (se houver falso positivo) E adicionar novos blocos (desconto/promoção/marca/oferta custom) em [say-validator.ts](../src/atendente/validators/say-validator.ts).

Sem amostra real persistida, mexer no Say Validator é palpite — pode regredir block_ratio.

### Catálogo Wallace — paralelo

Trabalho do Wallace, paralelo a PR 1-5. **Não bloqueia PR 1**, mas bloqueia o piloto Sprint 8.

- **Não usar meta "50 produtos".** Critério é cobertura de demanda real.
- **Cadastrar com base nas 5 medidas reais** que cobrem 82,61% das conversas (dado de 07/05 do Codex):
  - `140/70-17`
  - `90/90-18`
  - `100/80-18`
  - `110/70-17`
  - `110/90-17`
- **Pré-requisito antes de cadastrar:** consolidar aliases em `commerce.vehicle_models` (`aliases TEXT[]`) — sem isso, `buscarCompatibilidade` fragmenta:
  - Titan / Titan 160 / Titan 150
  - Biz / Biz 125
  - Bros / Bros 160
  - CG / CG 160
  - (e demais variantes que aparecerem na top motos)
- Pelo menos **2 marcas por medida**, com `commerce.products` + `commerce.tire_specs` + `commerce.stock_levels` + `commerce.vehicle_fitments` ligando produto a moto.
- Estimativa: 10–15 produtos cobrindo as 5 medidas. Não 50.

---

### Marcações finais

- **Primeira implementação recomendada: PR 1.** Sem ele, Bug 14 (PR 5) não tem como ser auditado e Bug 17 continua acumulando dívida em prod shadow.
- **Bug 3 não entra agora;** só junto com expansão futura do action set do Generator (quando emitir `add_to_cart`/`remove_from_cart`). Marcado como prospectivo na seção 3 e 6.5.
- **Bug 14 depende do Bug 14a** (PR 1). Bug 14a persiste texto bloqueado; Bug 14 audita e ajusta regex. Sem PR 1 rodando, não faz sentido abrir PR 5.
- **Catálogo é paralelo, não bloqueia PR 1.** Wallace pode cadastrar enquanto PRs 1-5 são implementados/revisados.

---

**Auditoria assinada com referência de linha + cruzamento com banco vivo via Codex.** Tudo nas tabelas de pontos fortes e bugs foi lido. Itens fora de escopo estão marcados explicitamente. Itens refutados estão documentados em prol de transparência. **V1-V5 fechadas em 07/05.** Pendência operacional remanescente: persistir texto candidato bloqueado (Bug 14a) antes de revisar regex de Bug 14. Catálogo Sprint 8: cobrir 5 medidas que somam 82,61% (140/70-17, 90/90-18, 100/80-18, 110/70-17, 110/90-17), com aliases consolidados em `commerce.vehicle_models` (Titan/Biz/Bros/CG e variantes).
