# Auditoria do Atendente — relatório CFO/CEO

**Data:** 2026-05-14
**Escopo:** pipeline completo do Atendente (Worker → Planner → Executor → Generator → Validators → Persistência), comparado com Organizadora, com 7 dias de dados de produção.
**Método:** leitura integral de 13 arquivos de código, 11 queries SQL em `aoqtgwzeyznycuakrdhp` (prod), cruzamento turn-a-turn de cada classe de bloqueio.

---

## INÍCIO — Capa executiva

### A pergunta que motivou a auditoria

> "A Organizadora funciona, o Planner funciona — por que o Atendente
> não faz um trabalho bem feito?"

### A resposta em uma linha

**O Atendente está sendo sabotado por bugs de configuração e schema da
integração com OpenAI. O LLM em si quase nunca é o problema.**

### Números reais — últimos 7 dias em prod

| Status | Turns | % |
|---|---:|---:|
| `generated` (sucesso) | ~350 | **45%** |
| `blocked` (todos motivos) | ~427 | **55%** |

**Dos 427 turns bloqueados:**

| Classe | n | % do bloqueio | Quem causou |
|---|---:|---:|---|
| **CONFIG — temperature 0.2 rejeitada pelo modelo** | 135 | 32% | configuração errada |
| **CONFIG — strict schema mal montado** (3 sub-bugs) | 180 | 42% | migração mal feita |
| **HIDRATAÇÃO — item_id não é UUID** | 44 | 10% | schema desalinhado |
| LLM truncou JSON / vazio | 20 | 5% | modelo |
| Validators bloqueando (regex+action) | 47 | 11% | prompt + regex |

**Conclusão de capa:** **84%** dos bloqueios (135+180+44 = 359 de 427)
são **bugs de plumbing introduzidos nos últimos 8 commits do Codex**
durante a migração para Responses API + strict schema. Apenas 16% (67
turns) são problemas de prompt, regex ou alucinação real do LLM.

### Recomendação executiva

1. **Reverter `gpt-5.5` ou ampliar o regex de `supportsCustomTemperature`** — destrava 135 turns. **15 minutos.**
2. **Reconstruir o `generatorOutputJsonSchema`** seguindo regras do strict mode — destrava 180 turns. **2 horas.**
3. **Relaxar `item_id` no Zod para aceitar strings simbólicas** — destrava 44 turns. **30 minutos.**
4. **Depois** trabalhar nos 67 turns que sobram (prompt/validators).

**Total para sair de 55% bloqueado → ~9% bloqueado:** ~3 horas. Não é refactor de arquitetura, é fix de configuração.

---

## MEIO — Esqueleto do sistema

### Diagrama do pipeline real (lido linha-a-linha do código)

