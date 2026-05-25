# Agent V2 — Estado de Produção

**Última atualização**: 2026-05-25 (sessão de polish completa)
**Status**: V2 em produção, V1 totalmente removido do código e da fila
**Custo real medido**: ~R$ 0,20–0,30/conversa (incluindo coalescing)
**Última conversa validada**: 621 (Ângelo, PED-0006, nota 9.2/10)

---

## 1. Visão geral

Agente conversacional de WhatsApp pra loja de pneus de moto, baseado em **1 LLM com function calling**. Substituiu a arquitetura antiga de 3 LLMs (Planner + Generator + Organizadora) sem migration de banco e cortando ~80% do custo.

```
WhatsApp → Chatwoot → webhook → core.messages
                                       ↓
                                ops.atendente_jobs (fila)
                                       ↓
                                Agent V2 Worker (poll 5s)
                                       ↓
                              loadHistory + LLM call + tools
                                       ↓
                                  agent.turns
                                       ↓
                              sendMessage → Chatwoot → cliente
```

---

## 2. Arquivos do V2

```
src/atendente-v2/
├── worker.ts       ← Poll da fila ops.atendente_jobs, supersede, runs agent
├── agent.ts        ← Loop do turn (chama OpenAI, executa tools, persiste)
├── history.ts      ← Carrega core.messages + agent.turns.actions intercalados
├── prompt.ts       ← System prompt (~2.2k tokens, fluxo de 6 passos)
├── sender.ts       ← Envia resposta pro Chatwoot (com strip de OPCOES)
├── tools.ts        ← 7 tools + executores
└── types.ts        ← Interfaces TS
```

**Integrações:**
- `src/atendente/tools/commerce-tools.ts` — funções SQL das tools (mantido do V1)
- `src/atendente/policies/policy-schemas.ts` — schemas das políticas (mantido)
- `src/atendente/reconcile-jobs.ts` — reconcile periódico (mantido)
- `src/shared/repositories/ops-atendente.repository.ts` — fila, debounce, supersede

**V1 — totalmente removido**: `src/organizadora/`, `src/atendente/{planner,generator,executor,validators,policies/!schemas,handlers,state,worker.ts}`, `src/shared/zod/{agent-actions,agent-state,llm-organizadora,fact-keys}.ts`, `src/persistence/enrichment-jobs.repository.ts`.

---

## 3. As 7 tools

| Tool | Quando | Tipo |
|------|--------|------|
| `buscar_compatibilidade` | Cliente disse a **moto** | leitura |
| `buscar_produto` | Cliente disse a **medida** ou marca | leitura |
| `calcular_frete` | Bairro fornecido | leitura |
| `verificar_estoque` | Raríssimo — só se busca foi há 8+ turnos | leitura |
| `buscar_politica` | Garantia, horário, pagamento, troca | leitura |
| `criar_pedido` | Passo 6 do fluxo. Exige `valor_frete` quando delivery | **escrita** |
| `escalar_humano` | Cliente pediu, reclamação, fora do escopo | sinalização |

**Possível ampliação futura (não implementada):**
- 🔴 `consultar_pedido` — cliente perguntando status (será necessária quando volume crescer)
- 🟡 `cancelar_pedido` — hoje vira escalação
- 🟡 `confirmar_pagamento` — hoje vira escalação (não processa comprovante Pix)

---

## 4. Fluxo do turn

```
1. Cliente manda msg → Chatwoot webhook → core.messages → ops.atendente_jobs
   └─ enqueueAtendenteJob faz UPDATE not_before=now()+3s em TODOS jobs pending da conv
      (coalescing window — ver §6)

2. Worker poll (a cada 5s):
   └─ pickAtendenteJob: WHERE status='pending' AND not_before <= now()
   └─ Se hasNewerPendingJob: marca este 'processed' com error_message='superseded:...'
      e pula sem chamar LLM
   └─ Senão: marca processing, chama runAgentV2

3. runAgentV2:
   a) loadHistory: core.messages + agent.turns.actions em ordem cronológica
   b) Monta pacote [SYSTEM] + [HISTÓRICO]
   c) Loop: chama OpenAI → executa tools → reinjeta → até finalText (max 5 rounds)
   d) sendMessage pro Chatwoot
   e) INSERT em agent.turns com say_text + actions + tokens
```

