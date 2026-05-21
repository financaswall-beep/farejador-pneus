# Farejador-Painel — Plano

> Documento de planejamento do painel operacional da loja.
> Versão 2 — reescrito em 2026-05-18 após alinhamento Claude × Codex × Wallace.
> Estrutura em duas fases: o que vai ser feito **agora** (Fase 1) e o que fica **guardado** (Fase 2).

---

## 0. Resumo executivo

**Problema:** Atendente está em shadow puro (0 mensagens entregues). Vendas reais fechadas pelo humano no Chatwoot não são registradas em lugar nenhum. Além disso, Wallace está credenciando uma rede de borracharias/parceiros e precisa de visão central de estoque, vendas e operação local de cada parceiro.

**Solução agora (Fase 1):** Painel interno pequeno dentro do próprio Farejador, em 14 dias, com áreas vivas para operação, pedidos, Bot/Shadow e uma primeira visão central da rede. Resolve o registro de venda, a observação da Atendente durante o shadow e começa a organizar a rede de parceiros.

**Solução depois (Fase 2):** Criar portal simples do parceiro/borracheiro para cadastro de estoque local, venda local e relatórios próprios. O painel central continua sendo do Wallace, com acesso consolidado ao que cada parceiro registra. Se ficar claro que o painel cresce, reavaliar Next.js, Supabase Auth, RLS e permissões por parceiro.

**Decisão executiva:** Construir primeiro o painel central do dono da rede. Portal do parceiro vem depois, menor e com permissão restrita.

### Status em 2026-05-18

| Etapa | Status |
|---|---|
| Plano aprovado | ✅ |
| Mockup visual completo (light mode, Estimade-style) | ✅ |
| Estrutura `painel/` criada | ✅ |
| Notificações + top bar global | ✅ |
| 5 telas vivas no mockup + placeholders | ✅ |
| **Decisões pendentes da seção 12** | Parcial — domínio/ERP ficam para depois |
| Migration `0032_order_manual_capture.sql` | Aplicada no banco real |
| Migration `0033_painel_views_and_audit.sql` | Aplicada no banco real |
| Endpoints Fastify | Implementados |
| Telas ligadas no banco real | Parcial — Resumo, Operação, Pedidos e Shadow já fazem fetch |
| Uso real em shadow | ⏳ Dias 10-14 |

### Decisão nova em 2026-05-19: rede credenciada

O painel não é só um apoio do bot. Ele passa a ser o painel central da rede de borracharias:

- Wallace vê todas as conversas, pedidos, parceiros, estoques locais e vendas da rede.
- Cada borracheiro/parceiro terá futuramente uma interface local simples para cadastrar pneus, registrar vendas e acompanhar relatórios básicos.
- O parceiro não deve usar o painel admin do Wallace. O desenho futuro separa:
  - `/admin/painel` — central do dono da rede;
  - `/parceiro` — operação local do borracheiro.
- Multi-unidade completo, RLS granular e financeiro complexo continuam fora do Dia 1, mas `partner_id/unit_id` deixa de ser detalhe opcional e vira base do produto.

---

# FASE 1 — MVP 14 dias (DECIDIDO)

## 1. Contexto

### 1.1 Estado do sistema

- **Atendente:** 1.486 turns gerados, **0 entregues** ao cliente. Shadow puro.
- **Organizadora:** 3.152 facts extraídos, confiança média 0.96, 8 marts diários populados.
- **Drafts de pedido:** 42 montados pelo bot, nenhum promovido a pedido real.
- **Vendas reais:** Humanos fecham no Chatwoot, **nada é registrado no banco.**
- **Janela:** 2 semanas restantes de shadow antes de decidir go-live do bot.

### 1.2 O que o painel resolve nos próximos 14 dias

| Problema | Resolução Fase 1 |
|---|---|
| Vendas reais não registradas | Botão "Registrar venda" → `commerce.orders` |
| Operador não vê o que o bot está achando | Tela Operação ao vivo com slots e draft |
| Shadow não tem comparação visual | Tela Shadow com pares humano × bot |
| Métricas ficam no `dashboard.html` estático | Tela Resumo com KPIs dentro do painel |
| Rede credenciada ainda sem visão central | Tela Rede com apanhado geral, gráfico consolidado, comparativo entre unidades e parceiros clicáveis; clique abre relatório da unidade em tela cheia com cadastro, vendas, compras de pneus, funcionários, despesas extras, lançamentos, saúde da unidade, resultado estimado, estoque local completo e alertas |

## 2. Decisões arquiteturais (Fase 1)

### 2.1 Onde mora o painel

**Dentro do próprio Farejador**, no mesmo processo Fastify. Sem repo novo, sem container novo, sem deploy novo.

```
Farejador agente/
├── src/
│   ├── bot/              ← Atendente (existente)
│   ├── pipeline/         ← ETL (existente)
│   ├── workers/          ← Organizadora (existente)
│   └── admin/painel/     ← NOVO
│       ├── routes.ts     ← endpoints HTTP
│       ├── api.ts        ← endpoints JSON
│       ├── public/
│       │   ├── index.html
│       │   ├── app.js
│       │   └── style.css
│       └── queries.ts    ← consultas SQL
├── db/migrations/
│   ├── 0032_order_manual_capture.sql   ← NOVO
│   └── 0033_painel_views_and_audit.sql ← NOVO
```

**Razão:** menor custo de infra, mesmo `.env`, mesmo deploy. Se crescer, separa depois (Fase 2).

### 2.2 Stack

| Camada | Escolha |
|---|---|
| Servidor | Fastify (já em uso) |
| UI | HTML + CSS + JS vanilla — sem React, sem templating |
| Auth | `ADMIN_AUTH_TOKEN` + `X-Operator-Label` por request |
| Banco | Mesmo Supabase, schemas próprios pro painel |
| Gráficos | Chart.js via CDN (igual ao `dashboard.html` atual) |

### 2.3 Regra de ouro — quem escreve onde

```
Bot escreve em:
  raw.*  ·  core.*  ·  analytics.*  ·  agent.*  ·  ops.*

Painel LÊ de:
  core.*  ·  analytics.*  ·  agent.*  ·  ops.*  ·  commerce.*  ·  analytics_marts.*

Painel ESCREVE apenas em:
  commerce.orders (via function)
  commerce.order_items (via function)
  agent.order_drafts.promoted_order_id (via function)
  audit.events (via function)
  ops.human_bot_reviews (via endpoint)
```

**Painel NÃO TOCA:** `raw.*`, `core.messages`, `agent.turns`, facts da Organizadora, nada que seja fonte de verdade do bot ou do Chatwoot.

### 2.4 Writes só por function SQL

Nada de 5 UPDATEs soltos do frontend. Todo write passa por uma function que garante atomicidade e idempotência.

```sql
commerce.register_manual_order(
  p_conversation_id     UUID,
  p_draft_id            UUID,
  p_unit_id             UUID,
  p_items               JSONB,
  p_payment_method      TEXT,
  p_fulfillment_mode    TEXT,
  p_delivery_address    TEXT,
  p_actor_label         TEXT,
  p_idempotency_key     TEXT
) RETURNS UUID  -- order_id
```

Dentro da function:
1. `SELECT ... FROM agent.order_drafts WHERE id = $draft_id FOR UPDATE`
2. Se `promoted_order_id IS NOT NULL` → ERROR "já registrado por X"
3. `INSERT commerce.orders` (com `idempotency_key UNIQUE`)
4. `INSERT commerce.order_items` (loop)
5. `UPDATE agent.order_drafts SET promoted_order_id = ... WHERE promoted_order_id IS NULL`
6. `INSERT audit.events` (event_type = 'manual_order_created')
7. Tudo em uma única transação. Se algo falha, rollback total.

### 2.5 Auth simples

Login do painel pede dois campos:

```
Nome do operador:  [Wallace]
Senha admin:       [*****]  ← ADMIN_AUTH_TOKEN
```

Nome fica em `localStorage`. Cada request manda `X-Operator-Label: Wallace`. Não é segurança forte — é auditabilidade suficiente pra 14 dias.

## 3. Mudanças no banco (Fase 1)

### 3.1 Migration `0032_order_manual_capture.sql`

