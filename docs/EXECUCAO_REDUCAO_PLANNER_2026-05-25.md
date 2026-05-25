# Execução — Redução de custo do Planner (5.5)

**Data:** 2026-05-25
**Branch:** main
**Plano original:** `docs/PLANO_REDUZIR_CUSTO_PLANNER_2026-05-25.md`
**Status:** ✅ aplicado, 485/485 testes verdes

---

## O que mudou (resumo executivo)

Quatro alavancas combinadas pra cortar ~55-65% do custo do Planner sem trocar modelo, sem mexer em Generator (5.4) nem Organizadora (5.4-mini), e **sem regex classificando mensagem do cliente**.

| alavanca | onde | efeito |
|---|---|---|
| `reasoning.effort` dinâmico (`none` / `low`) | `planner/service.ts` | -40 a -45% reasoning tokens |
| `text.verbosity = 'low'` | `planner/service.ts` (via helper) | -15 a -20% output tokens |
| Stop rules + Retrieval budget no prompt | `planner/prompt.ts` | -5 a -10% (evita tools redundantes) |
| `ATENDENTE_CONTEXT_TOOL_EVENTS_LIMIT` 5→3 | `env.ts` + `.env.example` | -5% input tokens |
| **Total combinado** | | **~55-65%** |

---

## Arquivos modificados

### 1. `src/shared/llm-clients/openai.ts`
- Adicionados 2 helpers exportados: `isReasoningModel`, `supportsCustomTemperature` (antes duplicados em `planner/service.ts` e `generator/service.ts`).
- Tipo `OpenAIResponseCallOptions` ganhou 2 campos opcionais: `reasoning?: { effort: 'none'|'low'|'medium'|'high'|'xhigh' }` e `verbosity?: 'low'|'medium'|'high'`.
- Função `callOpenAIResponse` propaga ambos pro `requestBody`:
  - `reasoning` vira `requestBody.reasoning`
  - `verbosity` é mesclado no `text` block já existente (`text.verbosity`)
- Modelos não-reasoning (gpt-4o, gpt-4.1) **ignoram** esses parâmetros — só são passados se o caller mandar, e a OpenAI ignora silenciosamente em modelos não-reasoning.

### 2. `src/atendente/planner/context-builder.ts`
- Adicionada query nova em `buildPlannerContext`:
  ```sql
  SELECT skill_name FROM agent.session_events
  WHERE environment = $1 AND conversation_id = $2 AND event_type = 'planner_decided'
  ORDER BY occurred_at DESC LIMIT 1
  ```
- Resultado vai pro novo campo `PlannerContext.last_skill?: string`.
- **Undefined no primeiro turn da conversa** (não há evento anterior). Demais turns trazem a skill decidida no turn imediatamente anterior.

### 3. `src/atendente/planner/service.ts`
- Removidos os helpers locais `isReasoningModel` e `supportsCustomTemperature` (agora importados de `shared/llm-clients/openai.js`).
- Adicionada função `effortForContext(lastSkill)`:
  - `responder_geral` ou `escalar_humano` → `'none'`
  - Demais skills + primeiro turn → `'low'`
- Chamada `callOpenAIResponse` no Planner agora passa:
  - `reasoning: { effort: effortForContext(context.last_skill) }` (só se modelo for reasoning)
  - `verbosity: 'low'` (só se modelo for reasoning)

### 4. `src/atendente/planner/prompt.ts`
- Adicionadas duas seções novas **antes de "CONTRATO DAS TOOLS"**:

  **STOP RULES** — evitar tools redundantes:
  - Não chamar mesma tool com mesmos inputs essenciais se já tem resultado em `recent_tool_results`
  - Não chamar `buscarCompatibilidade` 2× pra mesma combinação no mesmo turn
  - Não chamar `buscarProduto` 2× pra mesma medida_pneu
  - Multi-moto: paralelizar (1 tool por moto), nunca sequenciar

  **RETRIEVAL BUDGET**:
  - Máximo 3 tools por turn
  - Se precisaria de mais, é dado faltante → usar `pedir_dados_faltantes`

### 5. `src/atendente/planner/schemas.ts`
- Bump de `plannerPromptVersion` de `'planner_v1.2.8'` → `'planner_v1.2.9'` (sinaliza versão de prompt nova pra análise).

### 6. `src/shared/config/env.ts`
- `ATENDENTE_CONTEXT_TOOL_EVENTS_LIMIT` default: `'5'` → `'3'`

### 7. `.env.example`
- `ATENDENTE_CONTEXT_TOOL_EVENTS_LIMIT=5` → `ATENDENTE_CONTEXT_TOOL_EVENTS_LIMIT=3`

### 8. `tests/unit/atendente/planner/context-builder.test.ts`
- Ajustado pra refletir a nova query (4 queries em vez de 3).
- Verifica ordem: messages → tool_events → planner_decided → organizer_facts.
- Verifica que `context.last_skill` vem `undefined` quando não há decisão anterior.

---

## Validação aplicada

```
npx tsc --noEmit  → sem erros
npm test          → 485/485 passed (57 suítes)
```

