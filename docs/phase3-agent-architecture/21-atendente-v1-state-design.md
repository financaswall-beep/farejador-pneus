# 21 — Atendente v1: State Design (Sprint 1)

> **Nota 2026-05-03:** este documento continua sendo a referencia historica
> do Sprint 1 de estado. Sprints 2-5 ja foram implementados; o estado vivo fica
> em `00-estado-de-implementacao.md`.

> **Status:** Aprovado por Opus + Codex em 2026-04-29.
> **Sprint:** 1 de N da implementação da Atendente.
> **Escopo:** Fundação determinística do estado reentrante. Sem LLM, sem envio Chatwoot, sem Generator, sem Critic.
> **Filosofia:** **Estender o schema de `0016_agent_layer.sql`, não substituir.** Manter as 9 tabelas relacionais existentes; adicionar apenas o que falta para reentrância e procedência.

---

## Resumo

Este documento especifica o Sprint 1 da Atendente v1: a **camada de estado reentrante** sobre o schema `agent.*` que já existe em produção desde `0016_agent_layer.sql`.

A versão original deste doc (revisão 1) propunha colapsar o estado num único `state jsonb` em `session_current` e substituir as 8 actions Zod existentes por 15 novas. **Após auditoria de Codex em 2026-04-29, esta abordagem foi rejeitada** — o schema relacional de 0016 está bem desenhado, em produção, e atende à maior parte dos requisitos. O custo de migração não justifica o ganho.

A revisão 2 (este doc) adota **plano aditivo**:
- Mantém as 9 tabelas de 0016 intactas (`session_current`, `session_events`, `turns`, `pending_confirmations`, `cart_current`, `cart_current_items`, `cart_events`, `order_drafts`, `escalations`)
- Adiciona apenas o que falta: `version`, `action_id`, `turn_index` em tabelas existentes; expansão controlada do CHECK de `event_type`; duas tabelas novas (`session_items`, `session_slots`) para conceitos que 0016 não cobre.
- Mantém as 8 actions Zod existentes em `agent-actions.ts`; adiciona ~9 novas para slot-filling reentrante.

**A frase-guia da arquitetura:** *A Atendente pode conversar com naturalidade, mas só pode afirmar o que o sistema consegue provar. Flexível no funil, rígida na verdade.*

---

## 1. Decisões arquiteturais consolidadas

### 1.1 Estrutura do estado

| Decisão | Valor |
|---------|-------|
| Modelo de estado | Slots reentrantes, não state machine linear |
| Fase do funil | **Derivada** dos slots, nunca persistida |
| Slots globais vs item | Globais sobre o cliente; itens sobre moto+pneu em discussão |
| Múltiplos interesses | Tabela nova `agent.session_items` (separada de `cart_current_items`) |
| Slots com procedência | Tabela nova `agent.session_slots` |
| Carrinho | **Mantém `agent.cart_current` + `agent.cart_current_items`** (já existe) |
| Drafts de checkout | **Mantém `agent.order_drafts`** (já existe) |
| Pending confirmations | **Mantém `agent.pending_confirmations`** (já existe) |
| Escalações | **Mantém `agent.escalations`** (já existe) |

### 1.2 Procedência (provenance)

Toda linha em `agent.session_slots` carrega `source` ∈ `{observed, inferred, confirmed, offered_to_client, inferred_from_history, inferred_from_organizadora}`.

| Source | Significado | Pode fechar pedido? |
|--------|-------------|---------------------|
| `observed` | Cliente afirmou explicitamente | Sim, mas exige reconfirmação se `stale != 'fresh'` |
| `inferred` | Sistema deduziu (Organizadora, tool, histórico) | Não — exige promoção |
| `confirmed` | Cliente confirmou ativamente proposta | Sim |
| `offered_to_client` | Atendente propôs, aguarda resposta | Não — é hipótese pendente |
| `inferred_from_history` | Veio de conversa anterior do contato | Não — exige reconfirmação |
| `inferred_from_organizadora` | Fato extraído pela LLM Organizadora | Não para slots críticos |

### 1.3 Invalidação por procedência

Quando um slot muda, slots derivados são invalidados conforme a `source` do valor antigo:

| Mudança | Slots `inferred` afetados | Slots `observed` afetados | Slots `confirmed` afetados |
|---------|---------------------------|---------------------------|----------------------------|
| `item.moto_modelo` | **Deleta** medida_pneu, cilindrada | Marca **stale** | Marca **stale_strong** |
| `item.moto_ano` | Deleta medida_pneu (se veio de compatibilidade) | — | — |
| `global.bairro` | Recalcula `last_offer.frete` | Recalcula | Recalcula |
| `item.medida_pneu` | Invalida `last_offer.products` | Invalida | Invalida |

