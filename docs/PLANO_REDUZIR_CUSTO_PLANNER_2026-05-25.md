# Plano — Reduzir custo do Planner (5.5) em ~60%

**Data:** 2026-05-25
**Autor:** Claude (Anthropic, Opus 4.7)
**Alvo:** cortar 55-65% do custo do Planner sem trocar de modelo, sem mexer em Generator (5.4) nem Organizadora (5.4-mini), sem classificador por regex.

---

## Parte 1 — Explicação pra leigo (pra você, dono do projeto)

### O que tá caro hoje

Só o **Planner** roda em `gpt-5.5`. Ele é o LLM que decide, a cada mensagem do cliente, **qual habilidade usar** (ex.: "buscar produto", "responder logística", "fechar pedido"). O resto (Generator que fala com o cliente, Organizadora que extrai dados) tá em modelo mais barato — não vamos mexer.

O `gpt-5.5` cobra **$30 por milhão de tokens de saída** (6× mais caro que o 5.4-mini). E ele tem uma característica nova: **gasta tokens "pensando" antes de responder** (chamados *reasoning tokens*). Por padrão, ele pensa MUITO (effort = medium). Pra conversa de loja de pneus, é exagero.

### Os 4 botões que vamos mexer

| botão | o que faz | analogia |
|---|---|---|
| `reasoning.effort` | controla quanto a IA "pensa" antes de responder | igual quando você reflete muito vs. responde no automático |
| `text.verbosity` | controla quão **longa** é a resposta | igual escrever um relatório vs. um post-it |
| Regras de parada no prompt | "não chame a mesma ferramenta 2× se já tem o resultado" | igual avisar pra IA não ficar perguntando coisa repetida |
| Limite de histórico de ferramentas | quantas chamadas anteriores ela vê no contexto | igual mostrar só os últimos 3 emails da thread, não os 20 |

### Por que dá certo sem regex (sem classificar a mensagem)

Antes, eu sugeri: "se cliente mandar 'obrigado', pula o Planner". Isso é frágil — a regex erra fácil ("obrigado pelo desconto, vou querer mesmo!" não é simples ack).

Solução melhor que descobri lendo a doc da OpenAI: a própria IA tem um modo `effort = 'none'` (pensa quase nada). Em vez de pular ela, deixamos ela ATIVA mas **no modo mais leve**. Mesma economia, sem código frágil.

E pra escolher entre `none / low / medium`, usamos uma informação que **já existe no contexto**: a habilidade do turn anterior. Se o turn passado foi um "responder geral", o atual provavelmente também é simples. **Lookup numa variável**, não parse da mensagem do cliente.

### Quanto vamos economizar (estimativa honesta)

| ação | corta quanto do Planner |
|---|---|
| `reasoning.effort` dinâmico | -40% |
| `text.verbosity='low'` | -15 a -20% |
| Regras de parada no prompt | -5 a -10% |
| Cortar histórico de tools | -5% |
| **Total combinado** | **~55-65%** |

**Tradução em dinheiro:** se hoje o Planner gasta R$ 1,00 por conv-teste de 13 turns, depois desse plano gasta R$ 0,35-0,45.

### Riscos honestos

- Qualidade pode cair um pouquinho em **casos sutis** (cliente fala 3 motos diferentes ao mesmo tempo, com pivots). Improvável quebrar — Planner tá com confidence 0.92+ na maioria.
- Se quebrar, **revert em 1 commit** volta tudo ao normal. Sem dor.
- `text.verbosity=low` pode deixar o `rationale` (campo de explicação) mais curto — você perde um pouquinho de auditoria, mas as decisões em si continuam iguais.

---

## Parte 2 — Plano técnico (pra outra LLM executar)

### Resumo executivo

| campo | valor |
|---|---|
| Arquivos modificados | 3 |
| Linhas alteradas | ~40 |
| Tempo estimado | 2-3h |
| Reversível | sim, 1 commit revert |
| Testes esperados | 485/485 verdes |
| Risco | baixo |

---

### Passo 1 — Centralizar helpers em `src/shared/llm-clients/openai.ts`

Hoje `isReasoningModel` e `supportsCustomTemperature` estão **duplicados** em `planner/service.ts` e `generator/service.ts`. Mover pra módulo compartilhado.