---

## Como medir em produção

### 1. Redeploy

```bash
git add -A
git commit -m "feat(planner): reasoning dinamico + verbosity low + stop rules pra cortar custo 5.5"
git push pneus main
```

Redeploy no Coolify.

### 2. Rodar nova conv-teste

Apagar conversa Chatwoot UI. Rodar conv idêntica à 608 (mesmas 13 mensagens).

### 3. SQL pra comparar tokens

```sql
SELECT
  c.chatwoot_conversation_id,
  COUNT(t.id) AS turns,
  SUM((e.event_payload->>'input_tokens')::int) AS input_total,
  SUM((e.event_payload->>'output_tokens')::int) AS output_total,
  ROUND(AVG((e.event_payload->>'output_tokens')::int)) AS avg_output_per_turn
FROM agent.session_events e
JOIN core.conversations c ON c.id = e.conversation_id
WHERE c.chatwoot_conversation_id IN ('608', 'NOVA_CONV_ID')
  AND e.event_type = 'planner_decided'
GROUP BY c.chatwoot_conversation_id;
```

**Esperado:** output total cai 55-65% na conv nova vs. 608.

### 4. Checklist de qualidade

Comparar com conv 608 — todos esses comportamentos devem continuar:

- [ ] Multi-moto em paralelo (turn 1)
- [ ] Aceite contextual ("Sim vou querer" → Sprint A)
- [ ] Geo-confirmação quando cliente dá bairro
- [ ] Total preemptivo nos turns certos
- [ ] Sem loop pedindo info que já tem
- [ ] Nenhum turn com skill obviamente errada

**Se ≥ 2 itens regredirem:**
- Tentar primeiro: trocar `verbosity` de `'low'` pra `'medium'` (manter `effort` dinâmico)
- Se ainda regredir: encurtar lista de triviais em `effortForContext` (deixar só `escalar_humano`)
- Última opção: forçar `effort` fixo `'low'` removendo dinâmico

### 5. Reversão total se necessário

```bash
git revert HEAD
git push pneus main
# Redeploy Coolify
```

---

## Decisões e racionais

### Por que `effortForContext` usa `last_skill` em vez de regex?

Regex olhando texto do cliente (`/obrigado|valeu|blz/i`) falha em casos como "obrigado mas tenho outra pergunta" ou "blz, mas e o frete?". O sinal mais confiável de complexidade é o **assunto do turn anterior** — info que já está estruturada no banco (`agent.session_events.skill_name`).

### Por que só `responder_geral` e `escalar_humano` são triviais?

- `responder_geral`: cliente pergunta sobre loja (horário, endereço, montagem) — turns simples, sem decisão complexa.
- `escalar_humano`: cliente já saiu do automático ou pediu humano — Planner não tem trabalho real.
- Outras skills (incluindo `pedir_dados_faltantes`, `registrar_intencao`, `responder_logistica`) podem envolver pivot, raciocínio sobre estado, decisão de qual tool chamar — exigem reasoning. Por isso ficam em `'low'` (não `'none'`).

### Por que `verbosity` sempre `'low'` (não dinâmico)?

Output do Planner é JSON estruturado validado por schema. Verbosity só afeta o `rationale` (texto livre até 800 chars). `'low'` continua produzindo rationale legível, só mais conciso. Não há ganho em diferenciar verbosity por contexto.

### Por que cortar `tool_events_limit` de 5 pra 3?

Em conv longa (10+ turns), o histórico de tools repete muito conteúdo já refletido em `state.items` e `state.cart`. 3 eventos cobrem o contexto recente útil sem inflar input. Se algum bug aparecer por falta de contexto, dá pra subir a variável em prod sem redeploy.

### Por que NÃO subir Generator pra 5.5 (mesmo que reasoning ajudasse)?

Generator está em 5.4 (não-reasoning). 5.5 tem output 2× mais caro. Sair de 5.4 medium pra 5.5 com effort=low **não compensa** — output é o vilão real do custo, e 5.5 cobra mais por token mesmo com reasoning baixo. Generator continua no 5.4.

---

## Risco e limites conhecidos

- Reasoning `'none'` pode deixar Planner pior em casos sutis logo após turn social (ex.: cliente cumprimentou e na sequência mandou pedido complexo). Probabilidade baixa.
- `verbosity='low'` pode encurtar `rationale` a ponto de prejudicar auditoria pós-mortem. Aceitável — análise complexa pode rodar com effort temporariamente alto via override de env.
- `tool_events_limit=3` pode esconder evidência de tool de turn 4-5 atrás em conv muito longa. Mitigado pelo `state.items` e `state.cart` que carregam o resultado relevante.

---

## Próximos passos (não cobertos aqui)

- Bug do turn 8 da conv 608 (Generator removeu cart_item errado) — **outro fix**, não relacionado.
- Bug do claim_validator bloqueando total preemptivo — **outro fix**.
- Logar `reasoning_tokens` separado em `agent.session_events.event_payload` pra medição mais granular — melhoria futura.

---

**Fim da documentação de execução.**
