# Plano — Arquitetura de claims tipadas (eliminar regex do validator)

> **STATUS 2026-05-15: PARCIALMENTE IMPLEMENTADO** — ver `docs/adr/ADR-009-claims-and-few-shot.md`.
>
> Etapa 2 (claims) entregue no commit `408f058`, com **4 tipos de claim** em vez dos
> 13 planejados aqui:
> - `price` (substituiu `brand_quoted` parcialmente)
> - `stock_availability` (substituiu `stock_confirmed`)
> - `fitment` (substituiu `fitment_confirmed`)
> - `delivery_fee` (substituiu `freight_quoted`)
>
> SayValidator regex **NÃO foi removido** — continua como rede de segurança
> transitória. Quando adoção de claims atingir ≥80% sobre turnos comerciais
> (medida em produção), as regras redundantes do prompt e regex
> correspondentes do SayValidator podem ser retirados (Etapa 2 fase 2).
>
> Mais tipos de claim (`installments`, `discount`, `policy_quoted`, etc) podem
> ser adicionados conforme aparecerem em cenários reais. Por ora, validador
> existente cobre os 4 casos mais frequentes.
>
> Este plano permanece como documento de referência da visão completa.

## Objetivo

Eliminar **toda regex que classifica significado de texto** dos
validadores. O Generator passa a declarar explicitamente o que está
afirmando em `claims[]` tipadas. O validador compara claims com
evidência das tools de forma estrutural — sem ler português.

## Inventário do que morre

[`src/atendente/validators/say-validator.ts`](../src/atendente/validators/say-validator.ts) — 472 linhas, ~60 regexes que classificam significado:

| Função | Regexes | Destino |
|---|---:|---|
| `mentionsStockClaim` | 6 | **morre** — substituída por `claim.type === 'stock_confirmed'` |
| `detectBrandAvailabilityClaim` | 4 × 14 marcas | **morre** — `claim.type === 'brand_quoted'` com brand tipada |
| `mentionsDeliveryClaim` | 7 | **morre** — `claim.type === 'freight_quoted'` ou `'delivery_committed'` |
| `mentionsCompatibilityClaim` | 4 | **morre** — `fitment_confirmed` vs `fitment_pending` |
| `mentionsPolicyMeta` (hedge) | 6 | **morre** — não precisa mais detectar "vou verificar" porque LLM declara em `claim.type === 'ask_slot'` ou `'will_check'` |
| `detectInstallmentClaim` | 3 | **morre** — `claim.type === 'installments_quoted'` com `times` tipado |
| `detectPaymentMethodClaim` | 7+ | **morre** — `claim.type === 'payment_methods_offered'` com `methods[]` |
| `detectDiscountClaim` | 3+ | **morre** — `claim.type === 'discount_offered'` com `pct` |
| `mentionsPromotionOrGiftClaim` | 2 | **morre** — `claim.type === 'promotion_quoted'` |
| `mentionsCustomOfferClaim` | 2 | **morre** — `claim.type === 'custom_offer'` |
| `mentionsExchangeOrReturnClaim` | ~2 | **morre** — `claim.type === 'policy_quoted:exchange'` |
| `mentionsWarrantyClaim` | ~2 | **morre** — `claim.type === 'policy_quoted:warranty'` |
| `mentionsBusinessHoursClaim` | ~2 | **morre** — `claim.type === 'policy_quoted:hours'` |

**Total morto: ~60 regexes.** Restam **3** com função puramente extrativa, descritas abaixo.

## O que sobra (e por quê)

Três regexes apenas, todas de **extração**, nenhuma classifica intenção:

1. **`extractMoneyValues`** ([say-validator.ts:90-101](../src/atendente/validators/say-validator.ts)) —
   `/r\$\s*(\d+...)(?:,(\d{2}))?/gi`. Extrai valores monetários do `say`
   para **cross-check estrutural**: cada `R$ Y` no `say` precisa
   aparecer em `claims[*].price_amount` ou `claims[*].fee_amount`
   (com tolerância de 0.01). Isso pega o caso de LLM declarar
   `price=79` mas escrever "R$ 89" no say (alucinação).
