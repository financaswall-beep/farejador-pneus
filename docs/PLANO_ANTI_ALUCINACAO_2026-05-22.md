# Plano Anti-Alucinação do Atendente — 2026-05-22

**Autor:** Claude (Anthropic, Sonnet 4.5)
**Base:** Auditoria profunda com 4 agentes paralelos (prompts, validadores, fluxo, banco) + síntese crítica
**Bug âncora:** conv 593 (bot afirmou compatibilidade da PCX 150 com pneu 130/70-13 que é da PCX 160)

---

## TL;DR

O bug 593 **não é regex faltando**. É um **defeito de design de dados**: um fato extraído pela Organizadora (`produto_oferecido="130/70-13"`) vira string solta, sem amarração à moto que originou a oferta. No turno seguinte esse fato contamina o Planner, que chama uma tool que retorna produto, enquanto outra tool retorna compatibilidade vazia — e o Generator escolhe a primeira. A defesa atual (claim_validator) bloqueia *post-facto*, mas a raiz é estrutural.

**5 camadas de fix**, em ordem de raiz pra superfície:

| camada | foco | impacto | esforço |
|---|---|---|---|
| 1. Estrutura de dados | facts/claims com ancoragem semântica | crítico | médio (migration) |
| 2. Invariantes estruturais | validadores cruzam evidência real, não regex | crítico | médio |
| 3. Prompts pensativos | CoT obrigatório + few-shots de pivot | alto | baixo |
| 4. Cobertura operacional | cadastrar fitments + apagar lixo | alto | baixo (digitação) |
| 5. Observabilidade | testes e métricas anti-regresso | médio | baixo |

**Princípio violado em todo achado de fundo:** ancoragem semântica perdida no transporte de dados entre componentes (Organizadora → facts → Planner → Generator → tools).

---

## O que rejeitei dos relatórios dos agentes

Antes de listar o plano, declaro o que **não vou seguir** dos achados, mesmo que tenham aparecido:

- **Adicionar regex no say-validator** (sugerido pelo agente de prompts no item 7): viola filosofia. Substituído por *invariante estrutural* — se Generator cita produto associado a moto, é obrigado a emitir `fitment` claim, e o claim cruza evidência real. Sem regex.
- **`detectDiscountClaim` por regex** (já existe): marcado pra **remover gradualmente** conforme claims estruturados absorvem.
- **Filtrar facts via regex** no context-builder: filtragem é por *contexto estrutural* (item_id, vehicle_anchor), não por palavra-chave.

---

## CAMADA 1 — Estrutura de dados (raiz)

### 1.1 Schema de facts: ancoragem obrigatória

**Onde:** `analytics.current_facts` (nova migration), `src/shared/zod/fact-keys.ts`

**Hoje:** fact é `{fact_key, fact_value, message_id, confidence}` — globais, sem amarração.

**Mudar para:**
```typescript
{
  fact_key,
  fact_value,
  message_id,
  confidence,
  scope: 'global' | 'item' | 'vehicle',
  item_id: uuid | null,          // qual item_id do cart
  vehicle_anchor: {              // se scope='vehicle', qual veículo
    make: string,
    model: string,
    year: number | null,
    variant: string | null,
  } | null,
}
```

**Impacto direto no bug 593:** quando Organizadora extrai `produto_oferecido=130/70-13` da fala "achei pra PCX 160", ela é obrigada a setar `vehicle_anchor={make:'Honda', model:'PCX', variant:'160'}`. No turno seguinte, quando cliente diz "PCX 2020", o context-builder vê que o anchor (PCX 160) ≠ moto atual (PCX 150) e **descarta o fact**.

**Migration nova:** adicionar colunas + backfill defensivo (`scope='global'` pra rows existentes).

---

### 1.2 Fact_keys com schema rico

**Onde:** `src/shared/zod/fact-keys.ts` (linha 271 hoje tem `produto_oferecido = z.string()`)