```sql
-- 1. Idempotency key em orders
ALTER TABLE commerce.orders
  ADD COLUMN idempotency_key TEXT UNIQUE,
  ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual', 'bot_promoted', 'erp_import')),
  ADD COLUMN actor_label TEXT,
  ADD COLUMN unit_id UUID;  -- só commerce.orders ganha unit_id agora

-- 2. Tabela de unidades (mínima)
CREATE TABLE IF NOT EXISTS core.units (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        TEXT UNIQUE NOT NULL,
  name        TEXT NOT NULL,
  is_active   BOOLEAN DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT now()
);
INSERT INTO core.units (slug, name) VALUES ('main', 'Loja Principal');

-- 3. Audit genérico
CREATE SCHEMA IF NOT EXISTS audit;
CREATE TABLE audit.events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment     TEXT NOT NULL,
  domain          TEXT NOT NULL,         -- orders, stock, product, shadow
  entity_table    TEXT NOT NULL,
  entity_id       UUID,
  event_type      TEXT NOT NULL,
  actor_label     TEXT,
  idempotency_key TEXT,
  payload_before  JSONB,
  payload_after   JSONB,
  created_at      TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_audit_events_entity ON audit.events(entity_table, entity_id);
CREATE INDEX idx_audit_events_created ON audit.events(created_at DESC);

-- 4. Função de registro de venda manual
CREATE OR REPLACE FUNCTION commerce.register_manual_order(
  p_conversation_id  UUID,
  p_draft_id         UUID,
  p_unit_id          UUID,
  p_items            JSONB,
  p_payment_method   TEXT,
  p_fulfillment_mode TEXT,
  p_delivery_address TEXT,
  p_actor_label      TEXT,
  p_idempotency_key  TEXT
) RETURNS UUID AS $$
DECLARE
  v_order_id UUID;
  v_existing UUID;
  v_total    NUMERIC := 0;
  v_item     JSONB;
BEGIN
  -- Idempotência
  SELECT id INTO v_existing FROM commerce.orders WHERE idempotency_key = p_idempotency_key;
  IF v_existing IS NOT NULL THEN
    RETURN v_existing;
  END IF;

  -- Lock no draft
  PERFORM 1 FROM agent.order_drafts WHERE id = p_draft_id FOR UPDATE;

  IF (SELECT promoted_order_id FROM agent.order_drafts WHERE id = p_draft_id) IS NOT NULL THEN
    RAISE EXCEPTION 'Pedido já registrado para este draft';
  END IF;

  -- Calcula total
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_total := v_total + (v_item->>'qty')::INTEGER * (v_item->>'price')::NUMERIC;
  END LOOP;

  -- Insere pedido
  INSERT INTO commerce.orders (
    conversation_id, unit_id, payment_method, fulfillment_mode,
    delivery_address, total_amount, status, source,
    actor_label, idempotency_key
  ) VALUES (
    p_conversation_id, p_unit_id, p_payment_method, p_fulfillment_mode,
    p_delivery_address, v_total, 'confirmed', 'manual',
    p_actor_label, p_idempotency_key
  ) RETURNING id INTO v_order_id;

  -- Insere itens
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    INSERT INTO commerce.order_items (
      order_id, sku, product_name, quantity, unit_price
    ) VALUES (
      v_order_id,
      v_item->>'sku',
      v_item->>'name',
      (v_item->>'qty')::INTEGER,
      (v_item->>'price')::NUMERIC
    );
  END LOOP;

  -- Vincula draft → order
  UPDATE agent.order_drafts
  SET promoted_order_id = v_order_id,
      promoted_by = p_actor_label,
      promoted_at = now()
  WHERE id = p_draft_id;

  -- Audit
  INSERT INTO audit.events (
    environment, domain, entity_table, entity_id, event_type,
    actor_label, idempotency_key, payload_after
  ) VALUES (
    current_setting('app.environment', true),
    'orders', 'commerce.orders', v_order_id, 'manual_order_created',
    p_actor_label, p_idempotency_key,
    jsonb_build_object('total', v_total, 'items', p_items)
  );

  RETURN v_order_id;
END;
$$ LANGUAGE plpgsql;

-- 5. Função de cancelamento
CREATE OR REPLACE FUNCTION commerce.cancel_manual_order(
  p_order_id     UUID,
  p_actor_label  TEXT,
  p_reason       TEXT
) RETURNS VOID AS $$
BEGIN
  PERFORM 1 FROM commerce.orders WHERE id = p_order_id FOR UPDATE;

  IF (SELECT status FROM commerce.orders WHERE id = p_order_id) = 'cancelled' THEN
    RAISE EXCEPTION 'Pedido já cancelado';
  END IF;

  UPDATE commerce.orders SET status = 'cancelled' WHERE id = p_order_id;

  INSERT INTO audit.events (
    environment, domain, entity_table, entity_id, event_type,
    actor_label, payload_after
  ) VALUES (
    current_setting('app.environment', true),
    'orders', 'commerce.orders', p_order_id, 'manual_order_cancelled',
    p_actor_label, jsonb_build_object('reason', p_reason)
  );
END;
$$ LANGUAGE plpgsql;
```

### 3.2 Migration `0033_painel_views_and_audit.sql`

```sql
-- Schema dashboard com views read-only pro painel
CREATE SCHEMA IF NOT EXISTS dashboard;

-- Resumo do dia (8 widgets)
CREATE VIEW dashboard.resumo_hoje AS
SELECT
  (SELECT COUNT(*) FROM core.conversations
     WHERE started_at::date = CURRENT_DATE) AS conversas_hoje,
  (SELECT COUNT(*) FROM commerce.orders
     WHERE created_at::date = CURRENT_DATE AND status != 'cancelled') AS vendas_hoje,
  (SELECT COALESCE(SUM(total_amount),0) FROM commerce.orders
     WHERE created_at::date = CURRENT_DATE AND status != 'cancelled') AS faturamento_hoje,
  (SELECT COUNT(*) FROM agent.order_drafts
     WHERE draft_status = 'ready' AND promoted_order_id IS NULL) AS drafts_pendentes,
  (SELECT COUNT(*) FROM agent.escalations
     WHERE created_at::date = CURRENT_DATE) AS escalacoes_abertas,
  (SELECT COUNT(*) FROM ops.agent_incidents
     WHERE resolved_at IS NULL) AS incidentes_abertos,
  (SELECT COUNT(*) FROM agent.turns
     WHERE created_at::date = CURRENT_DATE) AS shadow_total_turns,
  (SELECT COUNT(*) FROM agent.turns
     WHERE created_at::date = CURRENT_DATE AND status = 'blocked') AS shadow_blocked;

-- Conversas ativas com slots e draft
CREATE VIEW dashboard.operacao_ativa AS
SELECT
  c.id AS conversation_id,
  c.chatwoot_conversation_id,
  c.channel_type,
  c.current_status,
  c.last_activity_at,
  ct.name AS customer_name,
  ct.phone_e164,
  (SELECT jsonb_object_agg(slot_key, value_json)
     FROM agent.session_slots ss
     WHERE ss.conversation_id = c.id) AS slots,
  od.id AS draft_id,
  od.draft_status,
  od.payment_method AS draft_payment,
  od.fulfillment_mode AS draft_fulfillment
FROM core.conversations c
LEFT JOIN core.contacts ct ON ct.id = c.contact_id
LEFT JOIN agent.order_drafts od
  ON od.conversation_id = c.id AND od.promoted_order_id IS NULL
WHERE c.current_status NOT IN ('resolved', 'closed')
ORDER BY c.last_activity_at DESC;

-- Pares humano × bot para tela Shadow
CREATE VIEW dashboard.shadow_pairs AS
SELECT
  t.id AS turn_id,
  t.conversation_id,
  m_customer.content AS customer_message,
  m_human.content AS human_reply,
  t.say_text AS bot_would_have_said,
  t.status AS bot_status,
  t.blocked_say_text,
  t.selected_skill,
  t.created_at
FROM agent.turns t
LEFT JOIN core.messages m_customer ON m_customer.id = t.trigger_message_id
LEFT JOIN LATERAL (
  SELECT content FROM core.messages
  WHERE conversation_id = t.conversation_id
    AND created_at > t.created_at
    AND sender_type = 'agent'
  ORDER BY created_at ASC LIMIT 1
) m_human ON true
ORDER BY t.created_at DESC;

-- Revisões humano-bot
CREATE TABLE ops.human_bot_reviews (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  turn_id         UUID NOT NULL REFERENCES agent.turns(id),
  verdict         TEXT NOT NULL CHECK (verdict IN
    ('human_better', 'bot_better', 'equivalent', 'bot_unsure', 'skip')),
  notes           TEXT,
  reviewer_label  TEXT NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_hbr_turn ON ops.human_bot_reviews(turn_id);
CREATE INDEX idx_hbr_verdict ON ops.human_bot_reviews(verdict);
```

## 4. Telas

### 4.1 Menu (sempre visível na lateral)

```
Farejador Painel
─────────────────
🏠 Resumo          ← VIVO
💬 Operação        ← VIVO
🛒 Pedidos         ← VIVO
🤖 Bot / Shadow    ← VIVO
─────────────────
💰 Financeiro      ← placeholder
📦 Estoque         ← placeholder simples
🚚 Logística       ← placeholder
👥 Colaboradores   ← placeholder
🛍️ Catálogo        ← placeholder
🏪 Compras         ← placeholder
📊 Relatórios      ← placeholder
🏬 Unidades        ← placeholder
⚙️  Configurações   ← placeholder
```

Os placeholders mostram "Em construção — previsto para Fase 2" + link pra esta documentação.

### 4.2 Tela: Resumo (`/admin/painel`)

**8 widgets em grid + 2 painéis abaixo:**