### 1.4 Mutação de estado

- **Planner é read-only.** Nunca muta estado.
- **Mutação só por:** `Generator → action[] → ActionValidator → ActionHandler → applyAction(state, action) → DB`
- Toda action gera evento append-only em `agent.session_events` E atualiza tabelas relevantes em mesma transação.

### 1.5 Persistência

**Híbrido relacional + event sourcing (mantém o padrão de 0016):**
- `agent.session_current` é o snapshot fino (status, current_skill, last_*, version, turn_index)
- `agent.session_events` é o ledger append-only auditável
- `agent.session_items` e `agent.session_slots` carregam o estado reentrante novo
- `agent.cart_current`, `agent.order_drafts`, `agent.pending_confirmations`, `agent.escalations` continuam fazendo seu papel

`ConversationState` (em TypeScript) é uma **view montada** pelo repositório a partir dessas tabelas, não um campo jsonb persistido.

### 1.6 Estado inicial (seed)

**Seed permitido (com `source=inferred_from_history`, `confidence` reduzida, `requires_confirmation=true` para slots críticos):**
- `global.nome`
- `global.bairro`
- `global.municipio`
- `global.forma_pagamento`

**NUNCA seed (nasce vazio):**
- Qualquer slot de `item` (moto, medida, posição, quantidade, marca)
- Objeções
- `derived_signals.intencao`, `derived_signals.urgencia`

**Regra:** dados globais ajudam conversa; dados de item antigo induzem erro comercial.

### 1.7 Sincronização com `analytics.conversation_facts`

**Sem sync automático.** Camadas separadas:
- Organizadora → `analytics.conversation_facts` (background, async)
- Atendente → `agent.session_slots` (síncrono ao turno)
- Context Builder lê facts e **propõe** updates ao Planner via campos auxiliares
- Planner pode emitir action `update_slot` com `source=inferred_from_organizadora`
- Slots críticos vindos da Organizadora chegam com `requires_confirmation=true`

**Slots críticos** (lista fechada): `moto_modelo`, `moto_ano`, `medida_pneu`, `posicao_pneu`, `quantidade`, `bairro` (quando usado para frete), `forma_pagamento` (quando usado para fechamento).

### 1.8 Concorrência

- Lock pessimista em `agent.session_current` via `SELECT ... FOR UPDATE`
- Otimistic versioning: campo `version` em `session_current`, action falha se conflito
- Coalescência por `conversation_id` em `ops.atendente_jobs`
- **Regra dura:** nunca enviar resposta baseada em contexto que não contém a última mensagem do cliente. Turno em curso vira `superseded_by_new_user_message` se chegar mensagem nova.

### 1.9 Idempotência

- Toda action carrega `action_id: uuid` (UNIQUE em `session_events`)
- ActionHandler verifica antes de aplicar; já aplicada = skip silencioso
- Idempotência semântica adicional para alguns tipos:

| Action | Chave de idempotência semântica |
|--------|--------------------------------|
| `add_to_cart` (existente) | `(cart_id, product_id, source_turn_id)` |
| `request_confirmation` (existente) | só 1 aberta por sessão+tipo |
| `record_offer` (nova) | `offer_id` único |
| `update_slot` (nova) | `action_id` basta (no-op se valor igual) |
| `add_objection` (nova) | `(conversation_id, objection_type, source_message_id)` |

### 1.10 Princípios de design (recapitulação)

1. **Sem `extras: Record<string, SlotValue>` aberto.** Observações fora da whitelist viram evento `unsupported_observation` em `session_events` com flag `requires_human_review`. Promoção a slot só via ADR.
2. **`urgencia` e `intencao`** são `derived_signals`, recalculados a cada turno. Nunca persistidos.
3. **`pediu_humano` e `objecoes_levantadas`** são eventos append-only em `session_events` (`event_type='human_requested'` e `objection_raised`). Não são slots.
4. **Slot guarda só `value` + `previous_value`.** Histórico completo reconstruído de `session_events`.
5. **`fechar_pedido` nunca toca `commerce.orders` no v1.** Action final v1 é `request_confirmation` (existente) ou `escalate` com `reason='ready_to_close'` (existente).

---

## 2. Plano aditivo de schema (Migration 0024)