**Mudar:**
```typescript
produto_oferecido: z.object({
  medida_pneu: z.string(),                              // "130/70-13"
  product_id: z.string().uuid().nullable(),             // ref direta
  para_vehicle_make: z.string(),                        // OBRIGATÓRIO
  para_vehicle_model: z.string(),                       // OBRIGATÓRIO
  para_vehicle_year: z.number().nullable(),
  position: z.enum(['front','rear','both']).nullable(),
}),

preco_cotado: z.object({
  valor: z.number(),
  product_id: z.string().uuid().nullable(),
  para_item_id: z.string().uuid().nullable(),
}),

taxa_frete_cotada: z.object({
  valor: z.number(),
  bairro: z.string().nullable(),
}),
```

**Impacto:** Organizadora não consegue mais emitir fato desancorado — o Zod rejeita.

---

### 1.3 Fitment claim com `vehicle_ref` obrigatório

**Onde:** `src/atendente/generator/schemas.ts:131-137`

**Hoje:**
```typescript
fitmentClaimSchema = z.object({
  type: z.literal('fitment'),
  product_id: z.string().min(1).nullable().optional(),  // OPCIONAL
  vehicle_hint: z.string().max(120).nullable().optional(),
});
```

**Mudar:**
```typescript
fitmentClaimSchema = z.object({
  type: z.literal('fitment'),
  product_id: z.string().uuid(),                        // OBRIGATÓRIO
  vehicle_model_id: z.string().uuid(),                  // OBRIGATÓRIO — qual variante
  vehicle_label: z.string().max(120),                   // pra log/debug
});
```

**Impacto:** claim não pode mais ser vago. Generator é obrigado a saber **qual moto** e **qual produto** está afirmando.

---

### 1.4 Tool `CompatibilidadeResultado` com `fitment_status` explícito

**Onde:** `src/atendente/tools/commerce-tools.ts:83-103`

**Adicionar:**
```typescript
interface CompatibilidadeResultado {
  // ... existente ...
  fitment_status:
    | 'confirmed'                 // tem fitment, produtos > 0
    | 'no_fitments_registered'    // moto existe no catálogo mas zero fitments
    | 'no_products_for_fitment'   // tem fitment mas produto deletado/sem estoque
    | 'vehicle_not_found';        // resolver não achou variante
}
```

**Impacto:** Generator deixa de "adivinhar" o que `produtos=[]` significa. Sinal explícito tira ambiguidade semântica.

---

### 1.5 Tool `ProdutoOferta` com `compatible_vehicle_models[]`

**Onde:** mesmo arquivo

**Adicionar:**
```typescript
interface ProdutoOferta {
  // ... existente ...
  compatible_vehicle_models: Array<{
    vehicle_model_id: string,
    make: string,
    model: string,
    variant: string | null,
    year_start: number | null,
    year_end: number | null,
    position: 'front' | 'rear' | 'both',
    is_oem: boolean,
  }>;
}
```

**Impacto:** quando Generator pega produto via `buscarProduto(medida)`, ele vê na hora as motos onde aquele pneu cabe. Não consegue mais oferecer "pneu pra X" se X não está na lista.

---

## CAMADA 2 — Invariantes estruturais (substituem regex semântico)

### 2.1 `claim_validator` cruza variante real

**Onde:** `src/atendente/validators/claim-validator.ts:122-151`

**Hoje:** confirma só que `product_id` aparece em **algum** fitment retornado.

**Mudar:** confirma que `claim.product_id` aparece dentro do `produtos[]` do fitment **cuja `vehicle_model_id == claim.vehicle_model_id`** do turno atual. Se não bater, bloqueia com reason específico (`claim_invalid:fitment:vehicle_mismatch`).

**Sem regex.** Cruza dados estruturais — vehicle_model_id de claim ↔ vehicle_model_id de tool result.

---

### 2.2 Schema do Generator: oferta sem fitment claim = inválida

**Onde:** `src/atendente/generator/schemas.ts` (validação pós-schema)

**Regra estrutural:** se `actions[]` contém `record_offer` com `products[].vehicle_model_id`, **deve** haver `claims[]` com `fitment` claim correspondente (mesmo product_id + vehicle_model_id). Validação no Zod refine.

**Impacto:** Generator não consegue mais oferecer produto pra moto sem emitir claim — e o claim cruza evidência (item 2.1).

---

