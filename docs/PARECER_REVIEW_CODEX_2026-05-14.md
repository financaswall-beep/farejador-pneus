# Parecer técnico — revisão da análise do Codex (catalog15 rerun, 2026-05-14)

## Resumo executivo

O Codex acertou o diagnóstico geral ("Generator faz coisas demais")
mas **errou o caminho de solução**. Os 4 bloqueios que sobraram **não
são culpa de o Generator "ignorar regras" ou "interpretar mal o
contexto"**. São dois bugs determinísticos pontuais que cabem em ~1h
de trabalho cada — um no `say-validator` (regex falso-positivo) e um
no prompt + validador `update_draft`.

Os fixes anteriores (Fase 1) e os fixes do Codex (`commercial_summary`,
Responses API strict, regras 4a/4b/5c) **funcionaram**: o sistema saiu
de 13 → 4 turns bloqueados. Refatorar o Generator agora pra cuspir um
`response_brief` quase pronto via código é overkill — vai destruir a
naturalidade da resposta e introduzir uma nova superfície de bugs sem
mover o ponteiro nos 2 problemas reais que sobraram.

## Os 4 bloqueios reais (cruzados do banco)

Run id: `catalog15-rerun-20260514225048`. Tabela `agent.turns` filtrada
em `created_at >= '2026-05-14T22:50:00Z' AND status='blocked'`.

| # | turn_id | conv | skill | block_reason | bug |
|---|---|---|---|---|---|
| 1 | `56990886` | `56f2955e` (Yes 125) | buscar_e_ofertar | `fitment_claim_without_buscar_compatibilidade` | A |
| 2 | `bdf43ddd` | `56f2955e` (Yes 125) | buscar_e_ofertar | `fitment_claim_without_buscar_compatibilidade` | A |
| 3 | `e1a81ef5` | `50913171` (Rio do Ouro) | responder_logistica | `action_blocked:delivery_draft_requires_address` | B |
| 4 | `a54cb842` | `50913171` (Rio do Ouro) | responder_geral | `action_blocked:delivery_draft_requires_address` | B |

Apenas **2 padrões distintos**, não 4 bugs diferentes.

## Bug A — say-validator pega NEGAÇÕES como CLAIMS

### Evidência

`blocked_say_text` dos turns 1 e 2:

> "Encontrei um pneu traseiro 90/90-18 por R$ 79,00. Porém, eu ainda
> **não consigo confirmar que essa medida serve na** sua Suzuki Yes 125.
> Se você me passar o ano da moto ou uma foto..."

> "Encontrei um pneu traseiro 90/90-18 por R$ 79,00... Só **não consigo
> confirmar ainda se ele serve na** sua Suzuki Yes 125, porque a
> compatibilidade não ficou fechada na consulta..."

### Causa exata em código

[`src/atendente/validators/say-validator.ts:200-207`](../src/atendente/validators/say-validator.ts):

```ts
function mentionsCompatibilityClaim(text: string): boolean {
  return [
    /\b(?:serve|servem)\s+(?:na|no|para|pra)\b/,
    /\bcompativel\s+(?:com|para|pra)\b/,
    /\b(?:pneu|medida|modelo)\s+(?:certo|correto|ideal)\s+(?:para|pra)\b/,
    /\bencaixa\s+(?:na|no)\b/,
  ].some((pattern) => pattern.test(text));
}
```

A regex `\b(?:serve|servem)\s+(?:na|no|para|pra)\b` é cega ao contexto:
qualquer frase com **"serve na"** dispara, incluindo negações:
- "não consigo confirmar se **serve na**..."
- "ainda não sei se **serve na**..."
- "preciso confirmar se **serve na**..."

O Generator está fazendo o **certo**: dizendo objetivamente que não
confirmou compatibilidade. O validator é que está bloqueando texto
cauteloso.

### Por que isso piorou em vez de melhorar

A regra 4 do `commercial_summary` (`fitment_status: 'not_confirmed'`)
**instrui o Generator a dizer que não confirmou**, e o
`response_guidance` (vide [`prompt.ts:307-308`](../src/atendente/generator/prompt.ts)):

```
'Compatibilidade foi consultada, mas nao confirmada; nao use "serve".
Peca ano/versao/foto da medida ou chame atendente.'
```

O prompt mandou **não usar "serve"**, mas o LLM escreve "não consigo
confirmar se serve" achando que negação é seguro. Validator não
distingue.

### Fix correto (não é refactor)

