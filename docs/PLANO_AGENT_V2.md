# Plano técnico — Agent V2 (1 LLM)

**Data:** 2026-05-25
**Objetivo:** substituir Planner+Generator+Organizadora por 1 LLM unificado, preservando banco e código atual.

---

## 1. Arquitetura

```
WhatsApp → Chatwoot → webhook /webhooks/chatwoot
                          ↓
                  ┌───────────────┐
                  │  router.ts    │  decide V1 ou V2 por AGENT_V2_CONVERSATION_IDS
                  └───────┬───────┘
                          ↓
              ┌───────────────────────┐
              │  src/atendente-v2/    │
              │      agent.ts         │  1 LLM (gpt-5.4-mini)
              │                       │  function calling
              └──────────┬────────────┘
                         ↓
                  Tools (TypeScript)
                  ↓
              Postgres (catálogo + orders)
                  ↓
          Chatwoot API (envia resposta)
```

---

## 2. Arquivos novos

```
src/atendente-v2/
  agent.ts              # entrypoint, loop LLM + tool calls
  prompt.ts             # prompt único (~700 linhas)
  tools/
    buscar-produto.ts
    buscar-compatibilidade.ts
    calcular-frete.ts
    verificar-estoque.ts
    buscar-politica.ts
    criar-pedido.ts
    escalar-humano.ts
  chatwoot.ts           # envia msg + quick replies
  history.ts            # lê últimas 30 msgs de core.messages
  types.ts
```

**Arquivos a NÃO criar:** validators, planner, generator, organizadora, supervisora.

---

## 3. Fluxo de 1 turn

```typescript
// agent.ts (pseudocódigo)
async function handleMessage(conversationId, customerMessage) {
  const history = await loadHistory(conversationId, 30);

  const messages = [
    { role: 'system', content: PROMPT },
    ...history,
    { role: 'user', content: customerMessage },
  ];

  // Loop function calling
  while (true) {
    const response = await openai.chat.completions.create({
      model: 'gpt-5.4-mini',
      messages,
      tools: TOOLS,
      tool_choice: 'auto',
    });

    const choice = response.choices[0].message;

    if (choice.tool_calls) {
      // Roda tools em paralelo
      const results = await Promise.all(
        choice.tool_calls.map(runTool)
      );
      messages.push(choice);
      messages.push(...results);
      continue; // outra chamada com resultados
    }

    // Texto final → envia pro Chatwoot
    await sendToChatwoot(conversationId, choice.content, choice.quick_replies);
    await logTurn(conversationId, choice, response.usage);
    return;
  }
}
```

**Sem state machine. Sem slots. Sem skill selection.** LLM decide tool, recebe resultado, responde.

---

## 4. Tools (function calling)

| nome | input | retorna | tabela |
|---|---|---|---|
| `buscar_produto` | `{ medida?, marca?, modelo? }` | lista produtos | products + tire_specs + prices + stock |
| `buscar_compatibilidade` | `{ moto, ano? }` | medidas + produtos | vehicle_fitments + tire_specs |
| `calcular_frete` | `{ cep ou bairro+cidade }` | valor + zona | geo_resolutions + delivery_zones |
| `verificar_estoque` | `{ product_id }` | quantidade | stock_levels |
| `buscar_politica` | `{ topico: 'garantia' \| 'horario' \| ... }` | texto | store_policies |
| `criar_pedido` | `{ items, cliente, endereço, modalidade, pagamento }` | order_id + PED-XXXX | orders + order_items |
| `escalar_humano` | `{ motivo, resumo }` | ok | (só nota no Chatwoot) |

Cada tool é função TS que faz 1 SELECT/INSERT. Schema validado pela OpenAI (strict mode).

---

## 5. Prompt structure (`prompt.ts`)

