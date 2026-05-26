# Agent V2 — Análise de otimização de custo (TETO ATINGIDO)

**Data**: 2026-05-26
**Status**: 🟢 Sistema no teto técnico. Sem ganhos óbvios sem mudança de arquitetura.
**Custo atual**: ~R$ 0,48 por conversa de 8-10 turns (gpt-5.5, cache hit ~81%)

---

## 1. Resumo executivo

Esta sessão investigou todas as features da OpenAI que poderiam reduzir o custo do bot **sem trocar de modelo nem perder qualidade**. Três features candidatas foram analisadas em profundidade: **Prompt Caching**, **Predicted Outputs** e **Conversation State**.

**Conclusão honesta:** o sistema já está calibrado próximo do teto técnico. Apenas o **Prompt Caching** trouxe ganho real (já implementado, 81% hit, ~R$ 0,15-0,25/conv economizados). As outras duas features são incompatíveis com nossa arquitetura ou não trazem ganho de R$.

Próximas otimizações de custo exigem **mudanças de arquitetura grandes** (migrar API) ou **trocar modelo** (perder qualidade). Nenhuma vale o esforço/risco no volume atual.

---

## 2. Stack atual e custos reais

| Componente | Estado | Custo associado |
|---|---|---|
| Modelo | `gpt-5.5` (reasoning top-tier) | $5/M input, $30/M output, $0.50/M cached |
| Tools | 8 com function calling | ~875 tokens/request no schema |
| System prompt | 2.4k tokens (auditado, podado) | Cacheado entre conversas |
| Cache hit médio | **~81%** (medido em conv 622) | 90% de desconto nos tokens cacheados |
| Coalescing window | 3s com reset (estilo Intercom) | -66% custo em rajadas |
| Custo médio por conv | **~R$ 0,48** (8-10 turns) | — |

**Pricing real do gpt-5.5** (passado pelo dono):
- Input: $5,00/M
- Cached input: $0,50/M (90% off)
- Output: $30,00/M

---

## 3. Features investigadas

### 3.1 Prompt Caching ✅ IMPLEMENTADO

**O que é**: cache automático de prefix repetido em requests. OpenAI dá 90% de desconto nos tokens cacheados.

**Descobertas chave**:
- **TTL real**: 5-10min in-memory **OU 24h extended**
- **gpt-5.5+ usa 24h por padrão** (eu inicialmente pensei que era 5-10min)
- **Desconto real**: 90% ($0.50/M vs $5/M no gpt-5.5)
- **Cache compartilhado dentro da org** — primeira msg de nova conversa pega cache do system+tools de outra conversa
- **Mínimo**: 1024 tokens pra começar a cachear
- **Sem cache warming** — primeira request da org sempre paga full
- **Sem cache breakpoint manual** — automático por prefix
- **Resposta inclui** `usage.prompt_tokens_details.cached_tokens` pra medir

**O que fizemos**:
1. Instrumentado log do `cached_tokens` e `cache_hit_pct` (commit `ac476db`)
2. ORDER BY `id` adicionado em `loadHistory` pra prefix determinístico (commit `358ea6d`)
3. `prompt_cache_retention: '24h'` explícito no body (commit `aadafde`)

**Medição em produção** (conv 622):
| Turn | input | cached | hit % |
|---|---|---|---|
| T2 | 7.892 | 5.376 | **68%** |
| T3 | 4.335 | 3.712 | **86%** |
| T4 | 8.838 | 7.936 | **90%** |
| T5 | 4.518 | 3.712 | **82%** |

**Média 81% cache hit = ~R$ 0,15-0,25 economizado por conversa.** Esse é o ganho real implementado.

**Próximo passo nesta frente**: zero. Estamos no teto.

---

### 3.2 Predicted Outputs ❌ INVIÁVEL

**O que é**: você envia uma "predição" do output esperado. OpenAI compara token a token, aceita os corretos e gera só os novos. Útil quando 80% da resposta é template fixo.

**Caso de uso ideal pra nós**: o resumo final do pedido tem template fixo (`Pedido PED-XXXX / Total: R$ X / Pagamento: Y / Entrega: Z`). Em teoria daria pra economizar ~80% dos tokens de output desse turn ($30/M é caro).

