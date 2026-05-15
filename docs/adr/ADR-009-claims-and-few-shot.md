# ADR-009 — Structured Commercial Claims e Prompt Few-Shot (Etapas 2 e 5)

**Status:** Aceito e implementado.
**Data:** 2026-05-15.
**Contexto:** Sequência de decisões durante a sessão de Maio/2026 que culminou
nos commits `408f058` (Etapa 2 claims), `b6bc9d9` (Etapa 3 limpar regex do
Planner), `cc93a05` (Etapa 5 few-shot v1.5.0) e `6f7e7c5` (audit prompt_version).

## Contexto

A auditoria `docs/AUDITORIA_ATENDENTE_2026-05-14.md` identificou que 84% dos
bloqueios em 7 dias eram bugs de plumbing pós-migração para Responses API,
não falhas de LLM. Após corrigir esses bugs (commits `4963701` a `ce16830`),
emergiram dois problemas arquiteturais:

1. **Excesso de regex sobre fala humana.** Tanto o Planner (em
   `normalizePlannerOutputCandidate`) quanto o SayValidator dependiam de
   regex sobre customer text ou bot output para tomar decisões críticas.
   Português coloquial brasileiro tem variação infinita ("tá salgado",
   "vc traz aqui", "pega na minha"), e enumerá-lo em regex é uma corrida
   perdida.

2. **Prompt do Generator inchado.** v1.4.0 tinha 14 regras numeradas com
   sub-letras (1, 4a, 4b, 5, 5a, 5b, 5c, 11a, ...), ~3690 tokens de system
   prompt. Cada novo bug adicionava regra; regras conflitavam; LLM
   misinterpretava.

## Decisão

### Etapa 2 — Structured Commercial Claims

Mover safety checks de "regex sobre fala do bot" para "claims estruturados
emitidos pelo Generator e validados por código contra tool results".

O Generator agora devolve, junto com `say`:

```ts
claims: Array<
  | { type: 'price'; amount: number; product_id?: string | null }
  | { type: 'stock_availability'; product_id?: string | null }
  | { type: 'fitment'; product_id?: string | null; vehicle_hint?: string | null }
  | { type: 'delivery_fee'; amount?: number | null }
>
```

`ClaimValidator` checa cada claim contra os tool_results do turno:
- `price` exige `buscarProduto` com `price_amount == claim.amount` (±R$0,01)
- `stock_availability` exige `verificarEstoque` com `disponivel=true` OU `quantidade_total > 0`
- `fitment` exige `buscarCompatibilidade` com produtos compatíveis
- `delivery_fee` exige `calcularFrete` com valor (se `amount` informado, casa)

`SayValidator` (regex) continua como **rede de segurança transitória**. Quando
adoção de claims atinge ~80% sobre turnos comerciais, regex pode ser
retirada.

### Etapa 3 — Planner sem regex de customer text

Removidas do `normalizePlannerOutputCandidate`:
- `mentionsProductCompatibilityQuestion`
- `shouldEnsurePolicyTool`
- `findOrganizerNumberFact`
- `latestCustomerText`
- 80 linhas de "patch" que tentavam corrigir output do Planner LLM com base
  em palavras-chave do customer text

Mantidas como `@internal MOCK-ONLY`:
- `mentionsPolicyQuestion`, `mentionsStoreInfoQuestion` (usadas apenas no
  `mockPlanTurn` quando `PLANNER_LLM_ENABLED=false`)

Mantida trava não-regex: `buscar_e_ofertar` sem `tool_requests` → força
`pedir_dados_faltantes` (não interpreta texto, só conta tools).

Prompt do Planner bumped para `v1.2.8` com regras explícitas por skill +
"REGRA DE OURO" sobre interpretar fala informal (`"tá salgado"`, `"vc traz aqui"`,
`"pega na minha"`).

### Etapa 5 — Prompt Few-Shot v1.5.0 (atrás de feature flag)

Novo prompt em `src/atendente/generator/prompt-v1_5.ts` com 10 exemplos
canônicos derivados de:
- 15 casos da `catalog15` (docs/CATALOG15_LLM_EVAL.md)
- 5 failure modes identificados pelo Codex em baterias recentes
  (multi-produto, pivot/mudança, citação de turn passado, frete coloquial sem
  bairro, closing parcial sem ack)