> **Numeração confirmada:** `0023_analytics_marts_v1.sql` já existe. Próximo número livre: **0024**.

Arquivo: `db/migrations/0024_atendente_v1_state_extensions.sql`

```sql
-- ============================================================
-- 0024 — Extensões aditivas em agent.* para Atendente v1.
-- Adiciona: versão otimista, idempotência, items, slots com procedência.
-- Mantém: todas as tabelas de 0016 intactas.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- A. session_current: versão otimista + bookkeeping
-- ------------------------------------------------------------
ALTER TABLE agent.session_current
  ADD COLUMN IF NOT EXISTS version bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS turn_index int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS contact_id uuid REFERENCES core.contacts(id);

COMMENT ON COLUMN agent.session_current.version IS
  'Otimistic lock. Cada applyAction incrementa. ActionHandler rejeita se version mudou entre leitura e write.';

-- ------------------------------------------------------------
-- B. session_events: idempotência + casamento de versão
-- ------------------------------------------------------------
ALTER TABLE agent.session_events
  ADD COLUMN IF NOT EXISTS action_id uuid,
  ADD COLUMN IF NOT EXISTS turn_index int,
  ADD COLUMN IF NOT EXISTS resulting_state_version bigint,
  ADD COLUMN IF NOT EXISTS emitted_by text;

-- action_id deve ser único quando presente (eventos legados podem ter NULL)
CREATE UNIQUE INDEX IF NOT EXISTS session_events_action_id_unique
  ON agent.session_events (action_id) WHERE action_id IS NOT NULL;

ALTER TABLE agent.session_events
  ADD CONSTRAINT session_events_emitted_by_check
  CHECK (emitted_by IS NULL OR emitted_by IN ('generator','system','human_override'));

-- ------------------------------------------------------------
-- C. Expandir event_type (mantém CHECK fechado, só amplia)
-- ------------------------------------------------------------
ALTER TABLE agent.session_events
  DROP CONSTRAINT IF EXISTS session_events_event_type_check;

ALTER TABLE agent.session_events
  ADD CONSTRAINT session_events_event_type_check CHECK (event_type IN (
    -- antigos (0016)
    'skill_selected','confirmation_requested','cart_proposed','human_called',
    'bot_resumed','session_paused','session_closed','fact_corrected','escalation_created',
    -- novos da Atendente reentrante (Sprint 1)
    'slot_set','slot_marked_stale',
    'item_created','active_item_changed','item_status_changed',
    'offer_made','offer_invalidated',
    'objection_raised','human_requested',
    'unsupported_observation','intent_to_close_recorded',
    -- PR3 hardening: eventos semanticos de carrinho/draft
    'cart_added','cart_removed','cart_updated','cart_cleared','draft_updated'
  ));

-- ------------------------------------------------------------
-- D. session_items: interesses em discussão (motos/pneus antes do carrinho)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent.session_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment     env_t NOT NULL,
  conversation_id uuid NOT NULL REFERENCES core.conversations(id) ON DELETE CASCADE,
  status          text NOT NULL DEFAULT 'aberto'
                    CHECK (status IN ('aberto','ofertado','no_carrinho','descartado')),
  is_active       boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE agent.session_items IS
  'Interesses em discussão (uma moto + pneu buscado). Diferente de cart_current_items: ainda não está no carrinho.
   Quando vira oferta aceita, gera entrada em cart_current_items.';

CREATE UNIQUE INDEX IF NOT EXISTS session_items_one_active_per_conv
  ON agent.session_items (conversation_id) WHERE is_active;

CREATE INDEX IF NOT EXISTS session_items_conv_idx
  ON agent.session_items (conversation_id, status);

-- ------------------------------------------------------------
-- E. session_slots: slots com procedência
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent.session_slots (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment            env_t NOT NULL,
  conversation_id        uuid NOT NULL REFERENCES core.conversations(id) ON DELETE CASCADE,
  scope                  text NOT NULL CHECK (scope IN ('global','item')),
  item_id                uuid REFERENCES agent.session_items(id) ON DELETE CASCADE,
  slot_key               text NOT NULL,
  value_json             jsonb NOT NULL,
  source                 text NOT NULL CHECK (source IN (
                           'observed','inferred','confirmed','offered_to_client',
                           'inferred_from_history','inferred_from_organizadora'
                         )),
  confidence             numeric(3,2) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  stale                  text NOT NULL DEFAULT 'fresh'
                           CHECK (stale IN ('fresh','stale','stale_strong')),
  requires_confirmation  boolean NOT NULL DEFAULT false,
  evidence_text          text,
  set_by_message_id      uuid,
  set_by_skill           text,
  previous_value_json    jsonb,
  set_at                 timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (scope = 'global' AND item_id IS NULL) OR
    (scope = 'item'   AND item_id IS NOT NULL)
  )
);

COMMENT ON TABLE agent.session_slots IS
  'Slots da Atendente com procedência. Um row = um slot ativo. Histórico fica em session_events (slot_set).';

-- 1 slot ativo por (conversa, scope, item, key)
CREATE UNIQUE INDEX IF NOT EXISTS session_slots_unique_per_key
  ON agent.session_slots (
    conversation_id,
    scope,
    COALESCE(item_id, '00000000-0000-0000-0000-000000000000'::uuid),
    slot_key
  );

CREATE INDEX IF NOT EXISTS session_slots_stale_idx
  ON agent.session_slots (stale) WHERE stale != 'fresh';

CREATE INDEX IF NOT EXISTS session_slots_conv_scope_idx
  ON agent.session_slots (conversation_id, scope);

-- ------------------------------------------------------------
-- F. env_match guards (consistente com 0021)
-- ------------------------------------------------------------
-- session_items
CREATE OR REPLACE FUNCTION agent.session_items_env_match()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE conv_env env_t;
BEGIN
  SELECT environment INTO conv_env FROM core.conversations WHERE id = NEW.conversation_id;
  IF conv_env IS NULL THEN
    RAISE EXCEPTION 'conversation_id % not found', NEW.conversation_id;
  END IF;
  IF conv_env <> NEW.environment THEN
    RAISE EXCEPTION 'env mismatch in session_items: % vs conversations.%', NEW.environment, conv_env;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_session_items_env_match ON agent.session_items;
CREATE TRIGGER trg_session_items_env_match
  BEFORE INSERT OR UPDATE ON agent.session_items
  FOR EACH ROW EXECUTE FUNCTION agent.session_items_env_match();

-- session_slots
CREATE OR REPLACE FUNCTION agent.session_slots_env_match()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE conv_env env_t;
BEGIN
  SELECT environment INTO conv_env FROM core.conversations WHERE id = NEW.conversation_id;
  IF conv_env IS NULL THEN
    RAISE EXCEPTION 'conversation_id % not found', NEW.conversation_id;
  END IF;
  IF conv_env <> NEW.environment THEN
    RAISE EXCEPTION 'env mismatch in session_slots: % vs conversations.%', NEW.environment, conv_env;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_session_slots_env_match ON agent.session_slots;
CREATE TRIGGER trg_session_slots_env_match
  BEFORE INSERT OR UPDATE ON agent.session_slots
  FOR EACH ROW EXECUTE FUNCTION agent.session_slots_env_match();

-- ------------------------------------------------------------
-- G. Imutabilidade reforçada de session_events
-- ------------------------------------------------------------
-- 0016 não tem trigger de imutabilidade explícito. Adicionar agora.
CREATE OR REPLACE FUNCTION agent.session_events_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'agent.session_events is append-only';
END;
$$;

DROP TRIGGER IF EXISTS trg_session_events_no_update ON agent.session_events;
CREATE TRIGGER trg_session_events_no_update
  BEFORE UPDATE OR DELETE ON agent.session_events
  FOR EACH ROW EXECUTE FUNCTION agent.session_events_immutable();

COMMIT;
```

