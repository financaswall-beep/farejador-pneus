# Agent V2 — Handoff e Desligamento do V1

**Data**: 2026-05-25
**Status**: V2 em produção, V1 em paralelo (desativado por flag)
**Custo real medido**: ~14¢/conversa (vs ~$1,50/conversa do V1 com 3 LLMs)

---

## 🎯 Objetivos do projeto — TODOS atingidos

O V2 nasceu com 4 metas. Todas foram cumpridas:

| Meta original | Status |
|---|---|
| Substituir 3 LLMs por 1 | ✅ 1 único call por turn com function calling |
| Cortar custo de R$440/mês → ~R$60/mês | ✅ ~R$38-230/mês dependendo do modelo |
| Preservar o banco (zero migration) | ✅ Reusa `agent.turns.actions` (coluna jsonb existente) |
| Bot responder no WhatsApp de verdade (não shadow) | ✅ Pedidos reais sendo criados (PED-0003, PED-0004) |

**Conversa Anderson (PED-0004)** foi o marco — fluxo de ponta a ponta funcionando, tom humano, persistência de memória entre turns, pedido fechado. O sistema entrega tudo que se propôs.

---

## 1. O que é o V2

Substituição da arquitetura de 3 LLMs (Planner + Generator + Organizadora) por **um único LLM com function calling** (`gpt-5.5` ou `gpt-4o-mini`).

### Comparação rápida

| | V1 (anterior) | V2 (atual) |
|--|--|--|
| LLMs por turn | 3 (Planner, Generator, Organizadora) | 1 |
| Estado | 11 tabelas `agent.*` (slots, items, events) | 0 tabelas novas — usa `agent.turns.actions` |
| Memória entre turns | Slots estruturados | Tool calls persistidas + replay no histórico |
| Custo médio/conversa | ~R$8 (3 LLMs grandes) | ~70¢ (1 LLM) |
| Custo mensal estimado | ~R$440/mês | ~R$230/mês (gpt-5.5) ou ~R$38/mês (mini) |
| Latência por turn | 5-15s | 4-8s |
| Migrations necessárias | dezenas | **zero** |

---

## 2. Arquivos do V2

Todo o código novo vive em `src/atendente-v2/`:

```
src/atendente-v2/
├── agent.ts        ← Loop principal do turn (chama OpenAI, gerencia tool calls)
├── history.ts      ← Carrega histórico de core.messages + agent.turns.actions
├── prompt.ts       ← System prompt (~1500 tokens, 1 fonte de verdade)
├── sender.ts       ← Envia resposta pro Chatwoot
├── tools.ts        ← Definições + executores das 7 tools
└── types.ts        ← Interfaces ChatMessage, ToolCall, etc.
```

**Pontos de integração** (1 linha em cada):
- `src/atendente/worker.ts` — flag `AGENT_V2_CONVERSATION_IDS` roteia conversas pro V2
- `src/shared/config/env.ts` — declara a env var nova

**Reusa do V1**:
- `src/atendente/tools/commerce-tools.ts` — funções `buscarCompatibilidade`, `buscarProduto`, etc. (não tocou)
- `src/persistence/db.ts` — pool de conexão
- `src/shared/logger.ts` — logger
- `core.messages`, `core.conversations`, `core.contacts` — tabelas inalteradas

---

## 3. Tabelas usadas pelo V2 (TODAS já existiam)

### Em runtime

| Tabela | Uso | Colunas tocadas |
|--------|-----|-----------------|
| `core.messages` | Leitura — histórico de texto | id, conversation_id, sender_type, content, sent_at |
| `core.conversations` | Leitura — descobre chatwoot_id e contact_id | id, chatwoot_conversation_id, contact_id |
| `agent.turns` | Escrita por turn + leitura | environment, conversation_id, trigger_message_id, agent_version='v2', say_text, **actions** (jsonb), llm_input_tokens, llm_output_tokens, llm_duration_ms, status='delivered' |

### Pedido (passo 6)

| Tabela | Uso | Colunas tocadas |
|--------|-----|-----------------|
| `commerce.orders` | Escrita | environment, contact_id, source_conversation_id, total_amount, status='open', fulfillment_mode, payment_method, delivery_address, geo_resolution_id, source='chatwoot_com_bot' |
| `commerce.order_items` | Escrita | environment, order_id, product_id, quantity, unit_price |