---

## 5. Tabelas usadas

### Em runtime

| Tabela | Uso | Colunas tocadas |
|--------|-----|-----------------|
| `core.messages` | Leitura | id, conversation_id, sender_type, content, sent_at |
| `core.conversations` | Leitura | id, chatwoot_conversation_id, contact_id |
| `agent.turns` | Escrita | environment, conversation_id, trigger_message_id, agent_version='v2', say_text, **actions** (jsonb), llm_input_tokens, llm_output_tokens, llm_duration_ms, status='delivered' |
| `ops.atendente_jobs` | Leitura/Escrita | + `not_before` agora gerenciado pelo coalescing |

### Pedido (criar_pedido)

| Tabela | Colunas |
|--------|---------|
| `commerce.orders` | environment, contact_id, source_conversation_id, **total_amount** (subtotal + frete), status='open', fulfillment_mode, payment_method, delivery_address, source='chatwoot_com_bot' |
| `commerce.order_items` | environment, order_id, product_id, quantity, unit_price |

**Importante**: `total_amount` inclui frete. Tool `criar_pedido` exige param `valor_frete` quando modalidade=delivery.

### Catálogo (somente leitura)

`commerce.products`, `tire_specs`, `vehicle_models`, `vehicle_fitments`, `stock_levels`, `current_prices`, `delivery_zones`, `store_policies` — acessadas via SQL functions das tools.

### Tabelas órfãs (V1 desligado)

```
agent.cart_current, cart_current_items, cart_events
agent.session_current, session_events, session_items, session_slots
agent.order_drafts, pending_confirmations, pending_human_closures
agent.escalations
ops.enrichment_jobs
```
**Recomendação**: deixar por 30 dias. Apagar depois.

---

## 6. Coalescing window (anti-resposta-em-rajada)

**Problema resolvido**: cliente mandando 3+ mensagens em rajada fazia o bot responder 3 vezes separadas (1 por job).

**Solução**: a cada mensagem nova, `enqueueAtendenteJob` faz:

```sql
UPDATE ops.atendente_jobs
SET not_before = now() + (3 seconds)::interval
WHERE environment = $1 AND conversation_id = $2 AND status = 'pending';
```

Toda msg nova **reseta o timer** de todos os jobs pending da conversa. Bot só "acorda" depois que o cliente para de digitar por 3s. Quando processa, `hasNewerPendingJob` descarta os jobs intermediários (status='processed', error='superseded:newer_message_arrived') e só o último roda — vendo todas as msgs no histórico de uma vez.

**Comportamento por cenário:**

| Cenário | Antes | Agora |
|---|---|---|
| 1 msg solta | 6s espera | 3s espera |
| 3 msgs em 5s | 3 respostas atropeladas | 1 resposta vendo as 3 |
| 5 msgs em 30s c/ pausas | 2-3 respostas atropeladas | 1 resposta com tudo |
| Cliente corrige após 8s | Respondia a versão errada | Responde a versão certa |

**Validado em produção** (conv 621, Ângelo): 5 msgs em 19s → 1 resposta única às 19:56:29.

Configurável: `AGENT_V2_DEBOUNCE_SECONDS` (default 3, max 60).

---

## 7. Regras do prompt — destaques

### 2 caminhos de cotação
- **(a) Cliente disse medida** ("90/90-18") → `buscar_produto` direto, **não pergunta a moto**
- **(b) Cliente disse moto** ("Fan 150") → `buscar_compatibilidade`

### Estoque (limiares quantitativos)
- `total_stock == 0` → "tá em falta agora"
- `1 ≤ total_stock ≤ 3` → "tenho aqui, mas só X unidades"
- `total_stock >= 4` → **não menciona** estoque

### Formatação
- **Default**: texto corrido WhatsApp, sem bullets
- **Exceção 1**: cotação com 2+ produtos → uma linha por produto com preço
- **Exceção 2**: resumo final do pedido → bloco com nº pedido, itens, frete, total, endereço, pagamento

