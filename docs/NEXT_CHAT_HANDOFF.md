# Next Chat Handoff - Farejador

**Atualizado: 2026-05-15.** Esta sessão entregou um conjunto grande de mudanças
ao Atendente: limpeza de regex no Planner, escalação real, structured claims,
prompt few-shot v1.5.0 atrás de feature flag, e audit fix de `prompt_version`.

Use este resumo para continuar em outro chat sem reler a conversa inteira.

---

## Estado em 2026-05-15

### O que mudou nas últimas 48h

| Camada | Antes | Agora |
|---|---|---|
| Planner | v1.2.7 + 80 linhas de regex em customer text no `normalizePlannerOutputCandidate` | **v1.2.8** — regex de customer text REMOVIDA; prompt explícito por skill com REGRA DE OURO sobre fala informal |
| Generator (default) | v1.3.2 declarativo (~3700 tokens) | **v1.4.0** com structured claims + safety rules antigas como rede |
| Generator (feature flag) | inexistente | **v1.5.0 few-shot** (~2660 tokens, 10 exemplos canônicos) atrás de `GENERATOR_PROMPT_FEW_SHOT_ENABLED=true` |
| Safety stack | apenas SayValidator (regex sobre fala do bot) | **ClaimValidator** novo: checa `price`/`stock_availability`/`fitment`/`delivery_fee` contra tool results. SayValidator regex continua como rede |
| Escalação | dead path: 0 linhas em `agent.escalations` em 7 dias com 180 turns skill=`escalar_humano` | **worker emite action `escalate`** quando Planner escolhe `escalar_humano`. `agent.escalations` tem 5 linhas reais em prod (confirmado em DB) |
| Auto-chain `verificarEstoque` | inexistente | **determinístico**: sempre que `buscarProduto` retornou produto e `verificarEstoque` não rodou, executor injeta automaticamente |
| Audit de claims | claims emitidos mas não persistidos | **`event_payload.claims` + `claims_count` + `claim_types`** + `blocked_payload.claims` para A/B mensurável |
| Audit de prompt_version | constante fixa = v1.4.0 mesmo com v1.5.0 ativo | **versão real** persistida (do `parsed.data.prompt_version` quando LLM ou da env flag quando mock/fallback) — commit `6f7e7c5` |
| `action_id` em actions estado | faltava em cart/escalate/confirmation/selectSkill | adicionado via `stateActionBaseSchema.extend` — todas as actions ganham `action_id` + `turn_index` + `emitted_at` + `emitted_by` |
| `deterministicId` legado | hash djb2 32-bit com sufixo fixo | substituído por `deterministicUuid` sha256 |

### Resultados da bateria catalog15 (com flag v1.5.0 ligada)

- 45/45 generated, 0 blocked
- 2 fallbacks exatos (eram 6 com v1.4.0)
- buscarProduto retornando produto: 100% (era 3% antes do Planner-input fix)
- 64,4% dos turns emitiram claims; média 1,4 claims/turn
- Tipos de claim: price 32, stock_availability 24, fitment 4, delivery_fee 1
- 0 `claim_invalid:*` blocks
- Notas: Planner 9/10, Generator 9/10 provisório, Organizadora 8.5/10 provisório

### Estado real do banco em prod (`aoqtgwzeyznycuakrdhp`)

```
agent.session_events:        5909 linhas / 6.4 MB
agent.turns:                 1396 linhas / 2.2 MB
agent.session_slots:          991 linhas / 584 kB
agent.session_current:        486 linhas / 280 kB
agent.session_items:          307 linhas / 192 kB
agent.order_drafts:            41 linhas
agent.escalations:              5 linhas  ← B5 funcionando (era 0)
agent.cart_*:                   0 linhas  (designed, ainda não usado)
agent.pending_confirmations:    0 linhas  (designed, ainda não usado)
analytics.conversation_facts: 2976 linhas
analytics.fact_evidence:     2979 linhas
commerce.products:             78 linhas
commerce.tire_specs:           78 linhas
commerce.vehicle_models:      308 linhas
commerce.vehicle_fitments:    166 linhas
core.messages_2026_05:       1675 linhas
ops.atendente_jobs:          1396 linhas
ops.enrichment_jobs:          554 linhas
ops.agent_incidents:           57 linhas (14 dias)
```

Migrations aplicadas: `0001` até **`0030_vehicle_resolver_variant_precision.sql`**.

---

## Onde Estamos

Atendente em **shadow estendido (Fase D, ADR-008)**. Sistema é capaz de:
- Receber webhook Chatwoot → normalizar → enfileirar jobs (Organizadora + Atendente)
- Organizadora extrai facts em background para `analytics.*`
- Atendente, em cada mensagem do customer:
  - Planner LLM (v1.2.8) decide skill + tools
  - Executor roda tools + auto-chain de verificarEstoque
  - Generator LLM (v1.4.0 default ou v1.5.0 com flag) escreve resposta + emite claims
  - Worker emite escalate sintética quando Planner=escalar_humano
  - Tudo gravado em `agent.turns`, `agent.session_events`, `agent.escalations`
  - **NADA é enviado ao cliente** (envio Chatwoot continua adiado para Sprint 8)

A direção arquitetural está estabilizada. Próximo foco **não é mais tunar prompts** — é coletar dados e operação.

---

## Próximo Passo