**Resumo:** ALTER em 2 tabelas existentes, CREATE em 2 tabelas novas, expansão de 1 CHECK, 3 triggers. Zero DROP, zero RENAME, zero quebra de código existente.

---

## 3. Schema Zod

Arquivo: `src/shared/zod/agent-state.ts` (novo, **complementa** `agent-actions.ts` que continua existindo)

```typescript
import { z } from 'zod';

// ------------------------------------------------------------------
// SlotValue<T> — espelha agent.session_slots row
// ------------------------------------------------------------------

export const SlotSourceEnum = z.enum([
  'observed',
  'inferred',
  'confirmed',
  'offered_to_client',
  'inferred_from_history',
  'inferred_from_organizadora',
]);

export const StaleFlagEnum = z.enum(['fresh', 'stale', 'stale_strong']);

export const SlotScopeEnum = z.enum(['global', 'item']);

export const SlotValueSchema = <T extends z.ZodTypeAny>(valueSchema: T) =>
  z.object({
    scope: SlotScopeEnum,
    item_id: z.string().uuid().nullable(),
    slot_key: z.string(),
    value: valueSchema,
    source: SlotSourceEnum,
    confidence: z.number().min(0).max(1),
    stale: StaleFlagEnum,
    requires_confirmation: z.boolean(),
    evidence_text: z.string().nullable(),
    set_by_message_id: z.string().uuid().nullable(),
    set_by_skill: z.string().nullable(),
    previous_value: valueSchema.nullable().optional(),
    set_at: z.string().datetime(),
  });

// ------------------------------------------------------------------
// Whitelist de slots conhecidos (slot_key permitido)
// ------------------------------------------------------------------

export const GLOBAL_SLOT_KEYS = [
  'nome',
  'bairro',
  'municipio',
  'forma_pagamento',
] as const;

export const ITEM_SLOT_KEYS = [
  'moto_modelo',
  'moto_ano',
  'moto_cilindrada',
  'medida_pneu',
  'posicao_pneu',
  'quantidade',
  'marca_preferida',
  'marca_recusada',
  'faixa_preco_max',
] as const;

// pediu_humano e objecoes_levantadas NÃO são slots — são eventos.
// urgencia e intencao NÃO são slots — são derived_signals.

export const CRITICAL_SLOTS = [
  'moto_modelo',
  'moto_ano',
  'medida_pneu',
  'posicao_pneu',
  'quantidade',
  'bairro',          // crítico só quando usado para frete
  'forma_pagamento', // crítico só quando usado para fechamento
] as const;

// ------------------------------------------------------------------
// SessionItem — espelha agent.session_items row
// ------------------------------------------------------------------

export const ItemStatusEnum = z.enum(['aberto', 'ofertado', 'no_carrinho', 'descartado']);

export const SessionItemSchema = z.object({
  id: z.string().uuid(),
  status: ItemStatusEnum,
  is_active: z.boolean(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

// ------------------------------------------------------------------
// ConversationState — view montada pelo repositório
// ------------------------------------------------------------------

export const ConversationStateSchema = z.object({
  schema_version: z.literal('atendente_v1.0'),
  conversation_id: z.string().uuid(),
  contact_id: z.string().uuid(),
  environment: z.enum(['prod', 'test']),

  // De agent.session_current
  status: z.enum(['active', 'paused', 'escalated', 'closed']),
  current_skill: z.string().nullable(),
  last_customer_message_id: z.string().uuid().nullable(),
  last_agent_turn_id: z.string().uuid().nullable(),
  turn_index: z.number().int().min(0),
  version: z.number().int().min(0),

  // De agent.session_slots (filtrado por scope=global)
  global_slots: z.record(SlotValueSchema(z.unknown())),

  // De agent.session_items + slots agregados
  items: z.array(z.object({
    id: z.string().uuid(),
    status: ItemStatusEnum,
    is_active: z.boolean(),
    slots: z.record(SlotValueSchema(z.unknown())),
  })),
  active_item_id: z.string().uuid().nullable(),

  // De agent.cart_current + cart_current_items
  cart_status: z.enum(['empty', 'proposed', 'confirmed', 'validated', 'promoted']),
  cart_lines: z.array(z.object({
    id: z.string().uuid(),
    product_id: z.string().uuid(),
    quantity: z.number().int().positive(),
    unit_price: z.number().nullable(),
    item_status: z.enum(['proposed', 'confirmed', 'removed']),
  })),

  // De agent.pending_confirmations (status=open)
  pending_confirmations: z.array(z.object({
    id: z.string().uuid(),
    confirmation_type: z.enum(['fact_confirmation', 'cart_confirmation', 'order_confirmation', 'fitment_confirmation']),
    expected_facts: z.record(z.unknown()),
    expires_at: z.string().datetime(),
  })),

  // De agent.order_drafts
  order_draft: z.object({
    customer_name: z.string().nullable(),
    delivery_address: z.string().nullable(),
    fulfillment_mode: z.enum(['delivery', 'pickup']).nullable(),
    payment_method: z.string().nullable(),
    draft_status: z.enum(['collecting', 'ready', 'promoted', 'abandoned']),
  }).nullable(),

  // Derivados (calculados pelo Context Builder, não persistidos)
  derived_signals: z.object({
    intencao: z.enum(['pesquisando', 'comprando', 'comparando']).nullable(),
    urgencia: z.enum(['baixa', 'media', 'alta']).nullable(),
    has_pending_human_request: z.boolean(),
    recent_objections: z.array(z.string()),
    missing_for_close: z.array(z.string()),
    minutes_since_last_user_message: z.number().int(),
  }),
});

export type ConversationState = z.infer<typeof ConversationStateSchema>;
```