**Adicionar no FINAL de `src/shared/llm-clients/openai.ts`:**

```typescript
/**
 * Reasoning models (gpt-5.x, o1, o3) aceitam reasoning.effort.
 * NÃO aceitam temperature customizada.
 */
export function isReasoningModel(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return /^(gpt-5|o1|o3)(?:$|[-_.])/.test(normalized);
}

export function supportsCustomTemperature(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return /^(gpt-4o|gpt-4\.1)(?:$|[-_])/.test(normalized);
}
```

---

### Passo 2 — Atualizar tipo de opções e função `callOpenAIResponse`

**No mesmo arquivo `src/shared/llm-clients/openai.ts`:**

#### 2.1 — Adicionar campos no tipo `OpenAIResponseCallOptions`

```typescript
export interface OpenAIResponseCallOptions {
  apiKey: string;
  model: string;
  messages: OpenAIMessage[];
  timeoutMs: number;
  maxTokens?: number;
  temperature?: number;
  /**
   * gpt-5.x: 'none'|'low'|'medium'|'high'|'xhigh'.
   * 'none' = quase 0 reasoning. 'low' = balanceado. 'medium' = default OpenAI.
   * Modelos não-reasoning ignoram.
   */
  reasoning?: { effort: 'none' | 'low' | 'medium' | 'high' | 'xhigh' };
  /**
   * gpt-5.x: 'low'|'medium'|'high'. Controla concisão do output.
   * 'low' corta ~20% dos tokens de resposta. Modelos não-reasoning ignoram.
   */
  text?: { verbosity: 'low' | 'medium' | 'high' };
  jsonSchema?: { name: string; schema: unknown; strict?: boolean };
}
```

#### 2.2 — Propagar pro `requestBody`

Localizar a função `callOpenAIResponse` e o ponto onde monta `requestBody`. Adicionar:

```typescript
const { apiKey, model, messages, timeoutMs, maxTokens = 2000,
        temperature, reasoning, text, jsonSchema } = options;

// ... requestBody existente ...

if (temperature !== undefined) requestBody.temperature = temperature;
if (reasoning !== undefined) requestBody.reasoning = reasoning;
if (text !== undefined) requestBody.text = text;
```

---

### Passo 3 — Helper de effort dinâmico no Planner

**Arquivo:** `src/atendente/planner/service.ts`

#### 3.1 — Remover helpers locais

Procurar e DELETAR `function supportsCustomTemperature` e `function isReasoningModel` se existirem.

#### 3.2 — Importar centralizados

```typescript
import {
  callOpenAIResponse,
  isReasoningModel,
  supportsCustomTemperature,
} from '../../shared/llm-clients/openai.js';
```

#### 3.3 — Adicionar helper `effortForContext`

Antes da função principal do service, adicionar:

```typescript
/**
 * Escolhe reasoning.effort baseado na skill DO TURN ANTERIOR.
 * Não classifica mensagem do cliente — usa sinal já existente no contexto.
 *
 * - Turn anterior foi conversa social/escala → 'none' (próximo turn provavelmente trivial)
 * - Turn anterior foi tarefa média → 'low' (default balanceado)
 * - Primeiro turn da conv → 'low' (sem info anterior, vai no balanceado)
 *
 * Skills "complexas" (buscar_e_ofertar, fechamento) NÃO recebem boost — Planner
 * lida bem com confidence 0.90+ mesmo em low, segundo conv 608.
 */
function effortForContext(lastSkill: string | undefined): 'none' | 'low' {
  if (!lastSkill) return 'low';
  const triviais = ['responder_geral', 'escalar_humano'];
  return triviais.includes(lastSkill) ? 'none' : 'low';
}
```

> **Nota pra executor:** o `lastSkill` precisa vir do contexto. Procurar onde o contexto do Planner é montado (provavelmente `context-builder` ou similar) e ver se já tem essa info. Se não, extrair do último turn antes da chamada — **NÃO criar lógica nova de classificação, só ler o que já existe em `agent.turns.skill` do turno anterior**.

#### 3.4 — Usar na chamada `callOpenAIResponse`