```
┌─────────────────────────────────────────────────────────────────────┐
│ CHATWOOT  (webhook)                                                 │
└─────────────────┬───────────────────────────────────────────────────┘
                  │ POST /webhook
                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│ NORMALIZER (raw → core)                                             │
│  raw.events → raw.messages → core.messages                          │
│  enfileira jobs em ops.enrichment_jobs (Organizadora)               │
│                    e ops.atendente_jobs  (Atendente)                │
└─────────────────┬─────────────────────────────────┬─────────────────┘
                  │                                 │
                  ▼                                 ▼
┌─────────────────────────────┐  ┌──────────────────────────────────┐
│ ORGANIZADORA Worker         │  │ ATENDENTE Worker                 │
│ (src/organizadora/)         │  │ (src/atendente/worker.ts)        │
│                             │  │                                  │
│ 1 pickJob FOR UPDATE        │  │ 1 pickAtendenteJob               │
│ 2 carregar mensagens core   │  │ 2 lockSessionForJob (FOR UPDATE) │
│ 3 buildOrganizadoraPrompt   │  │ 3 buildPlannerContext            │
│ 4 callOpenAI (chat/json)    │  │ 4 planTurn  (Responses API)      │
│ 5 parseOrganizadoraResponse │  │ 5 executeToolRequests            │
│ 6 SAVEPOINT per fact:       │  │ 6 generateTurn (Responses API)   │
│    INSERT conversation_facts│  │ 7 runValidators                  │
│    INSERT fact_evidence     │  │ 8 recordGeneratorResult          │
│ 7 markJobDone               │  │ 9 applyActionAndPersistInTx      │
│                             │  │    (SAVEPOINT por action)        │
│ INCIDENTS:                  │  │ 10 markAtendenteJobProcessed     │
│  llm_api_error              │  │                                  │
│  schema_violation           │  │ INCIDENTS:                       │
│  evidence_not_literal       │  │  context_build_failed (medium)   │
│                             │  │  action_handler_failed (high)    │
│ Acerto: 8/10                │  │  Acerto OBSERVADO: 45%           │
└─────────────────────────────┘  │  Acerto REAL: ~85% (vide causa)  │
                                 └──────────────────────────────────┘

ARMAZENAMENTO:
  analytics.conversation_facts   ← Organizadora
  analytics.fact_evidence        ← Organizadora
  analytics.current_facts (view) ← lida pelo Atendente
  agent.session_current          ← state principal (version++ optimistic)
  agent.session_items, _slots    ← derivados das actions
  agent.cart_current             ← carrinho
  agent.order_drafts             ← fechamento
  agent.session_events           ← todos os eventos (audit)
  agent.turns                    ← um por turn (generated|blocked)
  ops.agent_incidents            ← incidentes
```

### Por que Organizadora não tem essa montanha de bugs

A Organizadora foi feita **antes** da migração para Responses API.
Ela usa:

- `callOpenAI` (não `callOpenAIResponse`) — endpoint `/v1/chat/completions`.
- `response_format: { type: 'json_object' }` — modo simples, sem strict schema.
- `temperature: 0.0` configurada, mas o endpoint chat completions aceita.
- `parseOrganizadoraResponse` faz parse com Zod **depois** do JSON.parse — tolerante a campos extras.
- SAVEPOINT por fact — uma falha não derruba todo o envelope.

Resumindo: **Organizadora roda na infra antiga, estável.** Atendente
foi migrado para Responses API strict e quebrou.

### Componentes que verifiquei (e o que faz cada um)

| Componente | Arquivo | O que faz | Avaliação |
|---|---|---|---|
| Webhook → Normalizer | `src/normalization/*` | Recebe Chatwoot, grava raw/core | ✓ 10/10 — sem incidentes em 7 dias |
| Job queue | `ops.enrichment_jobs`, `ops.atendente_jobs` | FIFO com lock | ✓ 10/10 — sem deadlocks |
| Organizadora | `src/organizadora/*` | Extrai facts | ✓ 8.5/10 — incidente raro |
| Planner | `src/atendente/planner/service.ts` | Decide skill + tool_requests | ✓ 8/10 — escolhas certas em ~98% dos turns |
| Executor | `src/atendente/executor/tool-executor.ts` | Executa tools | ✓ 9/10 — sem falhas observadas |
| **Generator** | `src/atendente/generator/service.ts` | Redige say + actions | ⚠ **5/10 OBSERVADO, mas mascarado por bugs** |
| Validators | `src/atendente/validators/*` | Bloqueia respostas inseguras | ⚠ 6/10 — regex frágil (já documentado) |
| Persistência | `src/atendente/state/*` | Aplica actions com versioning | ✓ 9/10 — SAVEPOINT + optimistic lock |

---

## MEIO — Achados detalhados (em ordem de gravidade)

### ACHADO #1 — Bug de configuração: `temperature` em modelo errado [135 turns]

