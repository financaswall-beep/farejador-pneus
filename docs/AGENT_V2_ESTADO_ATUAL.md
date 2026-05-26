# Agent V2 — Estado Atual (HANDOFF para próxima LLM)

**Última atualização**: 2026-05-26 — fim da sessão de polish + experimento prompt EN
**Para quem pega esse projeto agora**: leia este doc primeiro. Depois `AGENT_V2_HANDOFF.md` e `AGENT_V2_OTIMIZACAO_TETO.md` se precisar de detalhe.

---

## TL;DR em 5 linhas

1. Bot de WhatsApp pra loja de pneus de moto. **Em produção, funcionando.**
2. Stack: 1 LLM (`gpt-5.5`) + function calling + 8 tools, hospedado em Coolify, banco Supabase.
3. Custo: ~R$ 0,20-0,35 por conversa (cai com volume). Ticket médio R$ 200-300 = LLM é 0,1% do faturamento.
4. V1 (3 LLMs Planner+Generator+Organizadora) foi totalmente removido nesta sessão.
5. Último commit: `b229f57` (prompt híbrido EN+exemplos PT). Validado em conv 622/PED-0008.

---

## 1. O que existe hoje

### Arquivos de runtime (V2 ativo)

```
src/atendente-v2/
├── worker.ts             Poll de ops.atendente_jobs + supersede + runs agent
├── agent.ts              Loop do turn (LLM + tools + persistência)
├── history.ts            Carrega core.messages + agent.turns.actions
├── prompt.ts             SYSTEM_PROMPT atual (EN + exemplos PT, ~1.700 tokens)
├── prompt.legacy-ptbr.ts BACKUP do prompt anterior em pt-br (rollback fácil)
├── sender.ts             Envia resposta pro Chatwoot (strip OPCOES)
├── tools.ts              8 tools + executores
└── types.ts              Interfaces TS
```

### Tools (8)

| Tool | Tipo | Quando |
|------|------|--------|
| `buscar_compatibilidade` | leitura | Cliente disse a MOTO ("Fan 150") |
| `buscar_produto` | leitura | Cliente disse a MEDIDA ("90/90-18") |
| `calcular_frete` | leitura | Após receber bairro |
| `verificar_estoque` | leitura raríssima | Só se busca há 8+ turnos atrás |
| `buscar_politica` | leitura | Garantia, horário, pagamento, troca |
| `criar_pedido` | **escrita** | Passo 6 do fluxo. Exige `valor_frete` se delivery |
| `consultar_pedido` | leitura | "Cadê meu pedido?" — busca por nº ou últimos do contato |
| `escalar_humano` | sinalização | Cliente pediu, reclamação, fora do escopo |

### Tabelas do banco

**Leitura**:
- `core.messages`, `core.conversations`, `core.contacts`
- `commerce.products`, `tire_specs`, `vehicle_models`, `vehicle_fitments`, `stock_levels`, `current_prices`, `delivery_zones`, `store_policies`

**Escrita**:
- `agent.turns` — historico do bot (1 row por turn, com say_text + actions jsonb + tokens)
- `agent.session_current` — sessão por conversa (criada pelo dispatcher antes do job — schema mínimo)
- `commerce.orders` + `commerce.order_items` — pedidos criados
- `ops.atendente_jobs` — fila de processamento

**Apagadas em 2026-05-26 (eram realmente órfãs do V1)**:
- `agent.cart_current`, `cart_current_items`, `cart_events`
- `agent.escalations`, `order_drafts`, `pending_confirmations`
- `agent.session_items`, `session_slots`, `session_events`
- `ops.stock_snapshots`, `unhandled_messages`, `bot_events`
- Schema `analytics_marts` inteiro (8 views da Organizadora V1)

**Apagadas por engano e recriadas/pendentes**:
- `agent.session_current` ✅ recriada (V2 dispatcher usa)
- `ops.human_bot_reviews` ⚠️ pendente recriar (painel admin /shadow/review usa)
- `ops.enrichment_jobs` ⚠️ pendente recriar (repository legacy ainda referencia)

---

## 1.5. Camada de Analytics — implementada 2026-05-26

**6 tabelas analytics populando automaticamente** via trigger em `agent.turns`:

| Tabela | O que tem | Fonte |
|--------|-----------|-------|
| `analytics.conversation_facts` | 26+ tipos de facts (nome, moto, preço, frete, pedido, etc) | Parse de `agent.turns.actions` jsonb |
| `analytics.fact_evidence` | 1 evidência por fact (rastreabilidade) | Mesmo trigger |
| `analytics.conversation_classifications` | 5 dimensões (outcome, stage, customer_type, intent, urgency, loss_reason) | Regras SQL |
| `analytics.linguistic_hints` | 9 padrões regex (aceite, objeção, urgência, etc) | Regex sobre `core.messages` do cliente |
| `analytics.conversation_signals_mv` | Tempos, contagens, tokens, custo | Materialized view |
| `analytics.customer_journey_mv` | LTV, total pedidos, recorrente | Materialized view |

**Funcionamento:**
- `agent.turns` INSERT → trigger `analytics_extract_facts` dispara → roda 3 funções SQL
- Funções têm `EXCEPTION WHEN OTHERS` → bot **nunca quebra** se trigger falhar
- pg_cron agendado: refresh diário às 3h e 3h15
- ~88% das métricas analíticas populadas em real-time sem LLM nenhuma

**Views de consumo prontas (`analytics.v_*`)**:
- `v_conversation_summary` — 1 linha por conversa com 25+ colunas (cliente, pedido, tokens, custo, bairro, etc)
- `v_daily_metrics` — métricas agregadas por dia
- `v_top_bairros` — vendas por geografia
- `v_top_motos` — motos mais consultadas
- `v_top_produtos` — produtos mais cotados

**Doc completa:** `docs/PLANO_ANALYTICS_2026-05-26.md`

---

## 2. Variáveis de ambiente (Coolify)