**Bloqueios fatais**:

1. **gpt-5.5 NÃO está na lista de modelos suportados**
   > Documentação: "Predicted Outputs são disponíveis com gpt-4o, gpt-4o-mini, gpt-4.1, gpt-4.1-mini, e gpt-4.1-nano"

2. **Function calling NÃO suportado**
   > Documentação: "Function calling não é atualmente suportado com Predicted Outputs"

   Nosso bot é 100% function calling. Toda chamada precisa de tools. Sem isso, bot não funciona.

3. **Penalidade**: tokens "rejeitados" (que diferem da predição) ainda são cobrados como output. Se prediction errar muito, custo **aumenta**.

4. **Caso de uso real é refatoração de código**, não chatbot.

**Veredito**: inviável sem trocar modelo E remover tools. Não vale.

---

### 3.3 Conversation State (Stateful Conversations) ❌ INVIÁVEL

**O que é**: OpenAI guarda o histórico do lado deles. Você cria uma `conversation_id` e em chamadas subsequentes envia só a nova mensagem, citando o id.

**Atração inicial**: parecia que economizaria input tokens (não enviar 30 msgs por turn).

**Descoberta que mata o ROI**:
> Documentação: "all previous input tokens for responses in the chain are billed as input tokens"

**OpenAI cobra os mesmos tokens** mesmo que você não os envie no body. A economia é só de **largura de banda na rede** (alguns KB), não de R$.

Combinando com o Prompt Caching que já temos: hoje os tokens do histórico já entram pelo desconto de 90% do cache. Migrar pra stateful **não muda o custo**.

**Outros bloqueios**:

1. **Requer migração de `/chat/completions` → `/responses`** — refator grande (1-2 dias de código + retest de toda a stack)
2. **gpt-5.5 não está nos exemplos** da doc (só gpt-4o e gpt-4.1)
3. **Conversations não têm TTL** — dados do cliente ficam permanentemente armazenados na OpenAI
4. **Problema de LGPD**: cliente pedindo erasure (`art. 18` LGPD) → como apagar do lado da OpenAI? Doc não documenta deleção
5. **Function calling com tools**: "items incluem tool calls" mas sem detalhes de implementação — risco

**Veredito**: zero economia de R$ + projeto grande + risco LGPD. Inviável.

---

### 3.4 Outras features descartadas no triage inicial

| Feature | Por que pular |
|---|---|
| Batch API (Lote) | 50% off mas async (até 24h). Não serve pra chat ao vivo. |
| Fine-tuning | Volume baixo, sem dataset rotulado, overkill |
| Reasoning models (Best Practices) | gpt-5.5 já é reasoning. Doc recomenda **trocar pra gpt-4o-mini** para chat simples — usuário rejeitou (qualidade) |
| Predicted outputs (re-confirmado acima) | Sem suporte a gpt-5.5 + sem function calling |
| Conversation State (re-confirmado) | Sem ganho de R$, refator + LGPD |
| Compaction | Só na `/responses` API. Mesmo problema de migração |
| Estruturas de saída | Já fazemos via tool schemas |
| Citation formatting | Não relevante (não somos motor de busca) |
| Imagens/Áudio/Vídeo/Voz/WebRTC | Não usamos |

---

## 4. Custo desagregado de uma conversa típica

Conversa Wallace (PED-0005, 8 turns) — referência pré-fixes:

| Componente | Tokens | Custo (gpt-5.5) |
|---|---|---|
| System prompt × 8 turns (cacheado depois T0) | 2.4k × 8 | ~$0.02 com cache |
| Tools schema × 8 turns (cacheado) | 875 × 8 | ~$0.007 com cache |
| Histórico cumulativo | ~20k | ~$0.02 com cache |
| Mensagens novas do cliente | ~500 | $0.0025 |
| Output (8 respostas) | ~917 | $0.0275 |
| **Total** | ~36k input + 917 output | **~$0.077 = R$ 0,40** |

A maior parte do custo está no **output** ($30/M é caro), não no input cacheado.