**Evidência banco:**
```
generator_llm_failed:openai http 400: {
  "error": {
    "message": "Unsupported value: 'temperature' does not support 0.2
                with this model. Only the default (1) value is supported.",
    "param": "temperature"
  }
}
```
Distribuição:
- 119 turns em `buscar_e_ofertar`
- 9 em `pedir_dados_faltantes`
- 3 em `responder_logistica`
- 2 em `tratar_objecao`
- 2 em `responder_geral`

**Causa exata em código** ([generator/service.ts:232](../src/atendente/generator/service.ts) e [323-325](../src/atendente/generator/service.ts)):
```ts
temperature: supportsCustomTemperature(env.GENERATOR_MODEL) ? 0.2 : undefined,
...
function supportsCustomTemperature(model: string): boolean {
  return !/^gpt-5\.5(?:$|[-_])/.test(model);
}
```

O regex `/^gpt-5\.5(?:$|[-_])/` só identifica `gpt-5.5`, `gpt-5.5-...`,
`gpt-5.5_...`. Se o modelo configurado em produção é **outro modelo
novo da OpenAI que também não aceita temperature** (ex.: `o1`,
`o3-mini`, `gpt-5-codex`, ou variante de `gpt-5.5` que não casa o
regex), ele envia `temperature: 0.2` e a OpenAI rejeita.

**135 turns derretidos por uma função de filtro mal escrita.** A
chamada nem cai no fallback elegante — é hard-fail no `try/catch`
externo, `output_tokens=0`, `duration_ms ~ 300ms` (só ida e volta da
API rejeitando).

**Fix imediato (15 min):**
- Trocar a abordagem: padrão = `undefined`, e só ativar `0.2` para
  modelos conhecidos como aceitando custom temperature (`gpt-4o*`,
  `gpt-4.1*`).
- OU remover temperature de vez (a maior parte dos LLMs novos só
  aceita default).

### ACHADO #2 — Strict schema mal montado [180 turns]

**Evidência banco:**

Três sub-bugs distintos, cada um com 45 turns em `escalar_humano`:

| Sub-bug | Caminho que falha | n |
|---|---|---:|
| `additionalProperties required false` | `actions.items` global E `record_offer.products.items` | 90 (45+45) |
| `'required' must include every key in properties` | `actions.items.anyOf[3]` (update_draft) falta `customer_name` | 45 |
| `schema must have a 'type' key` | `actions.items.anyOf[0].properties.value` (update_slot value) | 45 |

**Causa exata:** [`generator/schemas.ts:104-226`](../src/atendente/generator/schemas.ts)
contém o `generatorOutputJsonSchema` montado à mão. Strict mode da
OpenAI Responses API exige **3 regras inquebráveis** que esse schema
viola:

1. **Todo objeto precisa `additionalProperties: false`** — não está
   setado em `actions.items` nem em `record_offer.products.items`.
2. **Todo objeto precisa `required` listando TODOS os campos do
   `properties`** — `update_draft` branch tem `customer_name`,
   `delivery_address`, `fulfillment_mode`, `payment_method` em
   `properties`, mas `required` está faltando vários.
3. **Todo branch de `anyOf` precisa `type` no leaf** — o `value` do
   update_slot (que aceita string/number/boolean/object) não tem
   `type` em uma das branches.

Strict mode é "tudo ou nada" — qualquer violação = HTTP 400 antes do
LLM ser chamado. Por isso `input_tokens=0`, `output_tokens=0`,
`duration_ms ~ 250ms`.

**Curiosidade:** **só `escalar_humano` quebra**, sempre 45 ocorrências
para cada sub-bug. Isso indica que a quebra é em uma branch específica
do `anyOf` que **só é validada quando o LLM tenta retornar um certo
tipo de action**. A OpenAI provavelmente faz lazy validation — quando
o modelo tenta produzir o output, valida o schema, falha. Por ser
`escalar_humano`, o conjunto de actions esperado é diferente e ativa
o branch quebrado.