O validator `say-validator.ts` já tem o padrão certo aplicado em
**outro lugar**: [`mentionsPolicyMeta`](../src/atendente/validators/say-validator.ts:247-256)
filtra sentenças que começam com "vou verificar", "preciso confirmar",
"nao tenho essa informacao", etc., **antes** de checar policy claims.
Basta replicar a ideia em `mentionsCompatibilityClaim`.

Esboço:

```ts
function mentionsCompatibilityClaim(text: string): boolean {
  // Trabalhar por sentença; ignorar sentenças com marcadores de incerteza/negação.
  for (const sentence of text.split(/[.!?\n]+/)) {
    const s = sentence.trim();
    if (!s) continue;
    if (looksLikeFitmentHedge(s)) continue;
    if (FITMENT_CLAIM_PATTERNS.some((p) => p.test(s))) return true;
  }
  return false;
}

function looksLikeFitmentHedge(s: string): boolean {
  return [
    /\bnao\s+(?:consigo|posso|tenho\s+como)\s+(?:confirmar|garantir|afirmar|prometer)\b/,
    /\bainda\s+nao\s+(?:sei|consigo|posso|confirmei)\b/,
    /\bprecis(?:o|amos)\s+confirmar\b/,
    /\bvou\s+(?:verificar|confirmar|checar|consultar)\b/,
    /\bnao\s+(?:foi|ficou)\s+confirmad[oa]\b/,
    /\bantes\s+de\s+(?:te\s+)?(?:confirmar|garantir|fechar)\b/,
  ].some((p) => p.test(s));
}
```