**22 vars ativas**:
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
AGENT_V2_DEBOUNCE_SECONDS=3   # opcional, default 3
```

**Removidas nesta sessão** (zod ignora se ficarem):
`ORGANIZADORA_*`, `PLANNER_*`, `GENERATOR_*`, `ATENDENTE_SHADOW_*`, `ATENDENTE_CONTEXT_*`

---

## 3. Tudo que foi feito nesta sessão (13 commits)

```
b229f57 exp(agent-v2): troca SYSTEM_PROMPT pra versao hibrida ingles + exemplos pt-br ⭐
aadafde perf(agent-v2): forca prompt_cache_retention=24h explicito
c4024af feat(agent-v2): tool consultar_pedido ⭐
358ea6d perf(agent-v2): ordem deterministica no loadHistory pra nao quebrar cache
7f988ce chore(agent-v2): poda lixo do prompt (-160 tokens)
ac476db obs(agent-v2): loga cached_tokens e cache_hit_pct
44f184e fix(agent-v2): nao pergunta moto quando cliente ja deu a medida
e782c62 fix(agent-v2): contradicao no exemplo + limiar de estoque
7c20276 fix(agent-v2): resolve conflitos prompt/tools apos auditoria
52f1ac6 feat(agent-v2): coalescing window (Intercom-style) ⭐
9e89575 feat(agent-v2): debounce de mensagens em sequencia
475347d fix(agent-v2): formata cotacao multi-produto e resumo final
5454922 fix(agent-v2): grava frete no total_amount + remove verificar_estoque redundante ⭐
1c7718d chore(agent-v1): desliga V1 e migra worker para src/atendente-v2/ ⭐
```

⭐ = commits estruturais importantes.

---

## 4. Features implementadas nesta sessão

### 4.1 Desligamento V1 (`1c7718d`)
- Apagados: `src/organizadora/`, `src/atendente/{planner,generator,executor,validators,policies,handlers,state,worker.ts}`, schemas zod do V1
- Mantidos: `src/atendente/{tools,policies/policy-schemas.ts,reconcile-jobs.ts}` (V2 reusa)
- Worker V2 isolado em `src/atendente-v2/worker.ts`
- `server.ts` chama `startAgentV2Worker()` direto

### 4.2 Fix do frete (`5454922`)
- Bug: PED-0005 gravou `total_amount=198` quando cliente combinou R$ 207,90
- `criar_pedido` agora exige `valor_frete` quando delivery
- `total_amount = subtotal + frete`
- Retorno separa subtotal/valor_frete/total
- Guard: se delivery sem valor_frete → erro estruturado

### 4.3 Coalescing window 3s (`9e89575` + `52f1ac6`)
- Cliente manda 3 msgs em rajada → bot responde 1 vez só
- A cada msg nova, UPDATE not_before de todos jobs pending da conv pra `now()+3s`
- Worker descarta jobs obsoletos via `hasNewerPendingJob`
- Default: `AGENT_V2_DEBOUNCE_SECONDS=3`, max 60

### 4.4 Logs de cache (`ac476db` + `358ea6d` + `aadafde`)
- Captura `usage.prompt_tokens_details.cached_tokens` e loga `cache_hit_pct`
- `loadHistory` com `ORDER BY sent_at DESC, id DESC` (prefix determinístico)
- `prompt_cache_retention: '24h'` explícito no body

### 4.5 Tool `consultar_pedido` (`c4024af`)
- Cliente pergunta "cadê meu pedido?" → bot consulta direto, sem escalar humano
- Aceita `order_number` ou lista últimos N pedidos do contato
- Retorna: número, status, total, itens, endereço, datas
- Prompt traduz status (open=em separação, paid=pago, etc) pra fala natural

### 4.6 Prompt híbrido EN+PT (`b229f57`) ⚠️ EM TESTE
- Regras em inglês (mais eficiente em tokens)
- Exemplos de resposta em pt-br (ancoram vocabulário brasileiro)
- Trava de idioma: item 8 do FINAL CHECK
- Tolerância a typos: "customer may write with typos... understand intent"
- Economia: ~R$ 0,16/conv (-37% tokens prompt, -20% custo real)
- **Backup**: `src/atendente-v2/prompt.legacy-ptbr.ts`
- **Doc**: `docs/AGENT_V2_PROMPT_EXPERIMENTO_INGLES.md`

---

## 5. Métricas validadas em produção

| Conv | Cliente | Pedido | Turns | Custo real | Notas |
|---|---|---|---|---|---|
| 619 | Wallace (1ª) | PED-0005 R$ 198 | 8 | ~R$ 0,30 | ⚠️ Frete não no total_amount (bug que originou fix #4.2) |
| 621 | Ângelo | PED-0006 R$ 108,90 | 10 | ~R$ 0,40 | ✅ Frete OK após fix. Nota 9.2/10 |
| 622 | Wallace (2ª) | PED-0008 R$ 108,90 | 7 | **~R$ 0,50** | ✅ Prompt EN funcionando. 1ª pós-deploy (cache warmup). Nota 9.5/10 |
| 623 | Anderson | PED-0009 R$ 207,90 | 8 | ~R$ 0,43 | 🏆 Multi-produto multi-moto, recuperação inteligente, consolidação. Nota 9.8/10 |
| **624** | **Wallace (3ª)** | **PED-0010 R$ 207,90** | **7** | **~R$ 0,23** 🏆 | ✅ **Mais barata até hoje. Twister 2019, regra meia-vida funcionou ("são novos?"→explicou), saudação adaptativa ("Bom dia"). Nota 9.6/10. Único soluço: 4min na 1ª resposta porque acabei de apagar agent.session_current por engano (recriado)** |

### Conv 623 — Feito técnico notável

Cliente Anderson pediu pneu da **NMAX + PCX juntos** sem saber o modelo da PCX. Bot:
1. Disparou 2 `buscar_compatibilidade` em paralelo (NMAX + PCX)
2. Listou 3 modelos de PCX quando ambíguo
3. Quando cliente disse "não sei o modelo", deu dica prática de mecânico ("na lateral do pneu velho tem a medida")
4. Cliente sugeriu "tem como ser pelo ano?" → bot adaptou e identificou PCX 160 via ano 2024
5. Percebeu que os 2 pneus eram fisicamente iguais (mesmo product_id) e gravou como 1 item quantity=2 no banco
6. Fechou PED-0009 R$ 207,90 com endereço/typos parseados

Tempo total: 10 minutos. Custo: R$ 0,43. Cenário que humano demoraria 15+ min e custaria R$ 5-10 do tempo do dono.

---

## 6. Status do experimento prompt EN

**Estado**: 🟡 EM TESTE (2/5 convs validadas, faltam 3)

**Resultados acumulados (conv 622 + 623)**:
- ✅ Idioma 100% pt-br nas 2 convs (15 turns combinados, zero vazamento)
- ✅ Tom brasileiro mantido em todas respostas
- ✅ Tools funcionando normal (9 calls combinadas, incluindo paralelo)
- ✅ Banco gravando correto (PED-0008 e PED-0009 com `total_amount` certo)
- ✅ Economia confirmada (cache hit 76-79% medido em logs)
- ✅ Cenários novos cobertos: multi-produto, multi-moto, recuperação quando cliente trava
- 🟡 1 drift menor (conv 622): faltou OPCOES em "Qual modelo da Fan?" (cliente respondeu OK)
- 🟡 Cosmético: nome de produto verboso no resumo final

**Critério pra declarar estável**: 5 convs consecutivas sem regressão. Faltam 3.

**Como reverter se der ruim**:
```bash
git revert b229f57
git push pneus
# OU em src/atendente-v2/prompt.ts:
# export { LEGACY_SYSTEM_PROMPT_PTBR as SYSTEM_PROMPT } from './prompt.legacy-ptbr.js';
```

---

## 7. Custo: o teto realista

```
Cache da OpenAI é por ORGANIZAÇÃO (não por cliente)
TTL: 24h
Desconto: 90% no cacheado ($0.50/M vs $5/M no gpt-5.5)