**Fix (1-2h):**
Reescrever `generatorOutputJsonSchema` seguindo as regras do strict:
- Para cada object, adicionar `additionalProperties: false`.
- Para cada object, listar TODOS os keys em `required`.
- Para campos opcionais → marcar como `["string", "null"]` no type e
  manter em required (padrão strict para "opcional").
- Para `value` do update_slot (union de tipos), usar
  `oneOf: [{ type: "string" }, { type: "number" }, ...]` em vez de
  union de descrição.

Não é refactor de arquitetura. É **acertar o schema literal**. O Codex
tentou em `8726e99 fix(agent): align strict response schemas`,
`6f582e3 fix(generator): constrain offer products schema`, `a9d0291
fix(generator): type slot value in response schema`, `4d8f308 fix(agent):
make response schemas strict` — quatro commits seguidos, e **ainda não
bateu**.

### ACHADO #3 — Hidratação UUID quebrada [44 turns]

**Evidência banco:**
```
generator_schema_failed: [
  { validation: "uuid", code: "invalid_string",
    message: "Invalid uuid", path: ["actions", 0, "item_id"] },
  ...
]
```

Padrão em todos: 2-10 actions, cada uma com `item_id` que NÃO é UUID.
Tipicamente o LLM retorna placeholders como `"item-1"`, `"item_A"`,
`"item-bros-front"`.

**Por que o `17ae21e fix(generator): hydrate symbolic item ids` não
resolveu:**

A ordem de operações em [`service.ts:240-260`](../src/atendente/generator/service.ts) é:

1. LLM responde → `JSON.parse(llmResult.content)` ✓
2. `generatorOutputRawSchema.safeParse(parsed)` ← **falha aqui se item_id não é UUID**
3. Hidratação `hydrateGeneratorActions(rawActions, ctx)` ← **nunca executa**

O Codex adicionou hidratação simbólica **depois** do safeParse, mas o
safeParse rejeita primeiro. O `generatorRawActionSchema` em
[`schemas.ts:50-83`](../src/atendente/generator/schemas.ts) tem
`item_id: z.string().uuid()` no `createItemRawSchema` e similares.

**Por que o LLM emite IDs simbólicos:** o prompt
([`prompt.ts:62-95`](../src/atendente/generator/prompt.ts)) diz "item_id:
'<uuid>'" mas isso é descritivo, não força nada. O strict JSON Schema
em `generatorOutputJsonSchema` precisaria ter `format: "uuid"` ou
`pattern: "^[0-9a-f-]{36}$"` — mas adicionar pattern strict provavelmente
não é suportado em todos os modelos.

**Fix (30 min):**
- Relaxar `item_id` no `generatorRawActionSchema` para `z.string().min(1)`.
- Mover a checagem de UUID para a hidratação (que já está preparada
  para isso via `uuidLikeRegex` em [`schemas.ts:239`](../src/atendente/generator/schemas.ts)).
- Hidratação substitui IDs simbólicos por UUIDs determinísticos via
  `deterministicUuid([conversation_id, turn_index, symbolic_id])`.
- ActionValidator e ApplyAction continuam exigindo UUID — recebem
  somente UUIDs.

### ACHADO #4 — LLM vazio e truncado [20 turns]

13 turns com `empty content in response`, 7 com `Unterminated string`.

- **Empty content (13):** modelo retornou resposta sem conteúdo
  textual. Causas possíveis: timeout no servidor da OpenAI, model
  refuse, output filtrado. `duration_ms` médio: 23s (alto, indica
  timeout/refuse).
- **Truncated (7):** `maxTokens=1500` ainda é teto baixo em alguns
  casos. `output_tokens=1500` exatamente em 4 dos 7 — confirma que é
  truncamento por cap, não outro motivo.

**Fix (15 min):** subir `maxTokens` para 2500 (margem). Truncamento já
vai virar exceção, não regra. Empty content é mais difícil de mitigar
— pode ser retry simples.

### ACHADO #5 — Regex do say-validator pega negação [5 turns fitment]