### 3.1 Actions: extensão das 8 existentes

Arquivo: `src/shared/zod/agent-actions.ts` (existente — **estender**, não substituir)

**Mantém as 8 actions atuais:**
- `add_to_cart`, `remove_from_cart`, `update_cart_item`, `clear_cart`
- `update_draft`
- `request_confirmation`
- `escalate`
- `select_skill`

**Adiciona 9 actions novas (Sprint 1):**

```typescript
// Slots
export const updateSlotSchema = z.object({
  type: z.literal('update_slot'),
  action_id: z.string().uuid(),
  scope: z.enum(['global', 'item']),
  item_id: z.string().uuid().nullable(),
  slot_key: z.string(),
  value: z.unknown(),
  source: SlotSourceEnum,
  confidence: z.number().min(0).max(1),
  evidence_text: z.string().nullable(),
  set_by_message_id: z.string().uuid().nullable(),
});

export const markSlotStaleSchema = z.object({
  type: z.literal('mark_slot_stale'),
  action_id: z.string().uuid(),
  scope: z.enum(['global', 'item']),
  item_id: z.string().uuid().nullable(),
  slot_key: z.string(),
  stale_level: z.enum(['stale', 'stale_strong']),
  reason: z.string(),
});

// Items (interesses)
export const createItemSchema = z.object({
  type: z.literal('create_item'),
  action_id: z.string().uuid(),
  item_id: z.string().uuid(),
});

export const setActiveItemSchema = z.object({
  type: z.literal('set_active_item'),
  action_id: z.string().uuid(),
  item_id: z.string().uuid(),
});

export const updateItemStatusSchema = z.object({
  type: z.literal('update_item_status'),
  action_id: z.string().uuid(),
  item_id: z.string().uuid(),
  status: ItemStatusEnum,
});

// Ofertas
export const recordOfferSchema = z.object({
  type: z.literal('record_offer'),
  action_id: z.string().uuid(),
  offer_id: z.string().uuid(),
  item_id: z.string().uuid(),
  products: z.array(z.object({
    sku: z.string(),
    preco: z.number().positive(),
    estoque_no_momento: z.number().int().min(0),
  })),
  expires_at: z.string().datetime(),
});

export const invalidateOfferSchema = z.object({
  type: z.literal('invalidate_offer'),
  action_id: z.string().uuid(),
  reason: z.string(),
});

// Eventos comportamentais
export const addObjectionSchema = z.object({
  type: z.literal('add_objection'),
  action_id: z.string().uuid(),
  objection_type: z.string(),
  source_message_id: z.string().uuid(),
});

export const unsupportedObservationSchema = z.object({
  type: z.literal('unsupported_observation'),
  action_id: z.string().uuid(),
  raw_text: z.string(),
  proposed_fact_key: z.string().nullable(),
  proposed_fact_value: z.unknown(),
  requires_human_review: z.literal(true),
});
```