```
┌──────────────────────────────────────────────────────────────┐
│ Conversas hoje  | Vendas hoje  | Faturamento  | Drafts pend. │
│      47         |     12       |   R$ 4.320   |      3       │
├──────────────────────────────────────────────────────────────┤
│ Pedidos confirm.| Escalações   | Incidentes   | Shadow turns │
│      12         |     2        |     1        |   147 / 23 bl│
├──────────────────────────────────────────────────────────────┤
│  Top medidas da semana          | Últimas 10 atividades       │
│  ▓▓▓▓▓▓ 100/80-18  23           | 14:32 venda R$ 180 Wallace │
│  ▓▓▓▓░░ 90/90-18   18           | 14:15 draft pronto João S. │
│  ▓▓▓░░░ 140/70-17  14           | ...                        │
└──────────────────────────────────────────────────────────────┘
```

Fonte: `dashboard.resumo_hoje` + queries auxiliares.

### 4.3 Tela: Operação (`/admin/painel/operacao`)

Lista de conversas ativas (de `dashboard.operacao_ativa`). Cada card:

- Cliente + canal + tempo desde última atividade
- Slots extraídos (moto, medida, posição, pagamento, etc.)
- Se tem draft `ready`: botão **"Registrar venda"** → abre modal
- Botão **"Ver conversa"** → link pro Chatwoot

Modal "Registrar venda":
- Form pré-preenchido pelo draft
- Editar itens, qtd, preço
- Forma de pagamento, modalidade de entrega, endereço
- Botão **Confirmar** → POST `/admin/api/orders/register-manual` com `Idempotency-Key` gerada no frontend

### 4.4 Tela: Pedidos (`/admin/painel/pedidos`)

Lista de `commerce.orders` com filtro de data/status. Clique abre detalhe.

Detalhe do pedido:
- Cliente, itens, total, forma de pagamento
- Status: confirmed / cancelled
- Audit trail (de `audit.events`)
- Botão **Cancelar pedido** (chama `commerce.cancel_manual_order`)
- **Sem edição livre.** Se errou, cancela e cria novo.

### 4.5 Tela: Bot / Shadow (`/admin/painel/shadow`)

**Resumo agregado (cabeçalho):**
```
Mensagens cliente: 412   |  Com bot shadow: 412
Com resposta humana: 287 |  Pareados: 287
Bot bloqueado: 68 (16%)  |  Sem reply humana: 125
```

**Fila de revisão (cards):**
```
Cliente disse:   "quero 90/90-18 pra Fan"
Humano disse:    "Temos Levorin R$ 180 ou Pirelli R$ 240"
Bot teria dito:  "Temos! 90/90-18 Levorin R$ 180 com Pix..."

Skill: buscar_e_ofertar  ·  Validador: ✅  ·  Confiança: 0.98

[Humano melhor] [Bot melhor] [Equivalente] [Bot inseguro] [Pular]
```

Cliques gravam em `ops.human_bot_reviews`. Grava também o `reviewer_label` do header `X-Operator-Label`.

## 5. Cronograma 14 dias

| Dia | Entrega |
|---|---|
| **1** | Migration 0032 + 0033, view `dashboard.resumo_hoje` testada |
| **2** | Endpoints Fastify protegidos por `ADMIN_AUTH_TOKEN` + login simples |
| **3** | Tela Resumo (HTML/CSS + JS chamando `/admin/api/dashboard/resumo`) |
| **4** | Tela Bot/Shadow (lista, agregados, botões de verdict) |
| **5** | Tela Operação (lista de conversas ativas) |
| **6** | Modal "Registrar venda" + integração com `register_manual_order` |
| **7** | Tela Pedidos (lista + detalhe + cancelar) |
| **8** | Placeholders das outras 9 telas do menu |
| **9** | Polish de UX, mensagens de erro, validações Zod no backend |
| **10-14** | **Uso real.** Wallace + atendente operam. Corrige bugs no ato. |

## 6. Critérios de "pronto"

Fase 1 está pronta quando:

- [ ] Wallace + 1 atendente conseguem logar com `ADMIN_AUTH_TOKEN` + nome
- [ ] Tela Resumo mostra os 8 KPIs corretos comparado com SQL direto
- [ ] Tela Operação lista conversas ativas em tempo real (refresh a cada 10s)
- [ ] Modal "Registrar venda" pré-preenche corretamente do draft
- [ ] Confirmar venda grava em `commerce.orders` com `idempotency_key` e `audit.events`
- [ ] Cancelar venda muda status e grava audit
- [ ] Dois cliques rápidos no Confirmar não criam pedido duplicado
- [ ] Dois operadores simultâneos no mesmo draft: um vence, outro vê erro claro
- [ ] Tela Shadow mostra ao menos 50 pares para revisar
- [ ] Botões de verdict gravam em `ops.human_bot_reviews`
- [ ] `core.messages`, `agent.turns`, `raw.*` continuam intocados pelo painel
- [ ] Após 14 dias, `commerce.orders` tem **≥30 pedidos reais** registrados

## 7. O que Fase 1 NÃO faz

Lista explícita para evitar escopo creep:

- ❌ Baixa automática de estoque (estoque hoje não é confiável)
- ❌ Multi-tenant em outras tabelas (só `commerce.orders` ganha `unit_id`)
- ❌ Supabase Auth / Row Level Security
- ❌ Realtime via `postgres_changes` (polling a cada 10s é suficiente)
- ❌ CRUD de produtos, preços, estoque
- ❌ Financeiro, RH, Logística, Compras, CRM, Marketing
- ❌ App separado em Next.js
- ❌ Triggers de audit automático em outras tabelas
- ❌ Edição livre de pedido (só cancelar + refazer)
- ❌ Permissões granulares (todo operador com token vê tudo)
- ❌ Múltiplos usuários com login próprio (Wallace + nome livre basta)
- ❌ Emissão de NF-e

---

# FASE 2 — Visão futura (NÃO PRIORIZADA)

> Esta fase **não está aprovada**. Depende do que aprendermos nas 2 semanas de Fase 1.
> Aqui guardamos o desenho pra não esquecer quando chegar a hora.

## 8. Quando reavaliar Fase 2

Reavaliar **após o fim do shadow**, com perguntas como:

- Quantos pedidos foram registrados? (proxy: o painel virou parte do dia-a-dia?)
- Quantos operadores diferentes usaram?
- A separação "Bot escreve / Painel escreve" se manteve sem fricção?
- A janela 14 dias bateu ou estourou em 30?
- Já apareceu necessidade real de 2ª loja?
- Já apareceu necessidade real de módulo financeiro/logística?

Se a resposta a 3 ou mais das perguntas for "sim", Fase 2 vira projeto. Senão, mantém o painel pequeno e evolui pontualmente.

## 9. O que entra em Fase 2

### 9.1 Migração arquitetural

- **Repo separado** `farejador-painel` em Next.js 14 (App Router) + TypeScript
- **Supabase Auth** (e-mail/senha) substituindo `ADMIN_AUTH_TOKEN`
- **RLS habilitado** em todas as tabelas que o painel toca
- **Roles**: `role_dono`, `role_gerente_unidade`, `role_atendente`, `role_entregador`, `role_contador`
- **Realtime via `postgres_changes`** substituindo polling
- **Deploy próprio em Coolify** + DNS Hostinguer apontando

A camada de banco/API que a Fase 1 criou (`dashboard.*` views, `commerce.register_manual_order`, `audit.events`, `ops.human_bot_reviews`) é **reaproveitada inteira**. Só a UI HTML/CSS/JS é descartada.

### 9.2 Multi-tenant real

`unit_id` em mais tabelas: `core.conversations`, `core.contacts`, `commerce.products`, `commerce.stock_levels`, etc.

Tabela `hr.user_units` faz o vínculo de funcionário com unidade. Policies de RLS filtram por unidade automaticamente.

### 9.3 Novos schemas

| Schema | Propósito |
|---|---|
| `finance.*` | A receber, a pagar, caixa, conciliação |
| `hr.*` | Funcionários, comissões, jornada, permissões |
| `logistics.*` | Entregas, rotas, motoristas, app entregador |
| `suppliers.*` | Fornecedores, compras, custo real, margem |
| `crm.*` | Pipeline, leads, frota, follow-up |
| `marketing.*` | Campanhas, canais, atribuição, ROI |
| `config.*` | Horários, limites, parâmetros do bot |

### 9.4 Audit completo

Manter `audit.events` genérico, mas agora populado por:
- Function calls (já feito na Fase 1)
- Triggers automáticos em tabelas sensíveis (`commerce.products`, `commerce.stock_levels`, `commerce.current_prices`, `hr.users`, `finance.*`)

### 9.5 Telas vivas adicionais

Os 9 placeholders viram telas:

- **Financeiro**: caixa, fluxo, a receber, a pagar
- **Estoque**: ajuste, inventário, snapshot, alerta
- **Logística**: entregas do dia, rotas, app móvel do entregador
- **Colaboradores**: cadastro, permissões, comissão
- **Catálogo**: CRUD de produto, preço, foto
- **Compras**: PO, fornecedor, custo, recebimento
- **Relatórios**: dashboard avançado (drill-down, filtros, export)
- **Unidades**: comparativo entre lojas
- **Configurações**: horários, políticas, parâmetros