### 2.3 context-builder filtra facts obsoletos

**Onde:** `src/atendente/planner/context-builder.ts:98-174`

**Adicionar:** ao carregar facts, comparar `fact.vehicle_anchor` com `state.items[].slots.moto_modelo / moto_ano`. Se diverge, **não injeta no contexto** e grava `incident: fact_dropped_vehicle_mismatch` em ops.

**Sem regex.** Comparação estrutural entre objetos.

---

### 2.4 invalidation-rules expande

**Onde:** `src/atendente/state/invalidation-rules.ts`

**Adicionar regras:**
- trigger `moto_modelo` mudou → invalida `produto_oferecido`, `preco_cotado`, `medida_pneu` (do item)
- trigger `moto_ano` mudou → invalida `produto_oferecido` se `vehicle_anchor.year` ≠ novo ano
- trigger `item_id` novo criado → produto_oferecido global não migra

---

### 2.5 `collectFitments` deixa de filtrar silenciosamente

**Onde:** `src/atendente/generator/prompt.ts:438-448`

**Hoje:** `if (Array.isArray(produtos) && produtos.length > 0) fitments.push(fitment)` — descarta silenciosamente fitments vazios.

**Mudar:** sempre adicionar, com flag `has_products: boolean`. `commercial_summary` ganha `fitment_checked_but_empty: boolean` + adiciona response_guidance HARD: `"buscarCompatibilidade rodou e retornou ZERO produtos para a variante X. NUNCA afirme compatibilidade dessa moto."`

---

### 2.6 Self-correction retry context enriquecido

**Onde:** `src/atendente/worker.ts:446-490`

**Mudar `GeneratorRetryContext`:**
```typescript
{
  reason: 'previous_blocked' | 'previous_fallback',
  block_source: 'claim_validator' | 'say_validator' | 'action_validator',
  blocked_claim?: {
    type: string,
    product_id?: string,
    vehicle_model_id?: string,
    detail: string,                  // "produto P99 nao tem fitment pra PCX 150"
  },
  relevant_tool_outputs?: {          // só os relevantes pro bloqueio
    tool: string,
    summary: string,
  }[],
}
```

**Impacto:** Generator no retry não tenta "cegamente" de novo — recebe motivo semântico do bloqueio.

---

## CAMADA 3 — Prompts pensativos

### 3.1 Generator v1.5: CoT obrigatório antes de fitment claim

**Onde:** `src/atendente/generator/prompt-v1_5.ts:113-167` (seção "Princípio único de safety")

**Adicionar seção nova:**
```
ANTES DE EMITIR fitment CLAIM — CoT OBRIGATÓRIO no rationale:
(a) Qual veiculo o cliente mencionou? (marca/modelo/ano EXATOS)
(b) Eu rodei buscarCompatibilidade(esse_veiculo, esse_ano) NESTE turno?
(c) Que variante voltou com produtos[]? (compare make+model+year_range)
(d) O product_id que vou citar está em produtos[] dessa variante exata?
Se (d)=nao → ZERO fitment claim. Pergunte medida ou ofereça contato.
```

---

### 3.2 Novo Exemplo 15: pivot de moto

**Onde:** mesmo arquivo, após Exemplo 14

```
Exemplo 15 — Cliente mudou de moto, não reutilize compatibilidade anterior

context:
  - turn 1: cliente disse "tenho CG 160", buscarCompatibilidade(CG 160) → produtos OK
  - organizer_facts: produto_oferecido (anchor=CG 160)
  - turn 2: cliente "agora preciso pra minha PCX 2020"

tool_results turn 2:
  - buscarCompatibilidade(PCX, 2020) → fitment_status='no_fitments_registered'

RESPOSTA CORRETA:
{
  "say": "Entendi, mudou pra PCX 2020. Pra essa moto não tenho fitment cadastrado aqui — qual medida tá escrita no pneu atual? (na lateral, formato XX/XX-XX)",
  "actions": [
    {"type":"create_item","item_id":"ITEM_2","make_active":true},
    {"type":"update_slot","scope":"item","item_id":"ITEM_2","slot_key":"moto_modelo","value":"PCX","source":"observed","confidence":0.95},
    {"type":"update_slot","scope":"item","item_id":"ITEM_2","slot_key":"moto_ano","value":2020,"source":"observed","confidence":0.95}
  ],
  "claims": [],   // ZERO claim
  "rationale": "(a) cliente=PCX 2020. (b) busquei. (c) fitment_status=no_fitments_registered. (d) sem product_id valido pra essa variante. Nao reutilizo produto_oferecido da CG 160 (vehicle_anchor diferente). Crio item novo e peço medida."
}
```