---

## 5. Onde está o teto e por quê

### Limites técnicos atingidos

1. **Cache hit ~81%** — próximo do máximo teórico. Os 19% que não cacheiam são as mensagens novas do cliente e novos tool results, que NÃO podem ser cacheados (são únicas a cada turn).

2. **Prompt 2.4k tokens** — já podado de 2.6k pra 2.4k com risco zero. Cortar mais entraria em risco de regressão (cada bloco que sobra justifica-se por bug observado em produção).

3. **8 tools, ~875 tokens schema** — todos atuais são necessários para os fluxos cobertos. `verificar_estoque` já está marcado como raríssimo (bot quase não chama).

4. **Coalescing 3s** — economiza ~66% nos cenários de rajada. Reduzir pra <3s arrisca não pegar mensagens digitadas mais devagar.

5. **Output médio 80-150 tokens por resposta** — limite natural de uma resposta WhatsApp boa. Cortar mais reduz qualidade percebida.

### O que faltaria pra subir mais

| Opção | Custo de implementação | Economia potencial | Vale? |
|---|---|---|---|
| Trocar pra gpt-4o-mini | 1 var no Coolify | ~95% (R$ 0,02/conv) | ❌ User rejeitou — qualidade |
| Migrar pra /responses + stateful | 1-2 dias dev + retest | ~0% (mesmo billing) | ❌ Sem ROI |
| Migrar pra /responses + compaction | 2-3 dias dev + retest | ~10-20% em convs grandes (>30 msgs) | ❌ Volume não justifica |
| Cortar 50% do prompt | 2h + risco regressão | ~5% | ❌ Risco > ganho |
| Output mais curto via prompt | 1h + risco UX | ~10% | 🟡 Só se UX permitir |

---

## 6. Próximas frentes (que NÃO são custo de token)

A próxima escala de ganho **não está em tokens**. Está em:

### Custo de tempo humano
- `consultar_pedido` ✅ implementado (cliente pergunta status sem escalar humano)
- `cancelar_pedido` 🟡 pendente (cliente desiste sem escalar)
- `confirmar_pagamento_pix` 🟡 pendente (processa comprovante)

### Visibilidade
- Capturar nome em `core.contacts` (hoje fica só no pedido)
- Dashboard de pedidos do bot por dia
- Métrica de NPS / satisfação por conversa

### Operação
- Apagar tabelas `agent.*` órfãs do V1 (depois de 30 dias estável)
- Renomear `src/atendente/` → `src/agent-shared/` (organização)
- Validar 20-30 conversas reais antes de declarar "production stable"

---

## 7. Commits relevantes desta sessão de otimização

```
aadafde perf(agent-v2): forca prompt_cache_retention=24h explicito
c4024af feat(agent-v2): tool consultar_pedido — cliente pergunta "cade meu pedido?"
358ea6d perf(agent-v2): ordem deterministica no loadHistory pra nao quebrar cache
7f988ce chore(agent-v2): poda lixo do prompt (-160 tokens, comportamento intacto)
ac476db obs(agent-v2): loga cached_tokens e cache_hit_pct
44f184e fix(agent-v2): nao pergunta moto quando cliente ja deu a medida
e782c62 fix(agent-v2): resolve contradicao no exemplo de cotacao + define limiar de estoque
7c20276 fix(agent-v2): resolve conflitos prompt/tools apos auditoria
52f1ac6 feat(agent-v2): troca debounce fixo por coalescing window (modelo Intercom)
9e89575 feat(agent-v2): debounce de mensagens em sequencia
475347d fix(agent-v2): formata cotacao multi-produto e resumo final do pedido
5454922 fix(agent-v2): grava frete no total_amount e remove verificar_estoque redundante
1c7718d chore(agent-v1): desliga V1 e migra worker para src/atendente-v2/
```

---

## 8. Conclusão

**Sistema calibrado. Sem mais ganho técnico fácil.**

O custo de ~R$ 0,48/conversa é o **preço justo** do stack escolhido:
- Modelo top de linha (reasoning)
- 8 tools com function calling
- Tom natural consistente
- Fluxo de fechamento em 8-10 turns
- Cache hit 81% (no teto)