2. **`normalizeText`** ([say-validator.ts:103-108](../src/atendente/validators/say-validator.ts)) —
   normaliza acentos/caixa. Não classifica nada, só pré-processa pra
   comparação exata com `SAFE_FALLBACK_SAY`.
3. **Fallback exato** ([say-validator.ts:110-119](../src/atendente/validators/say-validator.ts)) —
   `mixesSafeFallbackWithOtherContent` e `isExactSafeFallback`. Não é
   regex de NLU; é equality check com whitespace/punctuation tolerada.

A diferença é fundamental:
- **Hoje:** regex tenta inferir "o LLM afirmou X?" — falha em negação, ambiguidade, sinônimos.
- **Depois:** o LLM **declara** que afirmou X. Regex (mínima) só faz cross-check estrutural: "o número que ele declarou aparece no texto?".

## Schema `Claim` (TypeScript + Zod)

Union discriminada por `type`:

```ts
type Claim =
  // ---- evidência comercial confirmada ----
  | { type: 'product_quoted'; product_id: string; product_code?: string;
      tire_size?: string; price_amount?: number; }
  | { type: 'stock_confirmed'; product_id: string; quantity?: number; }
  | { type: 'fitment_confirmed'; moto_model: string; moto_year?: number; }
  | { type: 'freight_quoted'; bairro: string; fee_amount: number;
      eta_days?: number; }
  | { type: 'brand_quoted'; brand: string; product_id: string; }
  | { type: 'installments_quoted'; times: number; total_amount?: number; }
  | { type: 'discount_offered'; pct?: number; final_amount?: number; }
  | { type: 'policy_quoted'; category:
      'exchange' | 'warranty' | 'hours' | 'payment_methods' | 'promotion';
      details_ref: string; }

  // ---- declarações de pendência (NUNCA bloqueadas) ----
  | { type: 'stock_pending'; product_id?: string; }
  | { type: 'fitment_pending'; moto_model?: string; }
  | { type: 'freight_pending'; bairro?: string; reason?: string; }
  | { type: 'product_pending'; }
  | { type: 'will_check_with_attendant'; topic: string; }

  // ---- conversacional ----
  | { type: 'ask_slot'; slot:
      'moto_modelo' | 'moto_ano' | 'medida_pneu' | 'posicao_pneu'
    | 'bairro' | 'delivery_address' | 'forma_pagamento' | 'nome'; }
  | { type: 'acknowledge_closure_intent'; payment_method?: string; }
  | { type: 'escalate_to_human'; reason: string; }
  | { type: 'safe_fallback' };
```

### Regras de validação (estruturais, sem regex)

Cada `claim.type` tem **um validador determinístico**:

```ts
function validateClaim(claim: Claim, evidence: CurrentTurnEvidence): ValidationResult {
  switch (claim.type) {
    case 'product_quoted': {
      const p = evidence.products.find(p => p.product_id === claim.product_id);
      if (!p) return block('product_quoted_without_evidence');
      if (claim.price_amount !== undefined &&
          Math.abs(p.price_amount - claim.price_amount) > 0.01) {
        return block('price_mismatch');
      }
      return ok;
    }
    case 'stock_confirmed':
      if (!evidence.stockOk(claim.product_id)) return block('stock_confirmed_without_verificar_estoque');
      return ok;
    case 'fitment_confirmed':
      if (!evidence.fitmentMatches(claim.moto_model, claim.moto_year)) return block('fitment_confirmed_without_evidence');
      return ok;
    case 'freight_quoted':
      if (!evidence.freightCovers(claim.bairro, claim.fee_amount)) return block('freight_quoted_without_calcularFrete');
      return ok;
    case 'brand_quoted':
      if (!evidence.brandPresent(claim.brand, claim.product_id)) return block('brand_quoted_without_evidence');
      return ok;

    // Claims de pendência ou conversacionais: ZERO checagem.
    // Declarar pendência é sempre seguro.
    case 'stock_pending':
    case 'fitment_pending':
    case 'freight_pending':
    case 'product_pending':
    case 'will_check_with_attendant':
    case 'ask_slot':
    case 'acknowledge_closure_intent':
    case 'escalate_to_human':
    case 'safe_fallback':
      return ok;

    // Policy/installments/discount: estruturais via tool result.
    case 'installments_quoted':
      if (!evidence.policyCoversInstallments(claim.times)) return block('installments_quoted_without_policy');
      return ok;
    case 'discount_offered':
      if (!evidence.policyCoversDiscount(claim.pct)) return block('discount_offered_without_policy');
      return ok;
    case 'policy_quoted':
      if (!evidence.policyHas(claim.category, claim.details_ref)) return block('policy_quoted_without_evidence');
      return ok;
  }
}
```