### 9.6 NF-e via API externa

Integrar com **NFe.io / Focus NFe / Plugnotas** (custo ~R$ 0,50–2,00 por nota). Painel envia dados → API devolve XML assinado → guarda em `finance.invoices`. Nunca construir emissor próprio.

## 10. Sinais de que NÃO se deve migrar pra Fase 2

Pra honestidade, vale listar:

- Operador só pediu mais 1-2 telas pontuais → faz só essas, mantém Fase 1
- Volume continua baixo (< 50 pedidos/mês) → não justifica Next.js separado
- Apenas Wallace usa o painel → não precisa multi-user nem RLS
- Bot deu go-live e está autônomo → painel vira ferramenta de auditoria, não operação

---

## 11. Apêndice — Decisões registradas

| Data | Decisão | Quem decidiu |
|---|---|---|
| 2026-05-18 | Painel dentro do Farejador, não repo separado | Wallace + Codex |
| 2026-05-18 | ADMIN_AUTH_TOKEN + X-Operator-Label, sem Supabase Auth agora | Wallace + Codex |
| 2026-05-18 | `unit_id` só em `commerce.orders`, não em outras tabelas | Wallace + Claude + Codex |
| 2026-05-18 | `audit.events` genérico (domain, entity_table, event_type) | Codex |
| 2026-05-18 | Idempotency via UUID UNIQUE + FOR UPDATE no draft | Codex |
| 2026-05-18 | Estoque modelado com `is_tracked` + `stock_status` enum (Fase 2) | Codex |
| 2026-05-18 | Cancelar+refazer, sem edição livre de pedido | Codex |
| 2026-05-18 | Mesmo processo Fastify, sem container/repo novo | Codex |
| 2026-05-18 | Menu completo com placeholders, 4 áreas vivas | Wallace |
| 2026-05-18 | Tabela `ops.human_bot_reviews` separada da Supervisora | Codex |
| 2026-05-18 | 5 verdicts: human_better / bot_better / equivalent / bot_unsure / skip | Codex |
| 2026-05-18 | Sem baixa automática de estoque na Fase 1 | Wallace + Codex |
| 2026-05-18 | Janela: 14 dias do shadow, reavaliar Fase 2 ao fim | Wallace |
| 2026-05-18 | UI em light mode (Estimade-style), não dark | Wallace |
| 2026-05-18 | Stack visual: Tailwind + Alpine + Lucide + Chart.js (todos via CDN) | Wallace + Claude |
| 2026-05-18 | Cor brand: laranja `#f97316` | Wallace |
| 2026-05-18 | Tipografia: Inter via Google Fonts | Claude |
| 2026-05-18 | Top bar global sticky com sino de notificações + avatar | Wallace |
| 2026-05-18 | Cards laterais no Resumo: relatório diário, insights, status bot | Claude |
| 2026-05-18 | Estrutura `painel/` em pasta dedicada dentro do projeto | Wallace |
| 2026-05-18 | Filtros de notificação: Todas / Importantes / Bot / Vendas | Claude |

## 12. Decisões pendentes (a serem tomadas)

- [x] **Nome do operador padrão:** Wallace
- [ ] Domínio do painel — definir antes do deploy (sugestão: `painel.dominio.com.br`)
- [x] **Acesso:** Internet com subdomínio (precisa HTTPS + ADMIN_AUTH_TOKEN robusto)
- [x] **Retenção `audit.events`:** Pra sempre (loja pequena, baixo volume — não rotacionar)
- [x] **Revisão Shadow:** Eu (Wallace) + atendentes podem revisar
- [ ] Qual ERP futuro (Bling/Tiny/etc.) — pra dimensionar Fase 2 corretamente

### Decisões 2026-05-19 (Dia 1)

- [x] Aplicar Dia 1: Wallace aprovou começar agora
- [x] Acesso internet → ADMIN_AUTH_TOKEN passa a ser crítico; deploy precisa HTTPS
- [x] Atendentes podem revisar Shadow → mesma role no Dia 1 (sem permissões granulares)
- [x] Audit sem TTL → manter `audit.events` sem job de purge

---

## 13. Execução 2026-05-19

- [x] `0032_order_manual_capture.sql` criado e validado em transação com rollback.
- [x] `0033_painel_views_and_audit.sql` criado e validado em transação com rollback.
- [x] Ordem corrigida: `ops.human_bot_reviews` nasce antes de `dashboard.shadow_pairs`.
- [x] Backend Fastify criado em `src/admin/painel/`.
- [x] Rotas do painel registradas em `src/app/routes.ts`.
- [x] Validações locais verdes: `npm run typecheck`, `npm test`, `npm run build`.
- [x] Aplicar migrations `0032`/`0033` no banco real.
- [x] Trocar mocks principais de `painel/public/app.js` por chamadas reais aos endpoints.
- [x] Adicionar endpoint `GET /admin/api/dashboard/produtos` para o modal de venda escolher `product_id` real.
- [x] Conectar botões de verdict da tela Shadow ao `POST /admin/api/shadow/review`.
- [x] Conectar modal "Registrar venda" ao `POST /admin/api/orders/register-manual` com `idempotency_key`.
- [x] Testar tela Bot/Shadow no navegador com servidor local e `ADMIN_AUTH_TOKEN`.
- [x] Ajustar refresh automático/polling e acabamento visual da tela Bot/Shadow.
- [x] Filtrar a fila Bot/Shadow para esconder pares já revisados (`review_id IS NULL`).
- [x] Expor no payload do dashboard as flags `ATENDENTE_SHADOW_ENABLED` e `GENERATOR_LLM_ENABLED`.
- [x] Mostrar no cabeçalho do Bot/Shadow se o worker está ligado ou desligado.
- [x] Ligar botão `Chatwoot` da tela Operação ao `chatwoot_conversation_id` real.
- [x] Evoluir tela Rede para apanhado geral com gráfico de linhas e relatório individual por parceiro clicável.
- [x] Adicionar DRE operacional simples por unidade: faturamento, compras de pneus, folha, despesas extras e resultado estimado.
- [x] Trocar detalhe lateral por página cheia da unidade, com estoque local detalhado.
- [x] Adicionar cadastro completo do parceiro no detalhe: CNPJ/CPF, responsável, WhatsApp, endereço, status, comissão e modelo comercial.
- [x] Adicionar lançamentos da unidade: compra de pneus, venda, despesa extra, pagamento de funcionário e ajuste de estoque.
- [x] Melhorar estoque local com mínimo, última compra, fornecedor, custo médio, margem por pneu, estoque não controlado e alerta de reposição.
- [x] Adicionar comparativo entre unidades: gráfico de lucro estimado, estoque parado, melhor margem, unidade sem venda hoje e pneus mais vendidos da rede.
- [x] Adicionar score de saúde da unidade: venda hoje, estoque atualizado, pneu zerado, margem positiva, despesas registradas e dias sem atualizar.
- [x] Reorganizar detalhe da unidade em abas para melhorar legibilidade: Visão geral, Estoque e Lançamentos.
- [ ] Testar conversa nova ponta a ponta com `ATENDENTE_SHADOW_ENABLED=true` no ambiente que recebe webhook real.

### Correções 2026-05-19 — preparação para shadow (Claude Opus 4.7)

Diagnóstico: antes de ligar `ATENDENTE_SHADOW_ENABLED=true`, o botão "Registrar venda" só aparecia em conversas com draft do bot. Como no shadow quem fecha venda é o humano (bot só observa), a maioria das conversas ficaria sem botão e o `commerce.orders` nasceria vazio — o oposto do que o MVP deveria entregar.

Decisão: desacoplar **"registrar venda"** de **"promover draft"**. São fluxos diferentes que o código tratou como um só.

- [x] **Fix #1** — `painel/public/index.html`: botão "Registrar venda" agora aparece em **toda conversa ativa**. Quando há draft, vira variante "preta" e usa o pré-preenchimento. Sem draft, vira variante "outline" rotulada "Registrar venda (sem draft)".
- [x] **Fix #2** — botão global **"Nova venda"** no top-bar, sempre visível. Abre modal sem `conversation_id` com campos extras (nome + telefone do cliente). Para vendas balcão, telefone fora do Chatwoot e indicações.
- [x] **Fix #3** — campo **"Origem da venda"** no modal:
  - Em conversas: `chatwoot_com_bot` (pré-selecionado se há draft) / `chatwoot_sem_bot`
  - Em walkin: `walkin_balcao` / `walkin_telefone` / `walkin_outro`
  - Persistido em `commerce.orders.source` (CHECK constraint expandida em `0034_painel_walkin_and_source.sql`).