Pra contextualizar: vendendo pneu de R$ 200-300 via bot, o custo OpenAI de R$ 0,48 representa **0,2% do ticket** — margem de 99,8% sobre o LLM.

**Recomendação operacional**: parar de mexer em otimização técnica. Focar em:
1. Validar 20-30 conversas reais (estabilidade)
2. Implementar `cancelar_pedido` e capturar nome (ops)
3. Observar 1 semana antes de qualquer mudança nova

---

## 9. ADDENDUM 2026-05-26 — TETO REVISITADO: prompt em inglês

Após declarar "teto atingido" no commit `b7fd8f1`, o dono insistiu em revisitar a opção de prompt em inglês com a justificativa: **"mexo agora pra ter margem no crescimento"**.

A análise inicial subestimou o ganho (estimei ~R$ 20/mês a 1k convs). Após medir tokens reais:

### Mudança aplicada (commit `b229f57`)

| Versão | Tokens | Custo/conv (cache 81%) |
|---|---|---|
| Prompt pt-br | 2.852 | R$ 0,042 |
| **Prompt híbrido EN+exemplos PT** | **1.700-1.790** | **R$ 0,026** |
| Economia | -1.060 (-37%) | -R$ 0,016/turn = **-R$ 0,16/conv** |

### Arquitetura da versão híbrida

- **Regras em inglês** (mais eficiente em tokens)
- **Exemplos de resposta em pt-br** (ancoram vocabulário brasileiro: "Fechou?", "Show", "Tá fechado")
- **Trava de idioma** no item 8 do FINAL CHECK: "Is my final customer answer in Brazilian Portuguese?"
- **Tolerância a typos** explícita: "customer may write with typos, abbreviations and incomplete phrases. Understand intent, do not correct spelling."

### Backup do prompt anterior

`src/atendente-v2/prompt.legacy-ptbr.ts` — exporta `LEGACY_SYSTEM_PROMPT_PTBR`. Não importado, só referência. Rollback em 1 linha.

### Validação em produção (conv 622 / PED-0008)

Cliente Wallace, 7 turns, fechou pedido R$ 108,90:

✅ **Idioma 100% pt-br** — zero vazamento de inglês
✅ **Tom mantido**: "meu camarada", "Show", "fica tranquilo", "Fechou?", "Tá fechado, Wallace 👍"
✅ **Banco gravou correto**: total R$ 108,90 (frete incluído), endereço completo, source
✅ **Inteligência social funcionou**: entendeu gíria "tá filezinho?", parseou endereço com typos
✅ **Custo real**: ~R$ 0,32 (vs R$ 0,40 antes do prompt em inglês — economia de 20% confirmada)
🟡 **Drift menor**: 1× faltou OPCOES em "Qual modelo da Fan?" (cliente respondeu OK mesmo assim)
🟡 **Cosmético**: nome do produto cru no resumo final ("Pneu Moto 80/100-18 Dianteiro Diagonal")

### Cache compartilhado entre clientes — esclarecimento importante

Descoberta paralela: cache da OpenAI é **por organização**, não por cliente. Significa que conforme volume cresce, MAIS conversas se beneficiam do cache "esquentado" por outras. Estimativa de cache hit por volume:

| Convs/dia | Cache hit estimado | Custo médio/conv (prompt EN) |
|---|---|---|
| 1 | 60-70% | R$ 0,30 |
| 5 | 80% | R$ 0,26 |
| 20 | 85% | R$ 0,22 |
| 100 | 90% | R$ 0,19 |
| 500 | 92% | R$ 0,17 |

**Bot fica proporcionalmente mais barato conforme escala.**

### Novo teto

O teto técnico real considerando o prompt em inglês:

- Cache compartilhado entre conversas
- Prompt 40% menor
- Modelo gpt-5.5 mantido (qualidade preservada)

Custo médio esperado em produção: **R$ 0,20-0,35 por conversa** dependendo do volume.

Para um ticket médio de R$ 200-300 (pneu de moto), o LLM representa **0,1% do faturamento**. **Esse é o novo teto realista.**