### Cross-check `say` ↔ `claims` (única regex sobrevivente)

Depois de validar claims contra evidence, uma checagem final:

```ts
function crossCheckSayMatchesClaims(say: string, claims: Claim[]): ValidationResult {
  // Cada R$ Y no say deve aparecer em algum claim.price_amount ou fee_amount.
  const moneyInSay = extractMoneyValues(say);  // ÚNICA regex sobrevivente
  const declaredAmounts = new Set([
    ...claims.flatMap(c => 'price_amount' in c && c.price_amount !== undefined ? [c.price_amount] : []),
    ...claims.flatMap(c => 'fee_amount' in c && c.fee_amount !== undefined ? [c.fee_amount] : []),
    ...claims.flatMap(c => 'final_amount' in c && c.final_amount !== undefined ? [c.final_amount] : []),
    ...claims.flatMap(c => 'total_amount' in c && c.total_amount !== undefined ? [c.total_amount] : []),
  ]);
  for (const amount of moneyInSay) {
    if (![...declaredAmounts].some(d => Math.abs(d - amount) < 0.01)) {
      return block(`undeclared_money:${amount}`);
    }
  }
  return ok;
}
```

Isso pega o caso onde a LLM declara `price=79` em `claims` mas escreve
"R$ 89" no say (alucinação de número).

## Ações sintetizadas pelo código (Generator não emite mais)

Generator hoje devolve `{ say, actions[], rationale }`. Passa a devolver `{ say, claims[], rationale }`. **Actions são derivadas** por uma função pura:

```ts
function synthesizeActions(
  claims: Claim[],
  customerMessage: string,
  organizerFacts: OrganizerFact[],
  state: ConversationState,
  decision: PlannerDecisionResult,
): AgentAction[] {
  const actions: AgentAction[] = [];

  // 1) update_slot — derivado de organizer_facts novos vs state atual.
  //    Sem mais regras 8 e REGRAS DE MEMORIA no prompt.
  for (const fact of organizerFacts) {
    if (alreadyInState(state, fact)) continue;
    actions.push(asUpdateSlot(fact));
  }

  // 2) create_item — quando há claim.product_quoted com product_id novo.
  for (const claim of claims) {
    if (claim.type === 'product_quoted' && !state.items.some(i => hasOfferedProduct(i, claim.product_id))) {
      const itemId = deterministicItemId(claim.product_id, state.conversation_id);
      actions.push({ type: 'create_item', item_id: itemId, make_active: true });
    }
  }

  // 3) record_offer — para cada product_quoted, montar oferta com dados da tool.
  for (const claim of claims) {
    if (claim.type === 'product_quoted') {
      const itemId = resolveItemId(claim.product_id, state, actions);
      const product = decision.toolResultsByProduct[claim.product_id];
      actions.push({ type: 'record_offer', item_id: itemId, offer_id: uuid(), products: [product], expires_at: nowPlus(15min) });
    }
  }

  // 4) update_draft — apenas quando acknowledge_closure_intent + endereço completo.
  //    Bug B do delivery_draft_requires_address deixa de existir aqui:
  //    código só promove fulfillment_mode='delivery' se delivery_address presente.
  const closure = claims.find(c => c.type === 'acknowledge_closure_intent');
  if (closure) {
    const draft: UpdateDraftAction = { type: 'update_draft' };
    if (closure.payment_method) draft.payment_method = closure.payment_method;
    if (organizerFacts.find(f => f.fact_key === 'nome_cliente')) draft.customer_name = ...;
    const addr = organizerFacts.find(f => f.fact_key === 'delivery_address_full');
    if (addr) {
      draft.delivery_address = addr.fact_value;
      draft.fulfillment_mode = 'delivery';   // só promove com endereço completo
    }
    actions.push(draft);
  }

  return actions;
}
```