- [x] Migration `0034_painel_walkin_and_source.sql`:
  - Expande `orders_source_check` para 8 valores (3 legados + 2 chatwoot + 3 walkin).
  - Recria `commerce.register_manual_order(...)` com 12º parâmetro `p_source_tag TEXT DEFAULT NULL`. Quando NULL, deriva automático: tem draft → `chatwoot_com_bot`, sem draft → `chatwoot_sem_bot`. Idempotência + `FOR UPDATE` no draft preservados.
  - Nova tabela `commerce.customers` para cliente operacional fora do Chatwoot. Venda de balcão não cria contato fake em `core.contacts`.
  - `commerce.orders` ganha `customer_id`; `contact_id` deixa de ser obrigatório, com CHECK exigindo `contact_id` ou `customer_id`.
  - Nova function `commerce.find_or_create_customer(env, name, phone)`: reaproveita cliente por `phone_e164` se houver; senão cria cliente em `commerce.customers`.
  - Nova function `commerce.register_walkin_order(env, name, phone, unit, items, payment, fulfillment, address, actor, idem, source_tag)`: idempotente, atômica, cria cliente operacional se necessário, audit em `audit.events` com `event_type='walkin_order_created'`.
- [x] Backend (`src/admin/painel/queries.ts`, `route.ts`):
  - Tipo `RegisterManualOrderInput` ganha `source_tag?: 'chatwoot_com_bot' | 'chatwoot_sem_bot' | null`.
  - Novo tipo `RegisterWalkinOrderInput` + função `registerWalkinOrder(...)`.
  - Novo Zod schema `registerWalkinOrderSchema` validando `source_tag` enum walkin.
  - Novo endpoint `POST /admin/api/orders/register-walkin` (protegido por `ADMIN_AUTH_TOKEN` + `X-Operator-Label`).
- [x] Frontend (`painel/public/app.js`): `openWalkinModal()` novo, `submitManualOrder()` roteia entre os dois endpoints, `saleForm` ganha `source_tag`, `customer_name`, `customer_phone`.
- [x] Validações locais verdes: `node --check painel/public/app.js`, `npx tsc --noEmit`, `npm run build`.
- [ ] Aplicar `0034_painel_walkin_and_source.sql` no banco real antes de ligar o shadow.
- [ ] Testar fluxo walkin no navegador local com `ADMIN_AUTH_TOKEN`.

Por que essas três mudanças mudam o jogo do shadow: o `commerce.orders` deixa de depender do bot ter feito algo certo. Toda venda fechada pelo humano vira linha no banco com a **origem real** (`source`). Daqui a 3 semanas, dá pra comparar honestamente "das vendas Chatwoot, em quantas o bot tinha draft útil?" e usar isso como sinal pro go-live.

**Assinatura desta mudança:** Claude (Opus 4.7), sob orientação direta do Wallace, em 2026-05-19. Decisão arquitetural fechada em conversa: desacoplar "registrar venda" de "promover draft", adicionar caminho walkin sem conversa, expor origem como dado de primeira classe.

### Continuação 2026-05-19 — visual + Rede + portal parceiro + dimensões de pneu (Claude Opus 4.7)

Sessão de continuidade depois dos Fixes #1-#3. Trabalho em camadas: padronização visual, novos gráficos na Rede, reescrita do frontend do parceiro, e migration de dimensões dimensionais de pneu.

**Padronização visual do painel admin:**

- [x] Padrão de botões consolidado e aplicado: Primário = `bg-gray-900 hover:bg-gray-800 text-white px-4 py-2 rounded-lg`. Secundário = `bg-white border border-gray-200 hover:border-gray-300`. Brand laranja reservado pra chips/badges, não pra CTAs. Aplicado em Nova venda (top-bar), Registrar venda (Operação), Confirmar venda (modal).
- [x] Botão "Registrar venda" perdeu o estilo condicional outline/preto. Agora sempre preto, com sufixo discreto "(sem draft)" em opacidade reduzida quando aplicável. Reduz três níveis de atenção visual pra dois.

**Dashboard da Rede — três mini-cards viraram mini-gráficos:**

- [x] **Estoque parado:** texto solto virou bar chart horizontal ranqueando todas as unidades. Líder em laranja brand `#f97316`, demais em cinza `#e5e7eb`. Métrica grande no topo + nome do líder em cinza.
- [x] **Melhor margem:** texto solto virou bar chart horizontal por %. Líder em verde emerald `#10b981`, demais cinza claro. Eixo X sugere max 50%.
- [x] **Venda hoje:** texto solto virou donut verde/rosa "venderam × sem venda". Métrica `X / total` grande no topo, chip rosa/verde indicando o gap.

Layout reorganizado de 1 grande + 3 minis em grid-4 (com 4º item órfão na linha 2) para **2 grandes (Lucro + Compras) numa linha + 3 minis numa linha de baixo**. Sem mais cards órfãos.

**Novo gráfico "Compras de pneus por unidade":**

- [x] Bar chart horizontal `chartRedeComprasChart` consumindo `parceirosRede[].comprasPneus`. Líder em laranja brand, demais em laranja claro. Tooltip formatado em BRL. Permite leitura "lucro × compras lado a lado" — unidade que compra muito e lucra pouco = problema de margem; unidade que compra pouco e lucra muito = está queimando estoque sem repor.

**Filtro temporal global da Rede:**

- [x] Pill bar "Diário / Semanal / Mensal" (estado `redeTimeFilter`) abaixo do título. Estilo segmented control (fundo cinza, opção ativa branca com sombra suave). Chips estáticos "mês"/"7 dias" nos 3 charts grandes (Vendas consolidadas, Lucro, Compras) viraram reativos ao filtro.
- [x] Aviso honesto à direita quando filtro != Mensal: "Agregação X entra quando dados reais forem plugados" — porque mock atual só tem granularidade mensal. Some quando volta pra Mensal.

**"Pneus mais vendidos da rede":**

- [x] Grid de 5 cards "X unidades" virou bar chart horizontal `chartPneusRede`. Eixo X com `stepSize: 1` (integer). Tooltip mostra "X de Y unidades (Z%)" — proporção visual instantânea ao invés de número solto sem referência. Posteriormente redimensionado pra `h-40 max-w-2xl` e paleta trocada pra **verde** (líder `#059669`, demais `#a7f3d0`).

**Portal parceiro — reescrita completa do frontend (backend intocado):**

Análise crítica do trabalho original do Codex registrou: backend (`src/parceiro/auth.ts`, `queries.ts`, `route.ts`) está sólido — token hash + timing-safe compare, idempotência consistente, transação no purchase, audit metadata. O frontend é que era dissonante: CSS vanilla 748 linhas com vocabulário próprio (`.muted`, `.pill`, `.summary-strip`), JS imperativo 832 linhas com DOM manipulation manual, charts canvas reinventando Chart.js, layout sem framework — parecia produto de outro projeto colado no mesmo repo.

- [x] Reescrita do frontend (`parceiro/public/index.html`, `app.js`, `style.css`) com a **mesma stack do painel admin**: Tailwind CSS + Alpine.js + Lucide + Chart.js, todos via CDN. Zero build step.
- [x] Tamanhos finais: `index.html` 278 → 580 linhas; `app.js` 832 → 670 linhas; `style.css` 748 → 19 linhas. Total 1858 → 1269 linhas (−32%).
- [x] Versão dos assets bumpada pra `?v=20260519-portal-08` (invalida cache).
- [x] Backend não foi tocado. `npm run typecheck` confirmou estabilidade.
- [ ] **Pendente (não bloqueia shadow):** integração admin↔parceiro — tela Rede do painel central ainda lê mock; precisa consumir `network.*` e `commerce.partner_*` reais.
- [ ] **Pendente (urgente antes de credenciar 2º parceiro):** RLS no Postgres em `network.partner_*`, `commerce.partner_*`, `finance.partner_expenses`. Hoje filtragem é só app-level via `getPartnerContext`.

**Portal parceiro — máscaras de campo e formatação canônica:**

Operador entrava com dados em formatos variados ("100  90  17", "21999999999", "180.50" sem padrão BRL). Banco recebia inconsistência. Decisão: forçar o formato canônico no momento do input, não tentar normalizar depois.

- [x] **Telefone** (`saleForm.customer_phone`): estado interno guarda só dígitos (max 11); display formata `(21) 99999-9999` reativo ao digitar; submit converte pra E.164 (`+5521999999999`) via `toE164Phone()` antes de enviar. Helper `formatPhoneDisplay()` + `onPhoneInput()`.
- [x] **Moeda BRL** (`saleForm.unit_price`, `stockForm.average_cost/sale_price`, `purchaseForm.unit_cost`, `expenseForm.amount`): estado em Number; display formatado pt-BR com prefixo `R$` overlay absoluto (não ocupa espaço do dígito); usuário digita só dígitos, tratados como centavos (`Math.round(digits) / 100`). Helpers `formatBRLDisplay()` + `onCurrencyInput()`.
- [x] **Medida do pneu** (`stockForm.tire_width`, `tire_aspect`, `tire_rim`): redesenho para **três inputs numéricos pequenos separados** (Largura `w-16` / Perfil `w-16` / Aro `w-14`) com slash `/` e traço `-` fixos visuais entre eles. Preview do formato canônico ao lado do label (`90/90-18` ou `—`). Preenchimento parcial bloqueia o save com mensagem clara. Banco recebe sempre `"WIDTH/ASPECT-RIM"`. Round-trip preserva valores: `editStock()` prefere as colunas dimensionais do banco (depois da 0038) e cai pro parse da string só pra registros legados.
- [x] **Labels acima de cada campo** (`text-[11px] text-gray-500 mb-1 block`) — antes era só placeholder, sumia quando digitava.
- [x] **Larguras dos campos via grid-cols-12:** campos numéricos pequenos (qtd, mínimo, custo, preço) ocupam 2-3 colunas de 12. Antes tudo era `grid-cols-1 md:grid-cols-2` (cada input ocupava metade da tela mesmo pra "quantidade: 1").