```typescript
const result = await callOpenAIResponse({
  apiKey: env.PLANNER_OPENAI_API_KEY!,
  model: env.PLANNER_MODEL,
  messages,
  timeoutMs: env.OPENAI_TIMEOUT_MS,
  maxTokens: isReasoningModel(env.PLANNER_MODEL) ? 3000 : 800,
  temperature: supportsCustomTemperature(env.PLANNER_MODEL) ? 0 : undefined,
  reasoning: isReasoningModel(env.PLANNER_MODEL)
    ? { effort: effortForContext(lastSkill) }
    : undefined,
  text: isReasoningModel(env.PLANNER_MODEL)
    ? { verbosity: 'low' }
    : undefined,
  jsonSchema: {
    name: 'planner_output',
    schema: plannerOutputJsonSchema,
    strict: true,
  },
});
```

---

### Passo 4 — Stop rules e retrieval budget no prompt do Planner

**Arquivo:** `src/atendente/planner/prompts/` (procurar o system prompt principal — provavelmente `system.ts` ou similar).

Adicionar uma seção **antes** da descrição de skills/tools, formatada assim:

```markdown
# Stop rules (evitar trabalho redundante)

- NÃO chame `verificar_compatibilidade` se já existe resultado pra essa medida
  no `tool_results_history` do contexto atual.
- NÃO chame `buscar_estoque` 2× pra mesma medida no mesmo turn.
- Se já tem evidência suficiente pra decidir a skill, decida — não chame
  mais ferramentas "por garantia".
- Multi-moto: chame tools em paralelo (1 por moto), nunca em sequência
  pra mesma moto.

# Retrieval budget

- Máximo 3 ferramentas por turn.
- Se precisar de mais, escolha as 3 mais críticas e justifique no `rationale`.
```

> **Nota pra executor:** ler o prompt atual ANTES de adicionar — se já tem regra parecida, atualizar em vez de duplicar. Se o prompt já é longo, considerar se uma seção sobre redundância existe em outro lugar (em `tools.md`, por exemplo).

---

### Passo 5 — Cortar histórico de tools no contexto

**Arquivo:** `.env` (Coolify) ou `src/shared/env.ts` (default).

Localizar variável `ATENDENTE_CONTEXT_TOOL_EVENTS_LIMIT`. Se atualmente está em 5 ou mais, baixar pra **3**.

Se a variável não existe ainda no `.env` de prod, adicionar:

```
ATENDENTE_CONTEXT_TOOL_EVENTS_LIMIT=3
```

**Por quê:** input do Planner inclui histórico de chamadas de ferramentas anteriores. Em conv longa, isso vira KB de prompt repetido a cada turn. 3 eventos é suficiente pra contexto, sem inflar.

---

### Passo 6 — Build + testes + commit

```bash
npx tsc --noEmit
npm test  # esperado: 485/485 verdes

git add src/shared/llm-clients/openai.ts \
        src/atendente/planner/service.ts \
        src/atendente/planner/prompts/  # ou o arquivo específico do prompt

git commit -m "feat(planner): reduz custo do 5.5 via reasoning dinamico + verbosity + stop rules

Combina 4 alavancas pra cortar ~60% do custo do Planner sem trocar modelo:

1. reasoning.effort dinamico (none/low) baseado em last_skill do turn anterior
   - 'none' quando turn anterior foi responder_geral ou escalar_humano
   - 'low' nos demais casos (default balanceado)
   - Nao classifica mensagem do cliente, usa sinal ja existente
2. text.verbosity='low' em todas as chamadas (corta ~20% do output)
3. Stop rules no prompt: nao chamar tools redundantes, max 3 tools/turn
4. ATENDENTE_CONTEXT_TOOL_EVENTS_LIMIT 5->3 (input menor)

Generator (5.4) e Organizadora (5.4-mini) nao sao tocados.

Reversao: git revert HEAD. Sem outras mudancas estruturais.

Refs: docs/PLANO_REDUZIR_CUSTO_PLANNER_2026-05-25.md
Testes: 485/485 verdes, typecheck limpo."

git push pneus main
```

---

### Passo 7 — Como testar em prod

1. Redeploy Coolify com o commit
2. Apagar conv-teste no Chatwoot UI
3. Rodar a **mesma conv 608** (13 turns)
4. Comparar via SQL:

```sql
SELECT
  c.chatwoot_conversation_id,
  COUNT(t.id) AS turns,
  SUM(t.llm_input_tokens) AS input_total,
  SUM(t.llm_output_tokens) AS output_total,
  ROUND(SUM(t.llm_input_tokens + t.llm_output_tokens) / COUNT(t.id)::numeric, 0) AS avg_tokens_per_turn
FROM agent.turns t
JOIN core.conversations c ON c.id = t.conversation_id
WHERE c.chatwoot_conversation_id IN ('608', 'NOVA_CONV_ID')
  AND t.agent_role = 'planner'
GROUP BY c.chatwoot_conversation_id;
```

**Esperado:** output total cai 55-65% na conv nova vs. 608.

#### Checklist de qualidade (NÃO só tokens)

Comparar com a conv 608:

- [ ] Multi-moto ainda funciona em paralelo (turn 1 da nova conv)
- [ ] Aceite contextual ("Sim vou querer" → Sprint A) ainda dispara
- [ ] Geo-confirmação ainda acontece quando cliente dá bairro
- [ ] Total preemptivo aparece nos turns certos
- [ ] Sem turn entrando em loop pedindo info que já tem
- [ ] Nenhum turn nova com skill obviamente errada

Se TODOS marcados → manter. Se 2+ desmarcados → considerar voltar `verbosity` pra `medium` (manter `effort` dinâmico).

---

### Passo 8 — Como reverter se quebrar

```bash
git revert HEAD
git push pneus main
# Redeploy Coolify
```

Ou cirúrgico:
- Trocar `effortForContext(lastSkill)` por `'medium'` fixo
- Remover linha `text: { verbosity: 'low' }`

---

## Resumo do que vai mudar (diff por arquivo)

| arquivo | mudanças |
|---|---|
| `src/shared/llm-clients/openai.ts` | +2 helpers exportados, +2 campos no tipo, +2 linhas no requestBody |
| `src/atendente/planner/service.ts` | -2 helpers locais, +1 import, +1 função `effortForContext`, +2 linhas na chamada |
| `src/atendente/planner/prompts/*` | +seção "Stop rules" e "Retrieval budget" |
| `.env` (Coolify) | `ATENDENTE_CONTEXT_TOOL_EVENTS_LIMIT=3` |
| **Total** | **~40 linhas alteradas** |

---

## Validação final esperada

- ✅ `npx tsc --noEmit` sem erros
- ✅ `npm test` → 485/485 verdes
- ✅ Conv-teste de 13 turns: output do Planner cai 55-65%
- ✅ Checklist de qualidade: 6/6 itens passando
- ⚠️ Se algum item falhar, ajustar (verbosity pra medium, ou effort pra low fixo)

---

## Contexto pra outra LLM entender

Projeto **Farejador** — bot de cotação de pneus de moto rodando 3 LLMs:
1. **Planner** (`PLANNER_MODEL=gpt-5.5`) — decide skill+tools
2. **Generator** (`GENERATOR_MODEL=gpt-5.4`) — gera resposta ao cliente — **NÃO MEXER**
3. **Organizadora** (`OPENAI_MODEL=gpt-5.4-mini`) — extrai facts — **NÃO MEXER**

Custo do `gpt-5.5`: input cached $0.50/M, output **$30/M**. Output é o vilão real.

Reasoning tokens (do `effort`) contam como output. `effort='medium'` (default) gasta 800-1500 tokens só pensando. `low` cai pra 300-500. `none` cai pra ~0.

Combinando com `verbosity='low'` (corta o texto de resposta), economia composta.

**O bug do turn 8 (cart_id errado) é do Generator, NÃO toca aqui.** Esse fix é outro dia.

---

## Sobre o caller que vai aplicar

- Branch: pode ser direto em `main` (reversível em 1 commit)
- **Não mexer em Generator nem Organizadora**
- **Não criar regex de classificação de mensagem** — só usar `last_skill` do contexto
- **NÃO pular** `npx tsc --noEmit` e `npm test`
- Se teste falhar, investigar antes de prosseguir
- Push é pro remote `pneus` (não `origin`) — confirmar com `git remote -v`

---

**Fim do plano.**