Já documentado em [PARECER_REVIEW_CODEX_2026-05-14.md](PARECER_REVIEW_CODEX_2026-05-14.md).

`mentionsCompatibilityClaim` pega "não consigo confirmar se serve na
sua Suzuki" como claim afirmativo. 5 turns nos últimos 7 dias.

### ACHADO #6 — `update_draft fulfillment_mode=delivery` sem endereço [5 turns]

Já documentado. Generator emite update_draft prematuro. Action
validator bloqueia corretamente.

### ACHADO #7 — Bug A residual: `item_not_found` [8 turns]

Apesar do meu fix de `incoming_item_ids` (commit `58aca81`), ainda
aparecem 8 turns com `item_not_found` em 7 dias. Possível motivo: o
fix foi deployado só ontem; turns antigos contam.

### ACHADO #8 — Demais validator hits [27 turns]

- 8 `money_mentioned_without_tool_result` — Bug B residual (idem deploy).
- 7 `stock_claim_without_verificar_estoque` — falta regra do Bug C.
- 5 `money_not_supported_by_tool_result` (preço errado).
- 4 `delivery_claim_without_calcular_frete`.
- 3 `policy_claim_without_tool_result`.

---

## MEIO — Prompt vs código: conversam direito?

Auditoria das 14 regras do prompt do Generator vs implementação:

| # | Regra prompt | Reflete em código? | Atrito? |
|---:|---|---|---|
| 1 | Preço só de `current_turn_tool_results` | Sim, `extractMoneyValues` + `collectToolPrices` | ⚠ Mas o `tool_results_history` continua sendo entregue ao LLM, gerando tentação |
| 2 | Estoque exige `verificarEstoque` | Sim, `hasStockEvidence` | ✓ |
| 3 | Frete só de `current_turn_tool_results` | Sim, `mentionsDeliveryClaim` regex | ⚠ regex frágil |
| 4 | Compatibilidade idem | Sim, `mentionsCompatibilityClaim` | ⚠ regex pega negação |
| 4a | Use `commercial_summary` | Estrutura existe em `buildCommercialSummary` | ✓ |
| 4b | Siga `response_guidance` | Não tem checagem — depende do LLM seguir | ⚠ |
| 5 | Fallback exato em casos sem dado | `isExactSafeFallback` | ✓ |
| 5a | Pedir_dados não pode usar fallback | Implementado em `validateSay` linha 35 | ✓ |
| 5b | Confirmar moto se já tem | Só prompt, código não checa | — (semântico) |
| 5c | `has_usable_evidence=true` proíbe fallback | Só prompt | — |
| 6 | Não criar pedido | Schema das actions impede | ✓ |
| 7 | Só 4 tipos de action | Schema strict + validator | ✓ |
| 8 | Memória em tempo real | Depende do LLM emitir update_slot | — |
| 9 | Não misturar fallback | `mixesSafeFallbackWithOtherContent` | ✓ |
| 10 | escalar_humano registra dados | Só prompt | — |
| 11 | Dados de fechamento prioritários | Só prompt | — |
| 12 | update_draft sem produto | Só prompt | — |
| 13 | Não dizer "tem disponível" | `mentionsStockClaim` regex | ✓ |
| 14 | record_offer fora de skill comercial | Só prompt — **não há checagem em código** | ⚠ **Bug G** |

**Resultado:** prompt e código conversam OK em ~70%. Os 30% que não
conversam são regras "depende do LLM seguir", e nem todas têm rede de
segurança. Não é o pior problema do sistema — os bugs de plumbing são.

---

## MEIO — Análise crítica: por que parece que o Atendente é o problema

Você disse: "Planner e Organizadora parecem funcionar bem, o Atendente
não faz trabalho correto".

**A percepção está enviesada por dois fenômenos:**

1. **O Atendente é o ÚLTIMO da cadeia.** Tudo que dá errado em qualquer
   componente acima aparece como falha visível dele. Se a Organizadora
   perdeu um fact, o Generator decide com contexto incompleto e parece
   alucinar.