**Migration 0038 — dimensões de pneu no estoque do parceiro:**

Auditoria revelou inconsistência: `commerce.tire_specs` (catálogo central) tinha `tire_size TEXT` + `width_mm INTEGER` + `aspect_ratio INTEGER` + `rim_diameter INTEGER` (com índice composto), mas `commerce.partner_stock_levels` (estoque do parceiro) tinha só a string. Impossibilita busca dimensional ("todo pneu aro 17 da rede") sem `LIKE '%-17'` lento + falso positivo (`'117'` casa).

- [x] **`db/migrations/0038_partner_stock_tire_dimensions.sql`** adiciona `tire_width_mm`, `tire_aspect_ratio`, `tire_rim_diameter` em `commerce.partner_stock_levels` + índice composto `(width, aspect, rim) WHERE deleted_at IS NULL`. Backfill regex-based para registros existentes (suporta `90/90-18`, `150/60R17`, `150/60ZR17`). Registros com string fora do padrão ficam com dimensões NULL (intencional — não adivinha).
- [x] **Backend** (`src/parceiro/queries.ts`, `route.ts`): `UpsertPartnerStockInput` ganhou os 3 campos opcionais; Zod `stockSchema` valida `int min 1 max 999` (rim max 30); INSERT/UPDATE persiste as 3 colunas; `getPartnerEstoque` retorna as colunas pro frontend.
- [x] **Frontend** (`parceiro/public/app.js`): `saveStock` envia `tire_width_mm`, `tire_aspect_ratio`, `tire_rim_diameter`; `editStock` prefere essas colunas sobre o parse da string.
- [x] Validações verdes: `node --check parceiro/public/app.js`, `npm run typecheck`.
- [ ] **Pendente:** aplicar `0038` no banco real (não bloqueia frontend — a coluna ainda não existindo, INSERT vai falhar; coordenar a aplicação antes do próximo deploy do parceiro).

**Documentação atualizada:**

- [x] `docs/PAINEL_PLANO.md` (este arquivo) — esta seção.
- [x] `painel/README.md` — tabela de status + padronização de botões + filtro temporal + gráficos novos.
- [x] `parceiro/README.md` (novo arquivo) — stack, máscaras, convenções de formato, backlog (RLS, integração admin↔parceiro).
- [x] Assinaturas nos cabeçalhos de `parceiro/public/app.js`, `style.css`, e `db/migrations/0038_partner_stock_tire_dimensions.sql`.

**Assinatura desta seção:** Claude (Opus 4.7), 2026-05-19. Sessão de continuidade pós-Fixes 1-3. Princípio operativo aplicado em todas as mudanças: forçar formato canônico na entrada (não tentar adivinhar depois), separar gráficos por categoria semântica (laranja brand para destaque, verde para indicadores positivos), manter o backend bom e atacar onde estava porco (o frontend do parceiro).

### Hotfix 2026-05-19 — consistência de estoque do parceiro

Encontrado em teste real do Wallace: cadastrar 10 unidades de 90/90-18, vender 1, e o estoque continuar mostrando 10. Causa: as 4 mutações de venda/compra do parceiro nunca tocavam `partner_stock_levels`.

Bloco resolvido em transação atômica:

- [x] **Sale decrementa**: `registerPartnerSale` agora envolve a inserção em transação e, depois da function `register_walkin_order`, executa o fragmento compartilhado `STOCK_MOVE_SQL` (CTE com `FOR UPDATE`) por cada item, recompondo `stock_status` na própria UPDATE.
- [x] **Sale cancel restaura**: `cancelPartnerSale` busca os `order_items` da venda e devolve a quantidade ao estoque antes de chamar `cancel_manual_order`.
- [x] **Purchase incrementa**: `registerPartnerPurchase` adiciona a quantidade comprada ao `quantity_on_hand` por item com `product_id`.
- [x] **Cancel purchase decrementa**: `deletePartnerPurchase` simétrico ao incremento (se saldo permitir; senão pula silenciosamente — não negativa).
- [x] **`stock_status` sempre coerente**: recomputado dentro da própria UPDATE, não confia em valor antigo.
- [x] **Audit em `audit.events`**: 4 novos `event_type` (`stock_decrement_sale`, `stock_increment_sale_cancel`, `stock_increment_purchase`, `stock_decrement_purchase_cancel`) com payload contendo `order_id`/`purchase_id`, movimentos e items.

Regras de pulamento (não bloqueia a operação principal):
- Item sem `product_id` linkado → estoque não mexe, venda completa mesmo assim.
- Estoque com `is_tracked=false` ou `deleted_at NOT NULL` → ignora.
- Decremento maior que saldo → não negativa, audit registra a tentativa.

Detalhamento em `parceiro/README.md` seção "Consistência de estoque (corrigido em 2026-05-19)".

Pendências da auditoria — **todas fechadas na mesma sessão**:

- [x] **Autocomplete do catálogo no form de Estoque**. Novo endpoint `GET /parceiro/:slug/api/catalogo?q=`, busca por substring em `commerce.product_full` (até 20 resultados). Frontend: input com debounce 250ms, dropdown de matches, chip verde "vinculado" quando linkado, botão "Desvincular". Ao escolher, popula `product_id` + item_name + dimensões + sale_price sugerido. Itens vinculados passam a movimentar estoque automaticamente nas operações.
- [x] **Toggle delivery vs pickup no form de Venda**. Select "Retirar / Entregar" + endereço condicional. Preferência preservada entre vendas. Tag no header do form muda de "balcão" pra "entrega" (azul) conforme o modo.
- [x] **View `commerce.network_stock_unified`** (migration 0039). Schema padronizado consolida matriz + parceiros: `location_type` ('matriz' | 'partner'), `unit_id`, `unit_label`, `product_id`, `item_name`, `tire_size`, dimensões, `quantity_available`, `stock_status` (derivado pra matriz: `<=0 → out_of_stock`, `<5 → low_stock`). Read-only. Items soft-deleted ficam fora. Não tem consumidor ainda (admin painel continua mockado) — é base pra integração da Fase 2.

— Claude Opus 4.7, 2026-05-19. Bloco de hotfixes pós-teste real do Wallace: as 4 mutações de estoque + 3 itens de backlog viraram um lote único de trabalho atômico.

### Decisão arquitetural 2026-05-19 — parceiro vira silo isolado

Em teste real, Wallace identificou que mesmo depois das correções de consistência de estoque, registrar venda não baixava as 10 unidades do pneu. Diagnóstico: o item de `partner_stock_levels` estava sem `product_id` vinculado a `commerce.products` (catálogo da matriz), e o caminho de venda exigia esse vínculo porque `commerce.order_items.product_id` é `NOT NULL`.

Após discussão, ficou clara a contradição arquitetural: **o parceiro era teoricamente autônomo (estoque local em `partner_stock_levels`) mas operacionalmente dependia da matriz (venda obrigava vínculo com `commerce.products`)**. A diretriz de Wallace foi explícita:

> "Matriz vê tudo do parceiro. Parceiro não vê nada da matriz."

Implementação:

- [x] **Migration `0040_partner_orders_local.sql`**:
  - Cria `commerce.partner_orders` (vendas locais do parceiro, espelho de `commerce.orders` adaptado — sem referência a `commerce.products`).
  - Cria `commerce.partner_order_items` referenciando `commerce.partner_stock_levels(id)` diretamente. Snapshot de `item_name`, `tire_size`, `brand` no momento da venda pra preservar histórico se o estoque mudar/sumir.
  - Cria function `commerce.register_partner_local_order(...)` que faz tudo atomicamente: idempotência, lock no estoque (`FOR UPDATE`), decrement de `quantity_on_hand`, recálculo de `stock_status`, INSERT em `partner_orders` + `partner_order_items` (com snapshot), audit em `audit.events` (`event_type='partner_order_created'`).
  - Cria function `commerce.cancel_partner_local_order(...)` que restaura estoque + marca cancelada + audit (`event_type='partner_order_cancelled'`).
  - Cria view `commerce.partner_orders_full` (agrega items em JSONB pro portal listar).
  - Cria view `commerce.network_orders_unified` (UNION das vendas da matriz + dos parceiros, padronizadas) — pra painel admin consumir tudo da rede no futuro.