**Continue em Fase D estendida (ADR-008):**
1. Wallace atende manual no Chatwoot.
2. Agente continua em shadow gerando candidato.
3. Coletar 2-4 semanas de comparação humano vs bot.
4. Antes de qualquer ajuste novo de prompt, deixar dados acumularem.

**Em paralelo:** os 6 blocos de infra ainda abertos (particões julho/agosto, LGPD, runbook, rate limit, auditoria RLS, reconciliação CLI).

**Sprint 8 (envio Chatwoot):** só depois da Fase D + catálogo comercial completo. `ATENDENTE_SEND_ENABLED` ainda não existe em código.

---

## Como ligar v1.5.0 few-shot em prod

No Coolify:
```
GENERATOR_PROMPT_FEW_SHOT_ENABLED=true
```

Redeploy. Sem essa flag, sistema usa v1.4.0 (default). Rollback trivial: setar `false` e redeploy.

---

## Queries para acompanhamento

**Adoção de claims (mede se Etapa 2 está sendo usada):**
```sql
SELECT
  event_payload->>'prompt_version' AS version,
  COUNT(*) AS turns,
  ROUND(100.0 * COUNT(*) FILTER (WHERE (event_payload->>'claims_count')::int > 0) / COUNT(*), 1) AS pct_with_claims,
  AVG((event_payload->>'claims_count')::int) AS avg_claims
FROM agent.session_events
WHERE event_type = 'generator_produced'
  AND occurred_at >= now() - interval '24 hours'
GROUP BY 1;
```

**Comparação A/B (v1.4.0 vs v1.5.0 quando flag oscilar):**
```sql
SELECT
  event_payload->>'prompt_version' AS version,
  COUNT(*) AS turns,
  AVG((event_payload->>'input_tokens')::int) AS avg_in,
  AVG((event_payload->>'output_tokens')::int) AS avg_out,
  COUNT(*) FILTER (WHERE event_payload->>'blocked' = 'true') AS blocked
FROM agent.session_events
WHERE event_type = 'generator_produced'
  AND occurred_at >= '2026-05-15 00:00:00+00'
GROUP BY 1;
```

**Escalações reais:**
```sql
SELECT reason, status, COUNT(*) FROM agent.escalations GROUP BY 1, 2;
```

---

## O Que NÃO Existe Ainda (Continua)

- Critic (Sprint 7 original): DESCARTADO (ADR-005). SayValidator + ActionValidator + ClaimValidator são o gate síncrono.
- Supervisora batch: ADIADA para Fase G original (ADR-006).
- Envio Chatwoot pela Atendente (Sprint 8): adiado. `ATENDENTE_SEND_ENABLED` ainda NÃO existe.
- Particões julho/agosto 2026 (pg_partman não instalado).
- Endpoint LGPD operacional de erasure.
- Rate limit / circuit breaker de custo OpenAI.
- Catálogo comercial completo (78 produtos técnicos; preço/marca/foto/estoque ainda escasso).
- Atendimento automático real.

---

## Commits Relevantes Desta Sessão

```
6f7e7c5  fix(generator): audit grava prompt_version real (v1.4 ou v1.5)
cc93a05  feat(generator): v1.5.0 few-shot prompt — 10 examples atrás de flag
1edd3a2  feat(generator): audit claims in event_payload + blocked_payload
654c521  chore(zod): remove dead llmAtendenteResponseSchema
408f058  feat(generator): Etapa 2 — structured commercial claims (v1.4.0)
b6bc9d9  refactor(planner): Etapa 3 — remove customer-text regex
9888bd7  feat(worker): B5 — synthesize escalate when Planner=escalar_humano
d0c5da3  fix(zod): B4 — action_id metadata in cart/escalate/confirmation
ce16830  chore(atendente): B1+B2+B3 — safeRollback + dead branch + sha256 UUID
0ba7988  refactor(executor): drop intent regex from auto-chain, go deterministic
0a40e0d  fix(atendente): close 4 residual blockers (fitment hedge, anti-soma, delivery, auto-chain)
4963701  fix(planner): drop hallucinated marca/product_code before buscarProduto
```

Remote `pneus/main` sincronizado.

---

## Pergunta para começar próximo chat

> "Como está o dataset humano vs bot até agora? Quais ajustes de prompt do Generator
> já consigo fazer com base na coleta da Fase D?"

Ou se ainda não houve coleta significativa:

> "O que falta nos 6 blocos de infra paralela (particões, LGPD, runbook, rate limit,
> reconciliação CLI, auditoria RLS)?"

---

## HISTÓRICO (estado anterior, preservado para auditoria)

A documentação anterior (antes desta revisão de 2026-05-15) descrevia o sistema
no estado pós-PR5 com `planner_v1.2.6` e `generator_v1.3.2`, listando:
- Critic descartado (ADR-005), Supervisora adiada (ADR-006), Fase D como
  "próximo passo" (ADR-008) — ainda válido, mas Fase D agora está EM ANDAMENTO,
  não apenas "próxima"
- PRs 1-5 fechados — ainda válido
- Audit doc 2026-05-14 (`docs/AUDITORIA_ATENDENTE_2026-05-14.md`) identificou
  bugs de plumbing pós-migração Responses API — todos resolvidos nesta sessão
  (commits `4963701` em diante)

Versões anteriores deste arquivo no git mantêm o trace completo.