---

### 3.3 Novo Exemplo 16: compatibilidade vazia mas honesto

```
Exemplo 16 — fitment_status='no_fitments_registered', NAO afirme compat

tool_results:
  - buscarCompatibilidade(PCX, 2020) → {fitment_status:'no_fitments_registered', produtos:[]}
  - buscarProduto(130/70-13) → {product, compatible_vehicle_models:[{model:'PCX 160'}]}

ERRO:
  "Achei o pneu 130/70-13 pra sua PCX 2020 por R$99"   ← MENTIRA: o 130/70-13 é da PCX 160, não 150

CORRETO:
  "Pra sua PCX 2020 nao tenho a compatibilidade cadastrada. Encontrei a medida 130/70-13 mas ela é da PCX 160 (a partir de 2023), nao serve na sua. Me passa a medida que tá no seu pneu atual?"

actions: [], claims: [],
rationale: "fitment_status=no_fitments_registered pra PCX 2020. buscarProduto retornou produto mas compatible_vehicle_models só inclui PCX 160. Honestidade > venda."
```

---

### 3.4 Planner: regra de ouro pra moto/ano novo

**Onde:** `src/atendente/planner/prompt.ts:19-20`

**Substituir:**
```
REGRA DE OURO — compatibilidade é SEMPRE específica à VARIANTE:

Se organizer_facts tem produto_oferecido com vehicle_anchor=X,
E cliente AGORA fala moto/ano DIFERENTE (Y ≠ X):
  → SEMPRE chame buscarCompatibilidade(Y, novo_ano) neste turno.
  → IGNORE o produto_oferecido antigo (anchor obsoleto).
  → NUNCA chame buscarProduto(medida_antiga) sem revalidar.

Se moto NÃO mudou (mesma marca+modelo+ano):
  → pode reutilizar produto_oferecido, confirme estoque se cliente pergunta "tem?"
```

---

### 3.5 Organizadora: regra de ancoragem

**Onde:** `src/organizadora/prompt.ts:186-187`

**Adicionar seção:**
```
REGRA DE ANCORAGEM — fact_keys com referência veicular:

Ao extrair produto_oferecido OU preco_cotado OU medida_pneu de uma fala do bot:
SEMPRE inclua vehicle_anchor (make+model+variant+year) dessa mesma fala.

Se a fala diz "achei o pneu pra PCX 160":
  → produto_oferecido.vehicle_anchor = {make:'Honda', model:'PCX', variant:'160'}

Se a fala diz só "achei o pneu" sem citar moto:
  → vehicle_anchor = inferir do item ativo no contexto
  → se nao tem item ativo claro, NAO emita o fact (drop)

NUNCA emita produto_oferecido como string solta sem anchor.
```

---

## CAMADA 4 — Cobertura operacional (catálogo)

### 4.1 Cadastrar fitments faltantes (8 motos)

**Estado real do banco** (verificado via MCP Supabase):
- 158 modelos, 93 com fitment, **65 sem fitment** (a maioria são entradas inúteis)
- PCX 150 (year 2013-2022 preenchido, **0 fitments**) ← causa direta do bug 593

**Inserir** (após você confirmar medidas):

| moto | dianteiro | traseiro |
|---|---|---|
| Honda PCX 150 (2013-2022) | 90/90-14 | 100/90-14 |
| Honda Biz 125 (2006-2026) | 60/100-17 | (já tem 80/100-14) |
| Honda NXR 150 Bros (2005-2015) | (já tem 90/90-19) | 90/90-17 |
| Honda NXR 160 Bros (2016-2026) | (já tem 90/90-19) | 110/90-17 |
| Honda Pop 110i ES (2016-2026) | 60/100-17 | (já tem 80/100-14) |
| Honda XRE 190 (2016-2026) | (já tem 90/90-19) | 110/90-17 |
| Honda XRE 300 (2009-2025) | (já tem 90/90-21) | 140/80-18 |
| Yamaha XMAX 250 ABS | (já tem 120/70-15) | 140/70-14 |