**Custo:** 30–45 min (código + 4 testes unit cobrindo as variações
"não consigo confirmar / ainda não sei / preciso confirmar / não foi
confirmado"). **Risco:** baixo.

**Impacto na bateria:** zera os 2 bloqueios `fitment_claim_*`.

## Bug B — `update_draft` com `fulfillment_mode=delivery` sem endereço

### Evidência

Turn 3 (`e1a81ef5`): cliente disse "Entrega em Rio do Ouro, São Gonçalo".
Não disse rua. O Generator emitiu `update_draft` com
`fulfillment_mode=delivery` mas sem `delivery_address`. Validator
[`action-validator.ts:172-179`](../src/atendente/validators/action-validator.ts):

```ts
case 'update_draft': {
  const fulfillmentMode = action.fulfillment_mode ?? state.order_draft?.fulfillment_mode ?? null;
  const deliveryAddress = action.delivery_address ?? state.order_draft?.delivery_address ?? null;
  if (fulfillmentMode === 'delivery' && !deliveryAddress) {
    return block('delivery_draft_requires_address');
  }
  return { valid: true };
}
```

Validator está **correto**: não dá pra cadastrar pedido com entrega
sem endereço. O bug é no prompt — duas regras autorizam o Generator a
fazer isso prematuramente:

- Regra 16 (REGRAS DE MEMORIA, [`prompt.ts:116`](../src/atendente/generator/prompt.ts)):
  > "Se a mensagem indicar entrega ou endereco, use
  > `update_draft.fulfillment_mode='delivery'`."

- Regra 11 ([`prompt.ts:52`](../src/atendente/generator/prompt.ts)):
  > "Dados de fechamento tem prioridade sobre resposta comercial: se o
  > cliente disser 'pode fechar'... emita update_draft com os campos
  > observados."

Nenhuma das duas diz "só emita `fulfillment_mode=delivery` se já houver
`delivery_address`". O LLM segue a letra da regra e bate no validator.

Turn 4 é o mesmo conv, depois — Generator usou fallback no `say`
(porque skill=`responder_geral`) MAS ainda emitiu o mesmo
`update_draft` quebrado. Confirma que o bug é da action, não do say.

### Fix correto

Duas opções, ambas pequenas:

**Opção 1 — só prompt (mais barato, ~15 min):**
Adicionar regra na seção de update_draft do `prompt.ts`:

> "REGRA CRÍTICA DE update_draft: NUNCA emita `fulfillment_mode='delivery'`
> sem também ter `delivery_address` completo (rua + número OU ponto de
> referência). Se o cliente só citou bairro/cidade, grave o bairro/município
> via `update_slot` global e PEÇA o endereço completo no `say`. Só promova
> o draft pra `fulfillment_mode='delivery'` quando o endereço estiver
> presente nesta ação ou já no `state.order_draft.delivery_address`."

**Opção 2 — validator complacente (~10 min):**
Aceitar `fulfillment_mode='delivery'` sem endereço se o draft é só
sinalização de intenção (já existe `draft_status='collecting'` em
[`apply-action.ts:79-86`](../src/atendente/state/apply-action.ts)). Mudar
o validator para só bloquear se `draft_status='ready'`. Mas isso muda
semântica e exige cuidado com promoção a pedido.

**Recomendo Opção 1** (prompt) porque preserva a invariante do banco
("delivery sem endereço é estado proibido") e é menos invasivo.

**Custo:** 15–30 min. **Risco:** baixo.

**Impacto na bateria:** zera os 2 bloqueios `delivery_draft_*`.

## Por que a proposta do Codex é overkill

O Codex propôs:

1. **Reduzir o papel do Generator** ("não deveria decidir do zero").
2. **`response_brief` quase pronto** ("código monta a frase, LLM só
   reescreve levemente").
3. **Frase padronizada** para fitment ("Ainda preciso validar a
   aplicação...").
4. **Resolver delivery_draft logicamente.**
5. **Avaliar custo/latência da Responses API strict.**

Análise:

| Proposta | Necessária? | Por quê |
|---|---|---|
| 1, 2 | **Não** | Generator já está obedecendo o `commercial_summary` na maioria dos casos (41/45 = 91%). Os 2 fitment_claim atuais não são desobediência — são validator strikando NEGAÇÕES. Resposta determinística mata naturalidade sem ganho. |
| 3 | **Não pelo motivo certo** | Tem mérito como diretriz de prompt ("para fitment não-confirmado use frase X"), mas só resolve o problema **se o validator continuar com bug**. Melhor consertar validator. |
| 4 | **Sim, parcialmente** | É exatamente o Bug B acima. Mas a solução não é refatorar — é uma regra de 4 linhas no prompt. |
| 5 | **Vale separar** | Latência 4.4s média / 7.5s p95 é alta. Mas é otimização independente — não bloqueia qualidade. Investigar **depois** que blocked = 0. |

## Solução proposta (resumo executável)

### Fase 2 (~1h, dois fixes determinísticos)

**Fix B1 — say-validator: hedge detection em `mentionsCompatibilityClaim`**
- Arquivo: [`src/atendente/validators/say-validator.ts:200-207`](../src/atendente/validators/say-validator.ts)
- Adicionar função `looksLikeFitmentHedge` (modelo: `mentionsPolicyMeta`).
- Trabalhar por sentença; pular sentenças com negação/incerteza.
- Testes: 4 casos em `tests/unit/atendente/validators/say-validator.test.ts`.
- Custo: 30–45 min.

**Fix B2 — prompt do Generator: condicionar `fulfillment_mode=delivery` a endereço**
- Arquivo: [`src/atendente/generator/prompt.ts`](../src/atendente/generator/prompt.ts)
- Adicionar regra explícita na seção update_draft.
- Atualizar regras 11 e 16 (REGRAS DE MEMORIA) para refletir.
- Custo: 15–30 min.

**Resultado esperado:** 13 → 4 → **0** bloqueios.

### Investigações separadas (não urgentes, próxima fase)

- **Latência Generator 4.4s/7.5s p95.** Causas possíveis: strict
  schema overhead, prompt grande (146 linhas de prompt + commercial_summary).
  Investigar via input_tokens vs output_tokens vs duration. Não bloquear
  qualidade — fechar Fase 2 primeiro.
- **Multi-produto** (cenários `dois_pneus_fan2019`, `dois_traseiros_190`):
  ainda não auditei a fundo no rerun. Pode estar OK agora que Bug A
  foi destravado, mas vale conferir.
- **Bug E da Organizadora** (fact_key fora da whitelist na conv 497):
  precisa instrumentar o worker pra gravar raw response em incidente
  antes de mexer. Fora desta fase.

## Posição contra o que o Codex propôs

O Codex está descrevendo o sistema antigo (pré Fase 1). Os números que
ele citou — 41/45 generated, Generator 5.5/10 — são **melhoria
significativa** sobre os 32/45 e Generator 6/10 da rodada original.
Os fixes funcionaram. Refatorar agora pra response_brief
determinístico é resolver um problema que não existe mais (Generator
"interpretando mal") e ignorar os dois bugs concretos que sobram.

**Resumo:** não é refactor. São dois ajustes cirúrgicos, ambos com
causa-raiz mapeada linha-a-linha no código, totalizando ~1h. Depois
disso, o sistema deve estar em **0/45 bloqueios** e pode ir pra
discussão real de prompt (tamanho, naturalidade, latência) sem ruído
de bugs.