**O que isso elimina automaticamente:**

| Bug | Por que some |
|---|---|
| A — race `create_item` + `record_offer` mesmo turno | Código sempre emite `create_item` antes. Validador `incoming_item_ids` continua como rede de segurança mas não dispara. |
| B (delivery_draft) — `fulfillment_mode='delivery'` sem endereço | Código nunca promove pra `delivery` sem `delivery_address`. |
| G — `record_offer` em skill não-comercial | `synthesizeActions` recebe `decision.skill` e pula `record_offer` se skill ∈ {responder_logistica, responder_geral, escalar_humano}. |

## Como fica o prompt do Generator

Encolhe de 146 linhas pra ~50-60. Estrutura final:

```
Voce e o Generator da Atendente. Voce devolve JSON com say + claims + rationale.

SAY:
- Texto natural pro cliente, max 2000 chars.
- Voce escolhe o tom, escrita e ordem.
- Se nao tem nada confirmado pra dizer, use exatamente: "{SAFE_FALLBACK_SAY}".

CLAIMS:
Voce DEVE declarar cada afirmacao comercial relevante no array claims.
Se voce afirma preco/estoque/compatibilidade/frete, DECLARE como claim tipado.
Se voce NAO tem evidencia, declare claim de pendencia (ex.: fitment_pending).
Cada claim tem um type. Use os seguintes:

  product_quoted   { product_id, price_amount? }       — voce citou produto X / preco Y
  stock_confirmed  { product_id, quantity? }            — voce afirmou estoque
  stock_pending    { product_id? }                      — voce disse que estoque precisa ser confirmado
  fitment_confirmed { moto_model, moto_year? }          — voce afirmou que serve
  fitment_pending  { moto_model? }                      — voce disse que precisa confirmar compatibilidade
  freight_quoted   { bairro, fee_amount, eta_days? }    — voce informou frete
  freight_pending  { bairro?, reason? }                 — voce disse que precisa confirmar entrega
  ask_slot         { slot }                             — voce pediu um dado (medida, ano, bairro, etc.)
  acknowledge_closure_intent { payment_method? }        — cliente quer fechar e voce reconheceu
  will_check_with_attendant { topic }                   — voce vai escalar pra atendente

REGRA UNICA: tudo que voce dizer no say com cara de afirmacao comercial
PRECISA ter claim correspondente. Se nao tem evidencia em current_turn_tool_results,
declare pendencia em vez de afirmar.

Voce NAO precisa mais se preocupar com:
- update_slot / create_item / record_offer / update_draft (o codigo monta)
- Em qual skill voce esta (o codigo gerencia)
- Regras de "use a frase X, nao use a palavra Y" (declare claim correto, escreva natural)
```

Tudo: ~30-50 linhas. As regras 1-14 + REGRAS DE MEMORIA + os exemplos viram esse parágrafo curto.

## Migração — feature flag e rodada paralela

Não substituir de cara. Fases:

### Fase A — preparação (1 dia)
- Definir `Claim` schema (TS + Zod) em `src/shared/zod/claim.ts`.
- Implementar `validateClaims(claims, evidence)` em `src/atendente/validators/claims-validator.ts`.
- Implementar `synthesizeActions(claims, ...)` em `src/atendente/generator/synthesize-actions.ts`.
- Implementar `crossCheckSayMatchesClaims(say, claims)`.
- Testes unit cobrindo cada `claim.type`: válido + inválido.

### Fase B — Generator dual-output (1 dia)
- Atualizar prompt do Generator pra **devolver `claims[]` em paralelo** com `actions[]` (não tira `actions` ainda).
- Atualizar schema strict do Responses API.
- Em `runValidators`, rodar **dois pipelines**:
  - Atual (regex + action-validator)
  - Novo (claims-validator + cross-check)