- [x] **Backend `src/parceiro/`**:
  - `PartnerOrderItemInput.product_id` → `partner_stock_id`.
  - `getPartnerVendas` lê de `commerce.partner_orders_full`, não mais de `dashboard.pedidos_recentes`.
  - `getPartnerProdutos` lista 100% do estoque local sem distinção de vínculo — não há mais ordem por "vendáveis primeiro" nem JOIN com `commerce.products`.
  - `registerPartnerSale` aponta pra `commerce.register_partner_local_order`. Removida toda lógica de decremento separado em TS (já está dentro da function SQL).
  - `cancelPartnerSale` aponta pra `commerce.cancel_partner_local_order`.
  - `searchPartnerCatalogo` **removida**. Endpoint `/parceiro/:slug/api/catalogo` removido.
  - Zod `orderItemSchema` exige `partner_stock_id` (UUID), não mais `product_id`.

- [x] **Frontend `parceiro/public/`**:
  - Removido todo o bloco de autocomplete do form de Estoque (banner verde/laranja "Vinculado / Sem vínculo", input de busca, dropdown, chip de catálogo).
  - Removida toda lógica relacionada do `app.js`: estado `catalogoSearch/Results/Searching/Open/Error`, métodos `onCatalogoSearchInput`, `selectCatalogoItem`, `unlinkCatalogoItem`, `formatCatalogoOption`.
  - Lista de Estoque perdeu chip "sem vínculo / vinculado" e texto explicativo.
  - Dropdown da Venda usa `partner_stock_id` em vez de `product_id`, e todos os itens são selecionáveis (sem `disabled`).
  - `saveSale` envia `partner_stock_id` no item. Toast simples "Venda registrada — estoque baixado automaticamente.".
  - Asset version bumpada pra `?v=20260519-portal-12`.

- [x] **Documentação**: `parceiro/README.md` ganhou seção "Arquitetura: silo isolado" com matriz explícita de quem lê o quê. `docs/PAINEL_PLANO.md` (este arquivo) com a decisão registrada.

**Pendências críticas pra esta refatoração funcionar em prod:**

- [ ] Aplicar `0038_partner_stock_tire_dimensions.sql` (já existia).
- [ ] Aplicar `0039_commerce_network_stock_unified.sql` (já existia).
- [ ] Aplicar `0040_partner_orders_local.sql` (nova). **Sem essa, o portal quebra ao registrar venda** — a function `register_partner_local_order` não existe.
- [ ] As 6 vendas antigas em `commerce.orders` com unit_id de parceiro ficam como histórico. Não migrar. Painel admin no futuro pode mostrar elas via `network_orders_unified`.

**Por que isso muda o jogo:**

Antes, credenciar um parceiro novo exigia o Wallace cadastrar pneus específicos dele no catálogo central. Operacionalmente, **o Wallace virava gargalo**. Cada SKU exótico do borracheiro travava o credenciamento até o admin cadastrar manualmente.

Agora, o borracheiro cadastra qualquer pneu na própria base. Vende qualquer pneu. Sem fricção. O catálogo central da matriz continua existindo pra **bot da Atendente** (que vende pneus da matriz) e pra **relatório consolidado** (via view `network_orders_unified`), mas não dita mais o que cada parceiro pode operacionar.

A consequência mais sutil: relatórios consolidados ficam com SKUs descoordenados ("Pneu Levorin 90/90-18 traseiro" no parceiro A vs "90/90-18 trz Levorin" no parceiro B). Pra agregar precisão, no futuro vale criar uma camada de **normalização canônica** (dimensões `tire_width_mm` + `aspect_ratio` + `rim_diameter` já ajudam). Mas isso fica pra Fase 2 — não bloqueia operação.

— Claude Opus 4.7, 2026-05-19. Decisão de Wallace; implementação em ~3h: migration + backend + frontend + docs. Validações verdes: `node --check parceiro/public/app.js`, `npm run typecheck`.

### Aplicação no banco real + pendências fechadas em 2026-05-19 (mesma sessão)

Após a refatoração arquitetural, Wallace reportou "Internal Server Error" ao cadastrar pneu no portal. Diagnóstico: migrations 0038-0040 nunca tinham saído do arquivo SQL — não estavam aplicadas no banco de produção. Código novo dependia delas e estourava com `column tire_width_mm does not exist`.

Aplicação via MCP Supabase (project `aoqtgwzeyznycuakrdhp`):

- [x] **0038_partner_stock_tire_dimensions** aplicada. 3 colunas dimensionais + índice composto. Backfill regex pra registros legados que tivessem tire_size canônica.
- [x] **0039_commerce_network_stock_unified** aplicada. View consolidada matriz + parceiros.
- [x] **0040_partner_orders_local** aplicada em 4 partes (tabelas → register function → cancel function → views). Vendas locais do parceiro funcionando: `commerce.partner_orders` + `commerce.partner_order_items` + 2 functions + 2 views (`partner_orders_full`, `network_orders_unified`).
- [x] **0041_partner_rls_isolation** aplicada (nova). RLS habilitado em 7 tabelas (`partner_stock_levels`, `partner_orders`, `partner_order_items`, `partner_purchases`, `partner_purchase_items`, `partner_expenses`, `partner_units`). Policies dependem de `network.current_partner_unit()` que lê `current_setting('app.partner_unit_id')`. **Pendência consciente:** o pool atual do Fastify usa service role (BYPASSRLS), então RLS é estrutural mas não enforça hoje. Pra ativar de verdade, backend precisa: (a) setar `SET LOCAL app.partner_unit_id = <unit>` antes de cada query do parceiro via transação, e (b) conectar com role separada sem `BYPASSRLS`. Documentado como dívida no `parceiro/README.md`.
- [x] **Admin painel já consumia `network_orders_unified`**. Função `getPainelRede` existente em `src/admin/painel/queries.ts` (criada em sprint anterior) lê de `network.partner_unit_summary` que internamente consolida os dados. Endpoint `/admin/api/dashboard/rede` já existia e está protegido por `ADMIN_AUTH_TOKEN`. Removida duplicação que eu cheguei a criar acidentalmente.

Validação final no banco real (consulta `information_schema`):
- 3 dimensões em `partner_stock_levels` ✓
- 2 tabelas em `partner_orders*` ✓
- 2 functions `register_partner_local_order`, `cancel_partner_local_order` ✓
- 3 views (`network_stock_unified`, `network_orders_unified`, `partner_orders_full`) ✓
- 7 tabelas com RLS habilitado ✓

`npm run typecheck` ✓. Asset version bumpada pra `?v=20260519-portal-13` pra forçar refresh do navegador.

— Claude Opus 4.7, 2026-05-19. Encerramento da sprint de hotfixes pós-teste real. Próximo passo do Wallace: reiniciar Fastify (pra pegar a refatoração de `queries.ts`), Ctrl+Shift+R no portal parceiro, tentar cadastrar pneu novo (deve funcionar agora) e registrar venda (estoque vai baixar atomicamente via function SQL).

### Hotfixes 2026-05-20 — pente fino de correlações estoque/vendas/compras/despesas

Wallace pediu auditoria sistemática de todos os fluxos do silo do parceiro. Achei 7 problemas em produção, todos confinados às tabelas `commerce.partner_*` + `finance.partner_expenses` (nenhum afeta bot, ETL, webhook, Organizadora).

**Migration aplicada:**

- [x] **`0042_partner_sale_consistency`** (via MCP Supabase) — recria `commerce.register_partner_local_order`:
  - **BUG #2**: levanta `EXCEPTION 'Estoque insuficiente para "X": disponivel N, pedido M'` quando saldo insuficiente em item rastreado. Antes vendia silenciosamente sem decrementar.
  - **BUG #5**: separa audit de movimento de estoque do audit de venda. Agora cada venda gera 2 eventos: `partner_order_created` (com items) + `stock_decrement_sale` (com `{order_id, moves: [{stock_id, item_name, delta, new_qty, new_status}]}`).

**Backend `src/parceiro/queries.ts`:**

- [x] **`registerPartnerPurchase`**:
  - **BUG #1**: guard de idempotência. `SELECT COUNT(*) FROM partner_purchase_items WHERE purchase_id = X` antes do INSERT. Se já tem, retorna o mesmo `purchase_id` sem reprocessar.
  - **BUG #3**: média ponderada de verdade. `weighted = (avg_prev * qty_prev + cost_new * qty_new) / (qty_prev + qty_new)`. Substituiu o "last_cost" anterior.
  - **BUG #4**: match com `lower(trim(brand))` e `lower(trim(supplier_name))`. "michellim" vs "Michellin" passa a casar (mesmo item).
- [x] **`registerPartnerSale`**: try/catch que re-lança erro de regra de negócio com mensagem preservada.
- [x] **`upsertPartnerStock`**: audit `stock_item_created` ou `stock_item_updated` (decide por `input.stock_id`).
- [x] **`deletePartnerStock`**: audit `stock_item_inactivated` com snapshot do nome + last_quantity.
- [x] **`registerPartnerExpense`**: audit `partner_expense_created` em domain `partner_expenses`.
- [x] **`deletePartnerExpense`**: audit `partner_expense_deleted`.

**Backend `src/parceiro/route.ts`:**