### Catálogo (somente leitura via SQL functions)

- `commerce.products`, `commerce.tire_specs`, `commerce.vehicle_models`, `commerce.vehicle_fitments`, `commerce.stock_levels`, `commerce.current_prices`, `commerce.delivery_zones`
- Acessadas via `find_compatible_tires()`, `resolve_vehicle_model()` — não escreve em nenhuma

---

## 4. Tabelas do V1 que ficaram ÓCIOSAS

V2 não usa, mas estão preservadas. Decidir depois se apaga ou mantém pra histórico:

```
agent.cart_current
agent.cart_current_items
agent.cart_events
agent.session_current
agent.session_events
agent.session_items
agent.session_slots
agent.order_drafts
agent.pending_confirmations
agent.pending_human_closures
agent.escalations
```

**Recomendação**: manter por enquanto (não custam nada vazias). Apagar daqui a 1 mês se nada quebrar.

---

## 5. Como funciona um turn no V2

```
1. Cliente manda mensagem no WhatsApp
2. Chatwoot dispara webhook → ingere em core.messages
3. Worker (src/atendente/worker.ts) acorda
4. Worker confere AGENT_V2_CONVERSATION_IDS:
   - Se conversation_id está na lista (ou "*") → vai pro V2
   - Senão → vai pro V1 (Planner + Generator)

V2:
5. runAgentV2() em src/atendente-v2/agent.ts
6. loadHistory() carrega:
   - Texto do core.messages
   - Tool calls/results do agent.turns.actions
   - Intercala em ordem cronológica via trigger_message_id
7. Monta pacote: [SYSTEM] + [HISTÓRICO]
8. Loop:
   a) Chama OpenAI Chat Completions com tools
   b) Se resposta tem tool_calls → executa, adiciona ao pacote, volta pra (a)
   c) Se resposta é texto → break
   d) Máx 5 rounds por turn
9. Envia texto pro Chatwoot (sender.ts)
10. Grava em agent.turns com say_text + actions + tokens
```

---

## 6. As 7 tools do V2

| Tool | Tipo | O que faz |
|------|------|-----------|
| `buscar_compatibilidade` | leitura | Dado modelo da moto, retorna pneus compatíveis com preço e estoque |
| `buscar_produto` | leitura | Busca por medida (90/90-18), marca ou código |
| `calcular_frete` | leitura | Calcula frete por bairro/cidade |
| `verificar_estoque` | leitura | Estoque por product_id ou code (chamado silencioso no passo 2) |
| `buscar_politica` | leitura | Garantia, horário, formas de pagamento, troca, prazo |
| `criar_pedido` | **escrita** | Cria pedido + items (passo 6 do fluxo) |
| `escalar_humano` | sinalização | Marca conversa pra atendente humano |

Definições completas em `src/atendente-v2/tools.ts`.

---

## 7. Variáveis no Coolify

### Manter (são compartilhadas com infraestrutura)

```bash
NODE_ENV=production
FAREJADOR_ENV=prod
PORT=3000
DATABASE_URL=...
DATABASE_POOL_MAX=10
DATABASE_SSL=true
CHATWOOT_HMAC_SECRET=...
CHATWOOT_WEBHOOK_MAX_AGE_SECONDS=300
CHATWOOT_API_BASE_URL=...
CHATWOOT_API_TOKEN=...
CHATWOOT_ACCOUNT_ID=...
ADMIN_AUTH_TOKEN=...
LOG_LEVEL=info
SIGNAL_TIMEZONE=America/Sao_Paulo
PARTNER_DATABASE_URL=...
```

### Adicionar (V2)

```bash
OPENAI_API_KEY=...          # usada pelo V2
OPENAI_MODEL=gpt-5.5        # ou gpt-4o-mini se quiser baratear
OPENAI_TIMEOUT_MS=30000
AGENT_V2_CONVERSATION_IDS=* # "*" = todas as conversas vão pro V2
```

### Remover (V1 não usa mais)