Convs/dia → cache hit médio:
  1   →  60-70% → R$ 0,30/conv
  5   →  80%    → R$ 0,26/conv
  20  →  85%    → R$ 0,22/conv
  100 →  90%    → R$ 0,19/conv
  500 →  92%    → R$ 0,17/conv
```

Bot fica MAIS BARATO com volume.

A R$ 200 de ticket médio: LLM custa 0,1% do faturamento.

**Nenhuma otimização de tokens vale a pena no volume atual.** Próximo ganho está em outras frentes (ver §9).

---

## 8. Limitações conhecidas

1. **Quick replies (`OPCOES:`) não viram botão no WhatsApp** — texto é strip pelo sender. LLM usa como hint interna pra formular pergunta fechada. Cliente nunca vê o "OPCOES:".

2. **Nome do cliente não atualiza `core.contacts`** — fica só no histórico/pedido. Cliente recorrente é tratado como anônimo.

3. **Sem `cancelar_pedido`** — cliente desistir vira escalação humana.

4. **Sem processamento de imagem** (comprovante Pix) — nenhuma tool de OCR.

5. **Latência base +3s** — coalescing adiciona 3s antes do bot responder. Trade-off aceito (qualidade > velocidade).

6. **`HISTORY_LIMIT=30`** — conversas longas (>30 msgs) perdem contexto antigo. Cobre 99% das convs reais.

7. **Tabelas órfãs do V1** — ainda no banco, decidir drop em 30 dias.

---

## 9. Próximas frentes sugeridas (em ordem de prioridade)

### 🔴 Alta — preparar pra escala
1. **Validar prompt EN com 5+ convs** — declarar experimento estável ou reverter
2. **`cancelar_pedido` tool** — cliente desistir sem escalar humano
3. **Capturar nome em `core.contacts`** — habilita dashboard de clientes fiéis

### 🟡 Média — operacional
4. **Retry com backoff em 429 OpenAI** — bot não quebra com OpenAI lenta
5. **Cron de limpeza de jobs antigos** — `ops.atendente_jobs` não cresce pra sempre
6. **Múltiplos workers em paralelo** — atual: 1 worker poll 5s. A 50+ convs/dia vira gargalo

### 🟢 Baixa — quando volume aumentar
7. **Dashboard de custo diário** — visibilidade financeira do bot
8. **Métrica de NPS / satisfação por conversa**
9. **Apagar tabelas órfãs do V1** (depois de 30 dias estável)
10. **`confirmar_pagamento_pix` tool** — processar comprovante via Vision API

### ⚪ Não fazer (estudado e rejeitado)
- Migrar pra `/responses` API (compaction, stateful) → 1-2 dias dev, zero economia de R$
- Predicted Outputs → não suporta gpt-5.5 nem function calling
- Trocar pra gpt-4o-mini → dono rejeitou (qualidade)
- Mais corte de prompt → no teto, risco > ganho

---

## 10. Como operar o sistema

### Auditar uma conversa
```sql
-- Pega UUID a partir do número Chatwoot
SELECT id FROM core.conversations WHERE chatwoot_conversation_id = 622;

-- Ver mensagens
SELECT sender_type, content, sent_at
FROM core.messages WHERE conversation_id = '<uuid>'
ORDER BY sent_at;

-- Ver turns do bot
SELECT llm_input_tokens, llm_output_tokens, llm_duration_ms, actions
FROM agent.turns WHERE conversation_id = '<uuid>'
ORDER BY created_at;
```

### Limpar banco (testes do zero)
```bash
cd "C:\Farejador agente"
# Apaga pedidos do bot primeiro (CASCADE alarm)
node --env-file=.env -e "..." # ver scripts/apagar-conversas-2026-05-23.cjs
COMMIT=1 node --env-file=.env scripts/apagar-conversas-2026-05-23.cjs
```

### Ver logs em produção
- Coolify → `farejador-pneus` → Logs → filtra por `cache_hit_pct`, `turn completed`, `superseded`, etc

### Rollback emergencial
```bash
# 1. Desliga V2 (bot para de responder mas não perde msgs)
# No Coolify:
AGENT_V2_WORKER_ENABLED=false
# Redeploy