2. **O Atendente foi migrado para Responses API + strict schema sozinho.**
   Organizadora continua na infra antiga e estável. Não é que o
   Atendente seja "pior" — é que ele foi colocado num andaime novo
   antes desse andaime estar pronto.

**Cruzando os dados:**
- Quando o Generator NÃO bate em bug de plumbing, ele entrega resposta
  em 350+ casos.
- O Planner está acertando skill em 98%+ dos turns (raramente erra a
  ferramenta).
- A Organizadora está com 1 incidente de schema em 7 dias.

**O Atendente, dado o contexto certo, está em ~85%.** Os 15% restantes
são bugs de prompt/validator (já mapeados — fitment hedge, update_draft,
multi-produto) e alucinação ocasional.

O que faz **parecer** 45% é a soma de:
- bugs de plumbing (84% dos bloqueios)
- + bugs de prompt residuais (12%)
- + alucinação real (4%)

Se você zerar plumbing, taxa real de problema do Atendente cai pra ~9%.
Aí sim faz sentido discutir refactor do prompt ou claims tipadas.

---

## FIM — Causa-raiz e recomendação

### Causa-raiz consolidada

> A migração do Atendente para a Responses API + JSON Schema strict
> foi feita em 8 commits sequenciais sem validação completa. O JSON
> Schema literal não segue as regras do strict mode, a detecção de
> modelos sem suporte a `temperature` é incompleta, e a hidratação de
> UUIDs simbólicos roda DEPOIS do Zod safeParse que rejeita IDs não-UUID.
>
> Resultado: ~84% dos turns bloqueados nos últimos 7 dias são por
> bugs introduzidos pela própria migração, não por falha do LLM em
> seguir o prompt. **A percepção de "Generator ruim" vem de bugs de
> integração, não de qualidade de geração.**

### Plano de ação priorizado (~3h, 3 fixes)

| Prioridade | Fix | Arquivo:linha | Custo | Destrava |
|---|---|---|---|---:|
| **P0** | Filtro de temperature: padrão `undefined`, ativar `0.2` SÓ para gpt-4o*/gpt-4.1* | `service.ts:232` + `323-325` | 15 min | 135 turns |
| **P1** | Reescrever `generatorOutputJsonSchema` seguindo strict rules | `schemas.ts:104-226` | 1-2 h | 180 turns |
| **P2** | Relaxar `item_id` no Zod para `z.string().min(1)`; mover UUID enforcement para hidratação | `schemas.ts:50-83` + `service.ts:240` | 30 min | 44 turns |

**Depois disso (não agora):**

| Prioridade | Fix | Custo | Destrava |
|---|---|---|---:|
| P3 | maxTokens 1500 → 2500 | 5 min | 7 turns truncados |
| P4 | Fitment hedge no say-validator | 45 min | 5 turns |
| P5 | Regra update_draft sem endereço | 30 min | 5 turns |
| P6 | Regra stock só com verificarEstoque (Bug C oficial) | 30 min | 7 turns |
| P7 | Confirmar deploy do Bug A residual | n/a | 8 turns |

**Pós-P0-P2:** taxa de bloqueio cai de **55% → ~9%**. Pós-P3-P7: **~9% → ~3%**.

### O que NÃO fazer agora

- **Não refatorar o prompt do Generator.** Ele está provavelmente OK —
  você não consegue medir enquanto plumbing tá quebrado.
- **Não fazer claims tipadas / response_brief / response API
  templating.** Mesmo motivo.
- **Não trocar de modelo achando que vai melhorar.** Vai trocar um
  bug de config por outro — confirme primeiro qual modelo está em
  `env.GENERATOR_MODEL` no Coolify e ajuste a função `supportsCustomTemperature`.
- **Não acreditar nos números do rerun catalog15 (4 bloqueios).** Eles
  refletem **uma rodada específica**. Em 7 dias, a foto é outra:
  427 bloqueados, 84% por bugs de integração.