- Logar discrepâncias em `agent.session_events` (`event_type='claims_dual_audit'`).
- Manter env `GENERATOR_CLAIMS_MODE` com valores: `off | shadow | enforced`.

### Fase C — Sombra (~1 rodada de bateria)
- `GENERATOR_CLAIMS_MODE=shadow`.
- Validator antigo continua mandando. Novo só registra.
- Rodar `catalog15` e analisar:
  - Quantos turns o validador novo bloquearia vs o antigo?
  - Quais claims o Generator esquece de declarar?
  - Quais discrepâncias entre `actions` (que ele emitia) e `synthesizeActions(claims, ...)`?

### Fase D — Cutover (1 dia)
- `GENERATOR_CLAIMS_MODE=enforced`.
- Validator novo manda. Antigo vira fallback de auditoria por mais uma rodada.
- Generator **para** de emitir `actions` — código sintetiza.
- Prompt encolhe.

### Fase E — Remover legado (algumas horas)
- Apagar `say-validator.ts` (ou reduzir a `extract money + safe_fallback exact match`).
- Apagar regras 5a/5b/7/8/11/12/13/14 + REGRAS DE MEMORIA do prompt.
- Apagar `action-validator.ts` (ou manter só as 2-3 invariantes estruturais não-comerciais: `delivery_draft_requires_address`, `cart_*`, etc.).

## Cronograma realista

| Fase | Duração | Risco |
|---|---|---|
| A — schema + validators + synthesize | 1 dia | baixo |
| B — dual-output + dual-pipeline | 1 dia | médio (Generator começa a errar claims antes de aprender) |
| C — sombra catalog15 | 1 dia (deploy + rodar bateria + analisar) | baixo |
| D — cutover | 1 dia | médio (regressão potencial) |
| E — limpeza | 4 h | baixo |

**Total: ~4-5 dias de trabalho efetivo.** Com revisão e bateria entre fases: 1 semana real.

## O que vai mudar pra o desenvolvimento futuro

| Cenário | Hoje | Depois das claims |
|---|---|---|
| Adicionar nova afirmação comercial (ex.: "garantia estendida") | Adicionar regex em say-validator + regex de hedge + caso na action validator + caso no prompt | Adicionar `claim.type='warranty_quoted'` no schema + 5 linhas de validação contra `evidence.warrantyPolicy` |
| LLM gera frase em sinônimo novo (ex.: "casa direitinho" pra fitment) | Regex não pega → falso negativo OU adiciono regex nova → vai bater em negação | LLM ainda declara `fitment_confirmed` independente da frase. Funciona. |
| LLM gera negação cautelosa ("ainda não sei se serve") | Bloqueia (caso atual). Vamos vivendo de patch. | LLM declara `fitment_pending` (ou não declara nada de fitment). Não bloqueia. |
| Investigar bug "validator bloqueou indevidamente" | Decifrar qual de 60 regexes pegou | Ler `claim` que foi bloqueado + razão tipada |

## Aviso honesto

Esse plano **não é zero regex absoluto**: sobram 3, todas extrativas
(money parser + accent normalizer + safe-fallback equality), nenhuma
classifica significado. Se eu te prometesse "zero regex" estaria
mentindo: para a checagem de "número que LLM escreveu bate com número
declarado", uma regex de extração é a forma mais simples de fazer
isso. Mas a diferença ontológica é gigante: extrair número ≠ inferir
intenção.

Se quiser, dá pra trocar até essa última `extractMoneyValues` por um
parser determinístico, ou por exigir que a LLM cite preço **somente
por substituição de placeholder** ("Por R$ {price_amount:79.00}").
Mas é overkill — a regex de extrair número é tão simples que erro
nela é praticamente impossível.

## Próximos passos

1. Aprovação do plano (você ou Opus).
2. Definir lista final de `claim.type` (provavelmente abrir issue / draft).
3. Começar Fase A.

Os 2 fixes pontuais que propus antes (`fitment hedge` no say-validator
+ `update_draft fulfillment_mode` no prompt) **podem ser executados em
paralelo** se você quiser desbloquear catalog15 antes da migração
maior. Eles atrapalham 0% essa arquitetura — viram código que vai ser
deletado de qualquer jeito.