### Fluxo de fechamento (6 passos, obrigatório)
1. Produto confirmado (busca rodou)
2. Cliente confirmou interesse → perguntar entrega ou retirada
3. Se delivery → bairro → `calcular_frete`
4. Mostrar total (produtos + frete)
5. Coletar nome, endereço, pagamento numa mensagem só
6. `criar_pedido` (com `valor_frete` se delivery)

### Stop rules
- Cliente pediu humano → `escalar_humano` imediato
- Tool erro 2x → escalar
- Max 3 parágrafos, exceto resumo final estruturado

---

## 8. Variáveis no Coolify

### Manter (22 vars)

```bash
NODE_ENV=production
FAREJADOR_ENV=prod
PORT=3000
LOG_LEVEL=info
SIGNAL_TIMEZONE=America/Sao_Paulo
SKIP_EVENT_TYPES=

DATABASE_URL=...
DATABASE_POOL_MAX=5
DATABASE_SSL=true
PARTNER_DATABASE_URL=...

CHATWOOT_HMAC_SECRET=...
CHATWOOT_WEBHOOK_MAX_AGE_SECONDS=300
CHATWOOT_API_BASE_URL=https://chatwoot.smarttecsolutions.com.br/api/v1
CHATWOOT_API_TOKEN=...
CHATWOOT_ACCOUNT_ID=2

ADMIN_AUTH_TOKEN=...

OPENAI_API_KEY=...
OPENAI_MODEL=gpt-5.5
OPENAI_TIMEOUT_MS=30000

AGENT_V2_WORKER_ENABLED=true
AGENT_V2_POLL_INTERVAL_MS=5000
AGENT_V2_CONVERSATION_IDS=*
AGENT_V2_DEBOUNCE_SECONDS=3    # opcional, default 3
```

### Remover (já não fazem nada, zod ignora)

`ORGANIZADORA_*`, `PLANNER_*`, `GENERATOR_*`, `ATENDENTE_SHADOW_*`, `ATENDENTE_CONTEXT_*`

---

## 9. Bugs corrigidos nesta sessão (2026-05-25)

| # | Bug | Fix | Commit |
|---|-----|-----|--------|
| 1 | V1 ainda hospedava V2 — não dava pra desligar `ATENDENTE_SHADOW_ENABLED` sem matar o V2 | Worker V2 próprio (`src/atendente-v2/worker.ts`); `server.ts` chama `startAgentV2Worker` | `1c7718d` |
| 2 | Frete não gravado em `commerce.orders.total_amount` (R$ 198 no banco quando cliente combinou R$ 207,90) | Tool `criar_pedido` exige `valor_frete` quando delivery. `total_amount = subtotal + frete`. Retorno separa as 3 grandezas. | `5454922` |
| 3 | Bot chamava `verificar_estoque` redundante (~2k tokens/conversa) | Doc da tool e prompt deixam claro: estoque já vem em `buscar_compatibilidade`. Use só após 8+ turnos. | `5454922` |
| 4 | Cotação com 2 pneus saía em texto corrido bagunçado | Regra de formatação estruturada para 2+ produtos. Exemplos atualizados. | `475347d` |
| 5 | Resumo final do pedido vinha sem nº, endereço, items separados | Template de bloco estruturado completo. Exceção da regra "max 3 parágrafos". | `475347d` |
| 6 | Bot respondia 3x quando cliente mandava 3 msgs em rajada | Coalescing window 3s (modelo Intercom) com supersedimento | `9e89575` + `52f1ac6` |
| 7 | Contradições no prompt (limites subjetivos, exemplo inconsistente) | Auditoria: 8+ turnos definido, estoque com limiar quantitativo, exemplo de cotação corrigido | `7c20276` + `e782c62` |
| 8 | Bot perguntava moto quando cliente já tinha dado medida ("tem 90/90-18?" → "qual moto?") | Regra "2 caminhos de cotação" no prompt | `44f184e` |

---

## 10. Métricas validadas em produção