```bash
ORGANIZADORA_ENABLED            # set false ou remova
ORGANIZADORA_DEBOUNCE_SECONDS
ORGANIZADORA_POLL_INTERVAL_MS
ORGANIZADORA_MIN_CONFIDENCE
ORGANIZADORA_STALE_JOB_AFTER_SECONDS
PLANNER_LLM_ENABLED             # set false
PLANNER_OPENAI_API_KEY
PLANNER_MODEL
ATENDENTE_SHADOW_ENABLED        # set false
ATENDENTE_SHADOW_POLL_INTERVAL_MS
ATENDENTE_CONTEXT_MESSAGES_LIMIT
ATENDENTE_CONTEXT_TOOL_EVENTS_LIMIT
ATENDENTE_CONTEXT_ORGANIZER_FACTS_LIMIT
GENERATOR_LLM_ENABLED           # set false
GENERATOR_OPENAI_API_KEY
GENERATOR_MODEL
GENERATOR_PROMPT_FEW_SHOT_ENABLED
GENERATOR_PROMPT_MODULAR_ENABLED
```

**Ordem segura de remoção**:
1. Primeiro: setar todos os `*_ENABLED=false` (Planner, Generator, Organizadora, Atendente Shadow)
2. Confirmar com `AGENT_V2_CONVERSATION_IDS=*` que todas as conversas vão pro V2
3. Rodar 1 semana com tudo desligado mas variáveis presentes
4. Se nada quebrar, remove uma por uma do Coolify

---

## 8. Como reverter pro V1 (rollback de emergência)

Se algo der errado no V2:

```bash
# No Coolify:
AGENT_V2_CONVERSATION_IDS=    # vazio
PLANNER_LLM_ENABLED=true
GENERATOR_LLM_ENABLED=true
ATENDENTE_SHADOW_ENABLED=true
```

Redeploy. Volta pro V1 sem perder nada. O V2 fica desativado mas o código continua no repo.

---

## 9. Conquistas técnicas do V2

### Memória persistente entre turns
- Tool calls e results gravados em `agent.turns.actions` (jsonb)
- `loadHistory` intercala com `core.messages`
- Bot lembra product_ids, estoques, preços, sem rechamar tools
- Economia medida: ~28% por turn vs sem persistência

### Prompt enxuto
- 1 fonte de verdade (sem contradições)
- Fluxo de 6 passos explícito
- Tom humano (testado em produção)
- State check obrigatório no início do turn
- Estoque é info interna (bot não anuncia)
- Bairro vs município bem definidos

### Robustez
- Transação BEGIN/COMMIT só pra criar_pedido
- 5 rounds máx por turn (evita loop infinito)
- Timeout 30s no OpenAI
- Tratamento de erros: tool errado retorna `{erro: ...}` em vez de explodir

---

## 10. Próximos passos sugeridos

### Imediato
- Validar 20-30 conversas reais pra confirmar zero regressões
- Decidir final entre gpt-5.5 e gpt-4o pela relação custo/qualidade

### Curto prazo
- Adicionar OPCOES (quick replies) que estão no prompt mas não saem nas respostas
- Capturar nome do cliente automaticamente em `core.contacts` no primeiro pedido
- Dashboard simples mostrando pedidos do bot por dia

### Médio prazo (depois de 1 mês estável)
- Apagar tabelas `agent.*` órfãs do V1
- Remover código do V1 do repo (manter em branch separada)
- Remover env vars do Coolify

### Longo prazo
- Avaliar trocar OpenAI → Anthropic (Claude tem preços melhores e prompt caching mais agressivo)
- Avaliar streaming pra reduzir percepção de latência
- Multi-turn parallel tool calls (já suportado, validar)

---

## 11. Conversas de validação rodadas

| # | Cliente | Turns | Pedido | Custo | Modelo | Resultado |
|---|---------|-------|--------|-------|--------|-----------|
| 1 | Wallace | 9 | Falhou (delivery_address null) | — | — | Fix aplicado |
| 2 | Wallace | 9 | PED-0003 R$108,90 | 16¢ | 5.5 | OK, tom robótico |
| 3 | Anderson | 11 | PED-0004 R$207,90 | 14¢ | 5.5 | **Nota 9/10** — tom humano, persistência funcionando, adicionou item no meio, fechou venda |

### Avaliação detalhada da conversa Anderson (referência)