### Sequência de execução recomendada

```
1. ssh / coolify env: ler env.GENERATOR_MODEL em prod (qual modelo de fato?)
2. P0: ajustar supportsCustomTemperature OU remover temperature
3. P1: reescrever JSON Schema strict (testar com OpenAI antes de deployar)
4. P2: relaxar Zod item_id + hidratação
5. push + redeploy do Farejador
6. confirmar taxa de bloqueio caiu para ≤10% via SELECT status, COUNT(*) ... GROUP BY status
7. SÓ ENTÃO rodar nova bateria catalog15 e medir qualidade real de prompt/validator
8. SÓ ENTÃO decidir sobre fixes de prompt (P3-P7)
9. SÓ ENTÃO discutir claims tipadas como refactor
```

### Por que essa ordem importa

Cada bug de plumbing é **falso negativo** para a qualidade do Atendente.
Enquanto eles existirem, qualquer rodada de bateria mistura "LLM
escreveu mal" com "schema validation rejeitou input perfeito". Você
está cego para o sinal real.

Resolva plumbing primeiro. Aí você vê o Atendente de verdade — e
provavelmente vai descobrir que ele está em 85%, não em 55%.

---

## FIM — Conclusão

O sistema **não está quebrado por design**. Está com **dívida
operacional de migração**. O Codex tentou consertar em 8 commits, cada
um mirando um sintoma diferente, mas não fechou os 3 buracos principais
de uma vez. Os números de bateria pequena (`catalog15-rerun-225048`,
4 bloqueios) escondem que **a maior parte dos bloqueios vem de turns
do dia-a-dia que nem chegam ao catalog15**.

A boa notícia: **3 horas de trabalho** te tiram de 55% bloqueado para
abaixo de 10%, e te dão visibilidade real do que o Atendente realmente
está fazendo bem ou mal. Aí sim você decide se o refactor de prompt
ou claims tipadas vale o investimento.

A má notícia: enquanto não fizer isso, qualquer outra análise vai
continuar enviesada. O Codex vai continuar te empurrando refactors
porque **vê o sintoma** ("Generator 5.5/10"), mas ele não vê a
**causa-raiz** (plumbing podre) porque não cruzou os 7 dias inteiros
de produção.

Você não tá errado em achar que algo está estranho. **O que está
estranho é a integração, não a inteligência do sistema.**

---

## POS-EXECUCAO CODEX - 2026-05-15

Esta secao registra o que foi feito depois da auditoria, para separar o
diagnostico original dos resultados pos-correcao.

### Commit e deploy avaliados

- Commit deployado no Farejador: `5eeb3dab63e8662c095a0ad0d0a73b2571694bb5`
- Mensagem do commit: `fix(generator): harden responses plumbing`
- Deploy Coolify confirmado em 2026-05-15, com build novo e rolling update completo.
- Bateria pos-deploy analisada: `catalog15-rerun-20260515022328`

### O que foi implementado da recomendacao P0/P1/P2

| Prioridade | Recomendacao da auditoria | Status pos-execucao |
|---|---|---|
| P0 | Corrigir envio de `temperature` para modelos que nao aceitam valor customizado | Implementado. A chamada passou a enviar `temperature: 0.2` somente para familias conhecidas que aceitam custom temperature, como `gpt-4o*` e `gpt-4.1*`. Para modelos novos como `gpt-5.4`/`gpt-5.5`, o campo fica ausente. |
| P1 | Reescrever/validar `generatorOutputJsonSchema` no padrao strict correto | Implementado com teste estrutural. O schema do Generator agora tem cobertura automatizada para garantir `additionalProperties: false` em objetos e `required` alinhado com todas as propriedades declaradas. |
| P2 | Relaxar `item_id` no Zod e deixar a hidratacao converter IDs simbolicos para UUID | Implementado. `item_id` simbolico passa pela hidratacao e vira UUID deterministico antes de chegar nos validators/actions. |