```
# Identidade (30 linhas)
Você é atendente da [Loja]. Loja de pneus de moto em [cidade].
Tom: pt-BR coloquial, direto, sem floreio.

# Regras essenciais (40 linhas)
- Nunca invente preço/estoque — sempre use tool
- Confirme moto antes de cotar (use buscar_compatibilidade)
- Frete só com cep ou bairro+cidade
- Antes de criar pedido, confirme: nome, endereço/retirada, pagamento

# Quando usar cada tool (80 linhas)
[1-2 linhas por tool com gatilho]

# Quick replies (30 linhas)
Quando perguntar:
- Modalidade → ["Entrega", "Retirada"]
- Pagamento → ["Pix", "Cartão", "Dinheiro"]
- Moto ambígua → ["Fan 150", "Fan 160"]

# Exemplos (~400 linhas)
[10-12 exemplos cobrindo: cotação simples, múltiplas motos,
 objeção de preço, fechamento, frete fora de área, pedido cancelado]

# Stop rules (30 linhas)
- Se cliente pede humano → escalar_humano
- Se tool falhar 2x → escalar_humano
- Se confiança baixa → escalar_humano
```

**Total estimado:** 600-700 linhas, ~7k tokens. Cache hit alto (prefixo fixo).

---

## 6. Banco — uso da V2

**LÊ:**
- `core.conversations`, `core.messages`, `core.contacts`
- `commerce.products`, `tire_specs`, `vehicle_models`, `vehicle_fitments`
- `commerce.stock_levels`, `product_prices`
- `commerce.geo_resolutions`, `delivery_zones`, `store_policies`

**ESCREVE:**
- `commerce.orders`, `commerce.order_items` (quando fecha venda)
- `agent.turns` enxuto (custo + latência por turn — opcional)

**IGNORA (não lê nem escreve):**
- `agent.session_*`, `agent.cart_*`, `agent.order_drafts`, `agent.pending_confirmations`, `agent.escalations`, `agent.session_items`, `agent.session_slots`
- `analytics.*`, `ops.atendente_jobs`, `ops.bot_events`, `raw.*`

V1 continua escrevendo nas tabelas antigas (suas conversas reais). V2 não toca.

---

## 7. Rollout

**Fase 1 — código (5-7 dias):**
- D1-2: estrutura, history loader, 1 tool (buscar_produto), webhook router
- D3-4: tools restantes
- D5: prompt + exemplos
- D6: quick replies + criar_pedido
- D7: logs e métricas

**Fase 2 — teste isolado (3 dias):**
- Cria conversa de teste no Chatwoot
- Ativa `AGENT_V2_CONVERSATION_IDS=<id_teste>` no Coolify
- Você manda 10-20 mensagens variadas
- Ajusta prompt/tools com base no que falhar

**Fase 3 — produção gradual (1 semana):**
- Liga V2 pra 5 conversas reais
- Monitora `agent.turns` (custo, latência, erros)
- Se OK, liga pra 100%
- V1 fica no código 2 semanas como rollback

**Fase 4 — limpeza (opcional, 1 dia):**
- Deleta `src/atendente/`, `src/planner/`, `src/generator/`, `src/organizadora/`
- Apaga 15 env vars
- Tabelas `agent.*` ficam órfãs (não estorvam)

---

## 8. Custo estimado

| cenário | turns/dia | tokens/turn | $/dia | R$/mês |
|---|---|---|---|---|
| Hoje (3 LLMs) | 800 | 14k in + 2k out | $14.6 | R$ 440 |
| V2 (gpt-5.4-mini) | 800 | 8k in + 0.5k out | $2.0 | **R$ 60** |

Economia: **~R$ 380/mês** + menos bugs de coordenação.

---

## 9. Risco e mitigação

| risco | mitigação |
|---|---|
| LLM esquece contexto em conv longa | últimas 30 msgs sempre, resumo só se >50 turns |
| Tool errada chamada | `tool_choice: 'auto'` + few-shots cobrindo casos |
| Pedido criado com dados errados | confirmar antes via quick reply, dry-run em `agent.turns` antes de promover |
| Quebra produção | feature flag por conversation_id, V1 continua rodando intacta |

---

## 10. Critério de sucesso

V2 substitui V1 quando, em 50 conversas reais:
- ≥ 80% das vendas fecham sem intervenção humana (paridade com V1)
- Latência < 3s por turn
- Custo ≤ R$ 80/mês a 800 turns/dia
- Zero pedido criado com dados errados

Se algum critério falhar 2 semanas seguidas, **mantém V1**.