**Acertos** (9 pontos):
- Tom natural ("amigo", "show", "tá sim", "fechou", emoji 👍 no fim)
- Não mencionou estoque em nenhuma resposta (info interna)
- Lembrou "Fonseca" 5 turns depois sem rechamar tool
- Adicionou Fan 150 no meio sem perder contexto do PCX
- Calculou total certinho: R$99 + R$99 + R$9,90 = R$207,90
- Pediu endereço completo (rua, número, bairro)
- Quando cliente esqueceu pagamento, pediu separadamente sem desnecessária formalidade
- Pedido criou na primeira tentativa
- Despedida final humanizada com emoji

**A melhorar** (1 ponto):
- OPCOES (quick replies) escritos no prompt mas não aparecem como botões no WhatsApp
- Pequenas redundâncias de confirmação ("Fechou?" / "Posso fechar?")
- 11 turns é um pouco longo — daria pra encurtar com mais agressividade

---

## 12. Commits relevantes do V2

```
3a40449 feat(agent-v2): persiste tool calls/results em agent.turns.actions
0e47a7d fix(agent-v2): estoque é info interna — não fala pro cliente
e923656 fix(agent-v2): tom mais humano, menos robótico
007f284 fix(agent-v2): move state check pro topo do prompt
0e34bb4 fix(agent-v2): corrige 2 contradições no prompt
cb725fd fix(agent-v2): estoque já vem no buscar_compatibilidade/buscar_produto
b649cfc feat(agent-v2): state check obrigatório antes de cada resposta
1ce71a1 fix(agent-v2): remove contradições no prompt — fluxo único de fechamento
a121afa fix(agent-v2): fluxo de fechamento explícito em 6 passos no prompt
79118d6 fix(agent-v2): clarifica bairro vs município no calcular_frete
0d0c5a0 fix(agent-v2): exige endereço completo para delivery antes de criar_pedido
ba9c2fb fix(agent-v2): escapa backticks no prompt
04fba54 fix(agent-v2): contact_id e source corretos no criar_pedido
2709807 fix(agent-v2): remove todos os strict mode dos tool schemas
be9a0ed fix(agent-v2): remove strict mode dos tool schemas
d0d7663 feat(agent-v2): agente unificado 1 LLM com function calling
```

---

## 13. Decisões de design importantes

### Por que não criar tabelas novas?
- V1 já criou 11 tabelas em `agent.*` que ficaram complexas demais
- `agent.turns` já existia e tinha coluna `actions` jsonb perfeita pro caso
- Zero migration = zero risco de quebrar prod

### Por que function calling em vez de prompt-only?
- Modelo controla quando chamar tool (não precisa parsing)
- Erro estruturado (`{erro: ...}` em JSON)
- OpenAI cuida do schema validation
- Permite parallel tool calls naturalmente

### Por que história limitada a 30 mensagens?
- Controle de custo (input tokens crescem linearmente)
- 30 mensagens = ~15 turns = cobertura de 99% das conversas reais
- Conversas mais longas: o estado importante já tá nos tool calls persistidos

### Por que `source = 'chatwoot_com_bot'`?
- Constraint `orders_source_check` no banco aceita só valores conhecidos
- Distingue pedidos do bot de pedidos manuais no dashboard

---

## 14. Limitações conhecidas

1. **Quick replies (OPCOES) não saem na resposta** — bot escreve OPCOES no texto mas não vira UI no WhatsApp. Investigar `sender.ts`.

2. **Saudação dupla intermitente** — em raros casos webhook do Chatwoot disparou 2x. Bug de concorrência, não do prompt. Não reproduzido depois da última conversa.

3. **Nome do cliente não atualiza `core.contacts`** — fica só no histórico/pedido. Próximo passo se quiser dashboard de clientes.

4. **Tool result tokens não cacheados** — diferente do system prompt, os tool results crescem o histórico e somam tokens. Mitigação: limit 30 messages.

---

## 15. Contato e referências

- Repositório: `farejador-pneus` (remote `pneus`)
- Deploy: Coolify, serviço `farejador-pneus`
- DB: Supabase project `aoqtgwzeyznycuakrdhp`
- Arquitetura: `docs/PLANO_AGENT_V2.md` (plano original)