### 4.2 Apagar entradas genéricas duplicadas (hard delete, são órfãs)

PCX, Bros, Pop, Lead, Biz, Elite, XRE (Honda) + XMAX 250 (Yamaha sem variant) — todas com year_start NULL, zero fitments, zero discoveries. Confirmado no MCP.

### 4.3 Cobertura adicional (perguntar antes de cadastrar)

Yamaha Crosser/Fluo, Suzuki Burgman, Dafra Smart/Citycom, Haojue Lindy/NK150/DL — você vende em volume?

---

## CAMADA 5 — Observabilidade e anti-regresso

### 5.1 Teste sintético do bug 593

**Onde:** `tests/integration/atendente/conv-pivot-pcx.test.ts` (novo)

Simula:
- turn 1: "tenho PCX" → bot oferece pra PCX 160
- turn 2: "ah, é PCX 2020" → bot **deve** dizer "não tenho compatibilidade", **não pode** oferecer 130/70-13

Roda no CI a cada commit.

### 5.2 Métrica em ops

**Nova métrica em `ops.supervisor_reviews`:**
- `fact_dropped_vehicle_mismatch` count (do 2.3)
- `claim_invalid_vehicle_mismatch` count (do 2.1)
- `compatibility_checked_but_empty` count (do 2.5)

Trends crescentes = bot tentando alucinar e sendo bloqueado. Trends decrescentes após deploy = bot aprendeu.

---

## Ordem de execução proposta

**Fase A (1 dia, baixo risco)** — atinge 70% do problema:
- 4.1 + 4.2 (cadastrar fitments + apagar genéricas)
- 1.4 + 1.5 (sinais explícitos nas tools — backward compatible)

**Fase B (2-3 dias, risco médio)** — fecha o resto:
- 1.1 + 1.2 + 1.3 (migration + Zod) + backfill
- 2.1 + 2.2 + 2.3 + 2.4 + 2.5 (invariantes estruturais)
- Deploy em shadow primeiro, comparar bloqueios com human

**Fase C (1-2 dias)** — ensina o LLM:
- 3.1 + 3.2 + 3.3 + 3.4 + 3.5 (prompts)
- 2.6 (self-correction enriquecido)
- 5.1 + 5.2 (testes + métricas)

**Total estimado:** 4-6 dias úteis, com Fase A já trazendo melhora visível.

---

## Riscos e trade-offs

| risco | mitigação |
|---|---|
| Migration de facts é destrutiva | Backfill com `scope='global'` default; testar em branch antes |
| `product_id` obrigatório em claim quebra turnos legados | Grace period em shadow; só ativar hard-block após N dias de comparação |
| Generator pode ficar "mais chato" pedindo medida | Aceitável — honestidade > venda errada (filosofia do Wallace) |
| Catálogo de 65 motos sem fitment vira backlog | Só as 8 populares importam pra venda; resto vira `discovery_pending` natural |

---

## Discussão antes de executar

Pontos que preciso de decisão sua antes de tocar código:

1. **Migration do schema de facts**: adiciono `vehicle_anchor` em `analytics.current_facts` ou crio tabela paralela `analytics.current_facts_v2`? Paralela é mais seguro, mas duplica leitura.

2. **Hard delete vs soft delete das 8 genéricas**: já discutimos, sua preferência foi hard. Confirma.

3. **Grace period do `product_id` obrigatório**: 0 dias (já bloqueia) ou 7 dias (só warning, depois bloqueia)?

4. **Fitments faltantes**: você dita medidas (mais rápido e correto) ou eu pesquiso por minha conta primeiro e você revisa?

5. **Migration roda via script `scripts/aplicar-NNNN.cjs` como a 0047, ou via MCP Supabase desta sessão?**

Não vou tocar uma linha de código até você responder.