**`pediu_humano`** mapeia para `escalate` existente (com `reason='customer_requested'`). Não precisa action nova.

**Total Sprint 1: 8 antigas + 9 novas = 17 actions.**

`agentActionSchema` discriminated union ganha 9 entradas. Código existente que usa as 8 antigas continua funcionando.

---

## 4. Regras de invalidação

Arquivo: `src/atendente/state/invalidation-rules.ts`

```typescript
type InvalidationRule = {
  trigger_slot: string;
  affects: {
    delete_if_inferred: string[];
    mark_stale_if_observed: string[];
    mark_stale_strong_if_confirmed: string[];
    invalidate_offer: boolean;
    recalculate: ('frete')[];
  };
};

export const INVALIDATION_RULES: InvalidationRule[] = [
  {
    trigger_slot: 'item.moto_modelo',
    affects: {
      delete_if_inferred: ['item.medida_pneu', 'item.moto_cilindrada'],
      mark_stale_if_observed: ['item.medida_pneu', 'item.moto_cilindrada'],
      mark_stale_strong_if_confirmed: ['item.medida_pneu'],
      invalidate_offer: true,
      recalculate: [],
    },
  },
  {
    trigger_slot: 'item.moto_ano',
    affects: {
      delete_if_inferred: ['item.medida_pneu'],
      mark_stale_if_observed: [],
      mark_stale_strong_if_confirmed: [],
      invalidate_offer: false,
      recalculate: [],
    },
  },
  {
    trigger_slot: 'global.bairro',
    affects: {
      delete_if_inferred: [],
      mark_stale_if_observed: [],
      mark_stale_strong_if_confirmed: [],
      invalidate_offer: false,
      recalculate: ['frete'],
    },
  },
  {
    trigger_slot: 'item.medida_pneu',
    affects: {
      delete_if_inferred: [],
      mark_stale_if_observed: [],
      mark_stale_strong_if_confirmed: [],
      invalidate_offer: true,
      recalculate: [],
    },
  },
];
```