Tamanho: ~2660 tokens vs ~3690 tokens de v1.4.0 (~28% menor).

Feature flag: `GENERATOR_PROMPT_FEW_SHOT_ENABLED` (env var). Default `false`
(v1.4.0). Schema agora aceita ambos via `z.enum([generatorPromptVersionV14,
generatorPromptVersionV15])`.

### Audit (correção em `6f7e7c5`)

`GeneratorResult.prompt_version` adicionado. `recordGeneratorResult` agora
usa `result.prompt_version` (vinda do `parsed.data.prompt_version` real do LLM)
em vez da constante fixa. Sem isso, comparação A/B v1.4 vs v1.5 ficaria
contaminada porque DB diria sempre v1.4.0.

Também adicionados: `event_payload.claims`, `event_payload.claims_count`,
`event_payload.claim_types`, `blocked_payload.claims`.

## Resultados Medidos (2026-05-15)

**Catalog15-rerun com v1.5.0 ligada:**
- 45/45 generated, 0 blocked
- Fallbacks: 6 → 2 (queda forte)
- Claims: 64.4% dos turnos emitem, média 1.4 claims/turn
- 0 `claim_invalid:*` (validator não pegou erros nessa rodada)
- Input médio: 7068 tokens (era 7187 com v1.4 pós-claims; redução marginal
  porque cache de prompt + payload dinâmico dominam)

**Bateria custom 8 casos coloquiais:**
- 8/8 generated, 0 blocked
- Comportamento esperado em 7/8 casos (1 caiu em fallback em "tá salgado" —
  problema do Planner, não do Generator)

## Trade-offs

**Ganhamos:**
- Safety baseada em estrutura, não em interpretação de texto
- Auditoria mensurável (claims em DB)
- Prompt do Generator 28% menor
- Planner mais simples (sem 80 linhas de patches regex)
- Sistema mais determinístico

**Pagamos:**
- 1 query DB extra por turn comercial (auto-chain `verificarEstoque`)
- Claims schema aumenta o JSON output (~100 chars por claim, ~10% no output)
- Manutenção de 2 prompts em paralelo durante migração v1.4→v1.5
- Risco: se Generator esquecer de emitir claim, validator não cobre. SayValidator
  regex cobre durante migração. Quando adoção ≥80%, regex pode ir embora.

## Onde NÃO mexer agora

- **Não funnel split** (Generator por etapa do funil). Analisado e descartado
  nesta sessão. ROI baixo: economia ~$3-5/mês com complexidade triplicada.
  Few-shot v1.5.0 atende mesmo objetivo (prompt menor, comportamento melhor)
  sem custo operacional.
- **Não 4ª LLM no caminho do turno.** Codex levantou; descartado. Múltiplas
  LLMs por turno = caro, lento, confuso.
- **Não retirar SayValidator regex ainda.** Espera adoção de claims ≥80%
  sobre turnos comerciais antes de retirar.

## Próximos passos consequentes

1. Quando adoção de claims atingir ≥80% em buscar_e_ofertar, retirar regras
   de safety redundantes do prompt do Generator (reduz mais ~25% do tamanho)
   e aposentar regex correspondente do SayValidator.
2. Considerar adicionar mais tipos de claim conforme novos cenários surgem
   (ex: `discount` para política de desconto, `installments` para parcelamento).
3. Decidir se v1.5.0 vira default ou se v1.4.0 fica como fallback indefinido.
   Depende da curva de qualidade ao longo de 2-3 semanas de coleta.

## Referências

- `docs/AUDITORIA_ATENDENTE_2026-05-14.md` — diagnóstico que motivou
- `src/atendente/validators/claim-validator.ts` — implementação
- `src/atendente/generator/prompt-v1_5.ts` — prompt few-shot
- `tests/unit/atendente/validators/claim-validator.test.ts` — 23 testes
- `tests/unit/atendente/generator/prompt-v1_5.test.ts` — 9 testes
- Commits: `408f058`, `b6bc9d9`, `cc93a05`, `1edd3a2`, `6f7e7c5`