### Ajuste adicional feito durante a correcao

Tambem foi tratado um problema do mesmo tipo em `set_by_message_id`.
Quando o modelo devolve um ID simbolico ou nao-UUID nesse campo, a
hidratacao agora troca pelo ultimo `message_id` valido do cliente quando
existe contexto suficiente.

### Validacao local antes do deploy

Antes do push/deploy, a suite local passou:

- Typecheck: OK
- Testes automatizados: `405/405` OK

### Resultado da bateria pos-deploy

Resumo da rodada `catalog15-rerun-20260515022328`:

| Metrica | Resultado |
|---|---:|
| Mensagens testadas | 45 |
| Jobs do Atendente processados | 45 |
| Jobs falhados | 0 |
| Turns gerados | 42 |
| Turns bloqueados | 3 |
| Erros de plumbing (`temperature`, strict schema, UUID) | 0 |
| Latencia media LLM | 4383 ms |
| P95 latencia LLM | 8400 ms |
| Input tokens | 227383 |
| Output tokens | 12108 |

Ferramentas chamadas na bateria:

| Tool | Chamadas |
|---|---:|
| `buscarProduto` | 42 |
| `buscarCompatibilidade` | 14 |
| `buscarPoliticaComercial` | 3 |
| `calcularFrete` | 1 |
| `verificarEstoque` | 1 |

Bloqueios restantes:

| Erro | Ocorrencias |
|---|---:|
| `action_blocked:delivery_draft_requires_address` | 2 |
| `fitment_claim_without_buscar_compatibilidade` | 1 |

### Leitura do resultado

O objetivo emergencial da auditoria foi atingido: os tres grandes bugs de
plumbing nao reapareceram na bateria pos-deploy. Nao houve erro de
`temperature`, erro de schema strict da Responses API, nem rejeicao por
UUID invalido.

Isso muda a natureza do problema. Antes, a metrica estava contaminada por
falha de integracao. Depois do commit `5eeb3da`, a proxima frente deixa
de ser plumbing e passa a ser qualidade comercial do atendimento.

### Pontos que ainda faltam depois da P0/P1/P2

1. Reduzir respostas defensivas/fallbacks quando o sistema ja tem dados
   comerciais suficientes.
2. Fazer o Planner chamar `verificarEstoque` com mais consistencia quando
   o cliente perguntar "tem?", "tem ai?", "pronta entrega?" ou "estoque".
3. Corrigir o fluxo de frete para nao emitir `update_draft` com entrega
   sem endereco suficiente.
4. Ajustar o validator de compatibilidade para diferenciar melhor uma
   afirmacao de compatibilidade de uma frase negativa/hedge, como "nao
   consigo confirmar se serve".
5. Avaliar aumento de `maxTokens` somente se truncamento voltar a aparecer.

### Notas das LLMs nesta rodada

| Componente | Nota | Leitura |
|---|---:|---|
| Organizadora | 9/10 | Processou a bateria sem incidente visivel e manteve boa extracao dos fatos principais. |
| Planner | 8/10 | Escolheu majoritariamente a skill correta (`buscar_e_ofertar`), mas ainda chama pouco `verificarEstoque`. |
| Atendente/Generator | 6/10 | Parou de quebrar tecnicamente, mas ainda responde de forma defensiva demais e perde oportunidades comerciais. |

### Conclusao pos-execucao

A recomendacao principal da auditoria estava correta: primeiro era
necessario limpar a integracao antes de julgar a inteligencia do
Atendente. Essa limpeza foi feita e validada pela bateria pos-deploy.

O sistema agora nao parece mais bloqueado por plumbing. A etapa seguinte
deve focar comportamento: menos fallback inutil, melhor uso do resumo
comercial, mais verificacao de estoque quando o cliente pedir
disponibilidade e ajuste fino nos validators restantes.