---

## 5. `applyAction(state, action)` — função pura

Arquivo: `src/atendente/state/apply-action.ts`

Assinatura:

```typescript
export type ApplyResult = {
  state: ConversationState;
  events_to_emit: SessionEventInsert[];
  slot_writes: SlotWrite[];
  item_writes: ItemWrite[];
  cart_writes: CartWrite[];
  draft_writes: DraftWrite[];
  confirmation_writes: ConfirmationWrite[];
  escalation_writes: EscalationWrite[];
};

export function applyAction(state: ConversationState, action: Action): ApplyResult;
```

**Princípios:**
- Função pura: mesma entrada → mesma saída.
- Não acessa banco. Recebe estado, retorna estado novo + listas de writes que o repositório vai persistir em transação.
- Sequência: validar precondição → mutar campo → aplicar invalidações cascata → retornar.

**Despacho por tipo de action:**
```typescript
switch (action.type) {
  // Antigas (delegam para handlers já existentes ou novos)
  case 'add_to_cart':         return applyAddToCart(state, action);
  case 'remove_from_cart':    return applyRemoveFromCart(state, action);
  case 'update_cart_item':    return applyUpdateCartItem(state, action);
  case 'clear_cart':          return applyClearCart(state, action);
  case 'update_draft':        return applyUpdateDraft(state, action);
  case 'request_confirmation':return applyRequestConfirmation(state, action);
  case 'escalate':            return applyEscalate(state, action);
  case 'select_skill':        return applySelectSkill(state, action);
  // Novas
  case 'update_slot':         return applyUpdateSlot(state, action);
  case 'mark_slot_stale':     return applyMarkSlotStale(state, action);
  case 'create_item':         return applyCreateItem(state, action);
  case 'set_active_item':     return applySetActiveItem(state, action);
  case 'update_item_status':  return applyUpdateItemStatus(state, action);
  case 'record_offer':        return applyRecordOffer(state, action);
  case 'invalidate_offer':    return applyInvalidateOffer(state, action);
  case 'add_objection':       return applyAddObjection(state, action);
  case 'unsupported_observation': return applyUnsupportedObservation(state, action);
}
```

**`applyUpdateSlot` faz cascata de invalidação** baseada em `INVALIDATION_RULES` e `source` do valor antigo. Detalhes na implementação do Sprint 1.

---

## 6. ActionValidator

Arquivo: `src/atendente/validators/action-validator.ts`

Validações por action **adicionais** ao schema Zod (regras de negócio):

| Action | Validações |
|--------|------------|
| `update_slot` | slot_key na whitelist (GLOBAL_SLOT_KEYS ou ITEM_SLOT_KEYS); tipo do value bate com schema da chave; se source=confirmed exige set_by_message_id |
| `create_item` | máx 5 items abertos por conversa |
| `set_active_item` | item_id existe; status ≠ descartado |
| `record_offer` | item.status ∈ {aberto, ofertado}; products vêm de tool result (TODO Sprint 2) |
| `add_to_cart` (existente) | item.status = ofertado; sku está em offer válida |
| `request_confirmation` (existente) | não há outra confirmação aberta do mesmo tipo |
| `escalate` (existente) | aceita; v1 sempre permite escalação |
| **Qualquer ação que toque `commerce.orders`** | **REJEITA**. v1 não fecha pedido. Use `request_confirmation` com `confirmation_type='order_confirmation'` ou `escalate` com `reason='ready_to_close'` |
| `unsupported_observation` | requires_human_review deve ser literal true |

---

## 7. Suíte de testes Vitest (anti-funil linear)

Arquivo: `src/atendente/state/__tests__/apply-action.test.ts`

### Grupo A — Pulos de etapa
- **T1** Cliente fecha tudo de uma vez → 1 turno preenche slots todos, derived `missing_for_close=[]`, skill = `pedir_confirmacao`. Nunca passa por `confirmar_necessidade`.
- **T2** Cliente pula identificação → skill = `buscar_e_ofertar` mesmo sem `moto_modelo` (cliente pediu SKU explícito).