- [x] Endpoint `POST /parceiro/:slug/api/vendas` agora retorna **422** (Unprocessable Entity) com mensagem clara quando regra de negócio falha (estoque insuficiente, item inativado, quantity/preço inválidos). Antes virava 500 internal_server_error genérico.

**Frontend `parceiro/public/`:**

- [x] Asset version `?v=20260520-portal-21`. Toast mostra a mensagem clara do 422 (já estava preparado pelo `errMessage`).

**Validações:**
- `node --check parceiro/public/app.js` ✓
- `npm run typecheck` ✓
- Function `register_partner_local_order` confirmada nova no banco (6268 chars vs ~4000 antes).
- 0 estoques negativos nos dados reais. 0 inconsistências de status.

**Documentação:**
- `parceiro/README.md` — tabela com os 7 itens + confirmações positivas.
- `docs/PAINEL_PLANO.md` — esta seção.

**Pendência consciente que sobrou** (GAP #7): vendas legadas em `commerce.orders` com `unit_id` da Borracharia Rio do Ouro (6 linhas) ficaram como histórico. Admin enxerga via `network_orders_unified`. Borracheiro vê só `partner_orders`. Sem migração — sem custo de manter, sem benefício de mexer.

— Claude Opus 4.7, 2026-05-20. Pente fino baseado em SQL direto contra dados reais (não em hipótese). Cada bug foi confirmado com query antes de corrigir.

### 2ª rodada de hardening — FKs, triggers, UNIQUE constraint (2026-05-20)

Wallace pediu segunda rodada cobrindo o que ficou superficial na primeira: foreign keys, triggers automáticos, UNIQUE constraints estratégicas, soft-delete inconsistente. Tudo no silo do parceiro — zero efeito no bot.

**Diagnóstico (via SQL contra `pg_constraint` + `pg_trigger`):**

- ✅ 12 FKs do parceiro listadas e classificadas
- ✅ 15 triggers do parceiro listados
- ❌ `partner_orders` tinha coluna `updated_at` mas **sem trigger** que mantém atualizado
- ❌ 3 FKs sensíveis (`partner_order_items.partner_stock_id`, `partner_purchase_items.product_id`, `partner_stock_levels.product_id`) sem `ON DELETE` definido — qualquer DELETE upstream travaria
- ❌ Sem UNIQUE constraint que previna race em auto-create de estoque
- ❌ `partner_orders` + `partner_order_items` sem env_match trigger (outras tabelas têm)

**Migration aplicada:**

- [x] **`0043_partner_hardening`** (via MCP Supabase):
  - Trigger `partner_orders_set_updated_at` adicionado.
  - FK `partner_order_items.partner_stock_id` → `ON DELETE SET NULL`. Hard-delete do stock preserva venda histórica (snapshot do item_name+tire_size+brand fica na linha).
  - FK `partner_purchase_items.product_id` → `ON DELETE SET NULL`. Matriz deletar produto não trava compras antigas.
  - FK `partner_stock_levels.product_id` → `ON DELETE SET NULL`. Idem.
  - `UNIQUE INDEX partner_stock_natural_key_uniq` em `(environment, unit_id, lower(trim(item_name)), COALESCE(lower(trim(tire_size)),''), COALESCE(lower(trim(brand)),''), COALESCE(lower(trim(supplier_name)),''))) WHERE deleted_at IS NULL`. Previne duplicação de estoque por race em auto-create da compra. Match consistente com a busca em `registerPartnerPurchase`.
  - Triggers `env_match_partner_orders_unit` + `env_match_partner_order_items_order` adicionados pra consistência com outras tabelas.
  - Comentários em `partner_orders.deleted_at` e `partner_orders.status` esclarecendo a convenção: **cancelamento normal usa `status='cancelled'`, soft-delete (`deleted_at`) fica reservado pra LGPD/exclusão definitiva**.

**Validação:**
- 3 FKs com `ON DELETE SET NULL` confirmadas
- Trigger `partner_orders_set_updated_at` ativo
- Índice `partner_stock_natural_key_uniq` criado
- 2 novos triggers `env_match_*` ativos
- `npm run typecheck` ✓ (não precisou mexer em TS)
- `node --check parceiro/public/app.js` ✓

**Dados existentes preservados:**

As 2 entradas duplicadas "Traseiro"/"traseiro" 90/90-18 (com brands "michellin" vs "michellim") **não violam o novo UNIQUE** porque os brands diferem por typo. Borracheiro pode resolver mergeando manualmente quando quiser. Sem migração forçada.

**O que ficou de fora deliberadamente (não bloqueia):**

- **Performance / índices adicionais**: só faz sentido com volume real. Fica pra quando um parceiro tiver 500+ SKUs.
- **RLS enforcement de verdade**: estrutural está em 0041, mas precisa refator de `queries.ts` pra setar `SET LOCAL app.partner_unit_id` + pool com role sem BYPASSRLS. Projeto separado.
- **Unificação `core.contacts` × `customer_name/phone` direto**: decisão de produto, não bug. Bot da Atendente continua sem ver clientes que só compraram com parceiros — comportamento esperado do silo isolado.

— Claude Opus 4.7, 2026-05-20. 2ª rodada fecha cobertura técnica do silo do parceiro. Próxima evolução verdadeira (RLS enforcement, integração visual admin↔parceiro nos dados reais, gestão de duplicatas mergeáveis) fica como projeto separado quando o parceiro estiver rodando de verdade.

### Polish visual leve do portal parceiro — 2026-05-20

Wallace pediu "uns toques pra dar vida sem perder o clean". Decisão: cenário desktop-only, polish leve, sem mexer em estrutura/layout. Tempo total: ~30min.

**Frontend `parceiro/public/index.html` + `app.js`:**

- [x] **Botões primários de salvar viraram verde emerald** (4 botões): "Salvar venda", "Salvar estoque", "Salvar compra e atualizar estoque", "Salvar despesa". Classe `bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 shadow-sm hover:shadow transition-all`. Convenção: verde = "ação positiva que vai dar certo". Login fica preto (entrada formal). Botões neutros (Limpar, Cancelar, Inativar, Sair, Atualizar) continuam outline/ghost. Hierarquia visual preservada.
- [x] **Logo "F" da sidebar virou gradient laranja brand** (`bg-gradient-to-br from-brand-500 to-brand-700`) com sombra suave. Identidade visual ganhou cor sem invadir o resto da UI.
- [x] **Bolinha "Unidade conectada" pulsando** (animação `animate-ping` por baixo, mais bolinha sólida em cima). Microanimação de vida sem barulho.
- [x] **Toast tricolor com heurística automática**:
  - `'success'` (verde emerald) — quando msg contém "registrada/salv/cancelad/atualiz/excluí". Ícone `check-circle-2`.
  - `'error'` (vermelho rose) — quando msg contém "insuficiente/erro/inválido/falha/inativ/preencha/selecione". Ícone `alert-triangle`.
  - `'neutral'` (cinza preto) — resto. Ícone `check-circle-2`.
  - Slide+fade na entrada e saída.
  - `flash(msg, kind)` aceita override explícito; `inferStatusKind(msg)` faz a heurística quando não passado.
- [x] Asset version bumpada pra `?v=20260520-portal-22`.

**Decisões deliberadas que NÃO fiz** (pra manter "polish leve"):
- Não mexi em estrutura de sidebar/topbar/abas.
- Não mexi em densidade ou espaçamento dos forms.
- Não adicionei estados vazios ilustrados ("nenhuma venda ainda" continua texto seco).
- Não adicionei sparklines nos KPIs.
- Não toquei no painel admin (`/admin/painel`) — só portal parceiro.
- Mobile responsividade fora de escopo (Cenário A = desktop only).

**Validações:**
- `node --check parceiro/public/app.js` ✓
- `npm run typecheck` ✓ (não foi necessário mexer em TS além do `flash`)

**Próximo nível disponível** (não solicitado, registrado pra referência):
- **Médio**: estados vazios elegantes com ilustração SVG, KPIs com sparklines mini, dashboard Resumo com hero card de Saúde maior, transições entre abas suaves. ~1 dia.
- **Pesado**: brand identidade própria por unidade (logo customizado), tema escuro opcional, charts maiores no Resumo. ~2-3 dias.

— Claude Opus 4.7, 2026-05-20. Polish visual leve fecha a sessão. Backend + banco + visual em um único deploy.

### Observação operacional do Bot/Shadow

Em 2026-05-19, o painel local carregou dados reais de `prod` e exibiu pares antigos de `dashboard.shadow_pairs`, mas a API respondeu:

```text
atendente_shadow_enabled=false
generator_llm_enabled=false
```

Portanto, a tela está lendo o banco, mas conversa nova enviada no Chatwoot não gera novo par Shadow enquanto o processo que recebe o webhook estiver com `ATENDENTE_SHADOW_ENABLED=false`. Para validar conversa nova, ligar o worker Shadow no ambiente correto (deploy/Coolify que recebe o webhook real), mantendo envio ao cliente desligado.

*Documento revisado em 2026-05-19. Próxima revisão: ao fim dos 14 dias de Fase 1.*