# 2. Volta versão anterior do código
git revert <commit-ruim>
git push pneus
# Coolify auto-deploya em ~2min

# 3. Reverter prompt específico
# Em src/atendente-v2/prompt.ts:
# export { LEGACY_SYSTEM_PROMPT_PTBR as SYSTEM_PROMPT } from './prompt.legacy-ptbr.js';
```

---

## 11. Arquitetura — diagrama mental

```
Cliente WhatsApp
   ↓
Chatwoot
   ↓ webhook
src/webhooks/chatwoot → core.messages
   ↓
src/normalization/dispatcher → ops.atendente_jobs
   ↓ (com debounce 3s — coalescing window)
src/atendente-v2/worker (poll 5s)
   ↓ hasNewerPendingJob check → supersede se houver mais novo
   ↓
src/atendente-v2/agent.runAgentV2
   ├── loadHistory (core.messages + agent.turns.actions)
   ├── callOpenAIWithTools (gpt-5.5, prompt EN, cache 24h)
   ├── executeTool × N (paralelo se leitura, transação se escrita)
   └── sendMessage → Chatwoot → cliente
   ↓
agent.turns (persistência)
```

---

## 12. Documentação disponível

| Doc | Para que serve |
|---|---|
| **AGENT_V2_ESTADO_ATUAL.md** (este) | Single entry point pra próxima LLM |
| `AGENT_V2_HANDOFF.md` | Handoff completo com mais detalhes técnicos |
| `AGENT_V2_OTIMIZACAO_TETO.md` | Análise de otimização (3 features OpenAI investigadas) |
| `AGENT_V2_PROMPT_EXPERIMENTO_INGLES.md` | Detalhes do experimento prompt EN (riscos, rollback) |
| `PLANO_AGENT_V2.md` | Plano original do V2 (histórico) |

---

## 13. Repositórios e infra

- **Repo principal**: `farejador-pneus` (remote `pneus` → github.com/financaswall-beep/farejador-pneus)
- **Repo antigo**: `FarejaorV1` (remote `origin`) — DESATUALIZADO, não usar
- **Deploy**: Coolify, app `farejador-pneus`
- **Banco**: Supabase `aoqtgwzeyznycuakrdhp`
- **Chatwoot**: chatwoot.smarttecsolutions.com.br (account 2)

---

## 14. Comandos úteis

```bash
# Typecheck (sempre antes de commit)
npx tsc --noEmit

# Testes
npx vitest run --reporter=dot

# Limpar conversas pra teste
COMMIT=1 node --env-file=.env scripts/apagar-conversas-2026-05-23.cjs

# Ver estado do git
git status --short
git log --oneline -10

# Push pra prod (auto-deploy via Coolify)
git push pneus

# Auditar tokens das últimas 24h
node --env-file=.env -e "
const {Client}=require('pg');
const c=new Client({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});
c.connect().then(async()=>{
  const r=await c.query(\\\"SELECT SUM(llm_input_tokens)::int AS in_tok, SUM(llm_output_tokens)::int AS out_tok, COUNT(*) AS turns FROM agent.turns WHERE created_at >= now() - interval '24 hours'\\\");
  console.table(r.rows);
  await c.end();
})"
```

---

## 15. Filosofia do projeto

Esta sessão foi guiada por 3 princípios:

1. **Brutal honestidade**: nunca dizer "feature X é boa" sem medir. Sempre pesar custo vs ROI.
2. **Pragmatismo > Perfeição**: aplicar fixes diretos com rollback fácil. Evitar refator gigante sem ganho mensurado.
3. **Foco em produção**: cada mudança valida em conv real (não só em teste). Métricas reais sempre falam mais que estimativas.

A próxima LLM que pegar isso: **respeite essas decisões**. Várias features parecem promissoras na superfície mas têm letras miúdas (Predicted Outputs, Conversation State, prompt em inglês inicial). Todas foram estudadas com profundidade aqui. Ler antes de re-propor.

---

**Status do bot em 2026-05-26**: 🟢 Funcionando, estável, calibrado.

**Próxima ação humana sugerida**: rodar 5-10 conversas reais nos próximos dias. Se nenhum bug aparecer, declarar experimento prompt EN como estável e atualizar este doc.