### Grupo B — Mudanças de rumo
- **T3** Troca de moto após oferta → invalidate_offer disparado; medida do item Bros marcada conforme procedência.
- **T4** Correção (cliente errou) → mesmo item, `moto_modelo` atualizada, `previous_value_json` preservado, medida marcada `stale`.
- **T5** Volta atrás (Bros → CG → Bros) → estado convergente, history reconstruível de `session_events`.

### Grupo C — Off-topic com retomada
- **T6** Pergunta off-topic durante oferta → estado da oferta intocado.
- **T7** Frete no meio da negociação → bairro salvo como global; recalcula só `frete`.

### Grupo D — Abandono e retomada
- **T8** Cliente some 2h → derived `offer_expired=true`.
- **T9** Cliente desiste e volta arrependido → `item.status` permanece `ofertado` (sumiço não muda status).

### Grupo E — Procedência e confiança
- **T10a** Invalidação respeita source: medida `observed` + moto muda → medida.stale='stale', value preservada.
- **T10b** Invalidação inferred: medida `inferred` + moto muda → medida deletada.
- **T11** Fechamento exige confirmed: medida `observed` + cliente diz "fechado" → ActionValidator rejeita; sugere reconfirmação.

### Grupo F — Arquitetura
- **T12** Planner output é read-only: zod ignora qualquer campo de mutação. Estado X intacto.
- **T13** Skill reentrante: `tratar_objecao` chamada nos turnos 2, 4, 6 — cada chamada funciona independente.

### Grupo G — Operacional
- **T14** Idempotência: aplicar mesma action 2x converge ao mesmo estado (no-op na segunda).
- **T15** Versão otimista: aplicar action com `version` antiga falha com erro de conflito.
- **T16** Seed inicial: contato conhecido → state nasce com `nome`, `bairro`, `municipio`, `forma_pagamento` (se existem) com `requires_confirmation=true`. Items vazios.

---

## 8. Fora do escopo do Sprint 1

- Planner LLM
- Generator LLM
- Critic LLM
- Tools determinísticas
- Context Builder completo (apenas o que `applyAction` precisa)
- SayValidator
- Envio ao Chatwoot
- `commerce.orders` write
- Embeddings / RAG
- Fine-tuning
- Canary deployment
- Active learning queue

---

## 9. Critério de saída do Sprint 1

- [ ] Migration `0024_atendente_v1_state_extensions.sql` aplicada em test
- [ ] `src/shared/zod/agent-state.ts` criado (ConversationState, SlotValue, helpers)
- [ ] `src/shared/zod/agent-actions.ts` estendido com 9 actions novas (sem remover antigas)
- [ ] `applyAction` cobrindo as 17 actions (8 antigas + 9 novas)
- [ ] `INVALIDATION_RULES` implementado
- [ ] ActionValidator com whitelist v1 (proíbe escrita em commerce)
- [ ] Repositório `agent-state.repository.ts`: `loadCurrent`, `applyActionAndPersist` (transação + version check + INSERT em session_events + writes em session_slots/session_items/cart_current/order_drafts/pending_confirmations/escalations conforme action)
- [ ] 16 testes Vitest passando
- [ ] `npm test` verde sem flaky
- [ ] `npm run typecheck` verde
- [ ] Documentação revisada por Wallace, Codex e Opus

**Não passa do Sprint 1 sem todos esses items checados.**

---

## 10. Próximos sprints (referência, não escopo aqui)

| Sprint | Foco |
|--------|------|
| 2 | Tools determinísticas + testes (5 tools obrigatórias) |
| 3 | Planner LLM constrained + skills reentrantes |
| 4 | Tool Executor + guardrails |
| 5 | Atendente Shadow log-only sem enviar Chatwoot |
| 6 | Generator shadow + validadores |
| 7 | Golden set + Critic seletivo + metricas |
| 8+ | Envio controlado para casos simples |

---

## 11. Histórico de revisões

| Rev | Data | Mudança | Autor |
|-----|------|---------|-------|
| 1 | 2026-04-29 | Versão inicial: state jsonb monolítico, migration 0023, 15 actions substitutivas | Opus |
| 2 | 2026-04-29 | **Plano aditivo:** mantém 0016 intacto, migration 0024 só ALTER+CREATE, 8+9 actions, ConversationState como view montada | Opus + Codex |

---

*Documento aprovado por Opus + Codex em 2026-04-29 como base do Sprint 1 da Atendente v1, alinhado com o schema relacional já em produção em `0016_agent_layer.sql`.*