### Conv 619 (Wallace, PED-0005, nota 9.5/10)
- 8 turns
- 38.135 tokens input, 917 output
- ~R$ 0,30
- 7 tool calls
- ✅ Pedido criado, ⚠️ frete não estava no `total_amount` (bug que originou os fixes)

### Conv 621 (Ângelo, PED-0006, nota 9.2/10) — **pós-fixes**
- 10 turns
- 62.887 tokens input
- ~R$ 0,40
- Coalescing funcionou: 5 msgs em 19s → 1 resposta
- ✅ `total_amount=108.90` (R$ 99 + R$ 9,90) corretos
- ✅ Resumo final estruturado completo
- ✅ Não perguntou moto quando cliente deu medida
- ⚠️ 1 ponto fraco: bot levou 2 turnos pra entender "ele pega na fan 2015?" depois de já ter cotado por medida

---

## 11. Rollback

Se algo der errado:

```bash
# Coolify
AGENT_V2_WORKER_ENABLED=false
```

Bot para de processar. Mensagens continuam entrando em `core.messages` (sem ingestão perdida). Para voltar: `AGENT_V2_WORKER_ENABLED=true`.

V1 **não tem rollback** — código foi removido. Reinstalar V1 exige `git revert 1c7718d` e redeploy.

---

## 12. Limitações conhecidas

1. **Quick replies (`OPCOES:`) não viram botão no WhatsApp.** Texto é strip pelo sender, cliente nunca vê. LLM usa como hint interna pra formular pergunta fechada.

2. **Nome do cliente não atualiza `core.contacts`.** Fica só no histórico/pedido.

3. **Sem `consultar_pedido`.** Cliente que volta perguntar status do pedido vai pra escalação humana. Implementar quando volume aumentar.

4. **Sem processamento de imagem (comprovante Pix).** Tool de confirmação de pagamento não existe.

5. **Latência base +3s.** Toda resposta agora demora ~3s a mais por causa do coalescing. Trade-off aceito.

6. **Bot pode falhar no "pivot por medida → confirmação por moto"** (conv 621 T1). Quando cliente já recebeu cotação por medida e depois pergunta "ele pega na X?", LLM pode repetir o preço em vez de validar com `buscar_compatibilidade`. Próximo fix se virar padrão.

---

## 13. Próximos passos sugeridos (em ordem)

1. **`consultar_pedido` tool** — quando aparecer "cadê meu pedido?" pela 3ª vez no mês
2. **Capturar nome do cliente em `core.contacts`** — pra dashboard de clientes
3. **Dashboard de pedidos do bot** — already exists em `/admin/painel`?
4. **Apagar tabelas `agent.*` órfãs** — depois de 30 dias sem incidentes
5. **Avaliar Claude Sonnet 4.7** vs gpt-5.5 — Anthropic tem prompt caching mais agressivo

---

## 14. Commits relevantes (esta sessão)

```
44f184e fix(agent-v2): nao pergunta moto quando cliente ja deu a medida
e782c62 fix(agent-v2): resolve contradicao no exemplo de cotacao + define limiar de estoque
7c20276 fix(agent-v2): resolve conflitos prompt/tools apos auditoria
52f1ac6 feat(agent-v2): troca debounce fixo por coalescing window (modelo Intercom)
9e89575 feat(agent-v2): debounce de mensagens em sequencia (anti-resposta-em-rajada)
475347d fix(agent-v2): formata cotacao multi-produto e resumo final do pedido
5454922 fix(agent-v2): grava frete no total_amount e remove verificar_estoque redundante
1c7718d chore(agent-v1): desliga V1 e migra worker para src/atendente-v2/
```

---

## 15. Referências

- Repo: `farejador-pneus` (remote `pneus`)
- Deploy: Coolify, serviço `farejador-pneus`
- DB: Supabase `aoqtgwzeyznycuakrdhp`
- Auditoria de conv: ver scripts em `scripts/auditar-*.cjs`
- Limpeza de banco: `scripts/apagar-conversas-2026-05-23.cjs` (com `COMMIT=1`)
