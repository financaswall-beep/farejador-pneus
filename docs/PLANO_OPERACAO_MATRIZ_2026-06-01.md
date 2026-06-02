# Plano de Operação — Matriz real + morte do V1

**Data:** 2026-06-01 · **Autor:** Claude (Opus 4.8) sob direção do Wallace
**Objetivo:** dar à matriz um **Resumo real** (negócio da rede + performance do tráfego/bot)
lendo o que o sistema **já gera automaticamente**, e **matar o V1 morto** do painel —
**sem encostar em nada que o Agent V2 / analytics usa**.

---

## 0. CONTRATO DE SEGURANÇA (o intocável)

> A matriz **só LÊ** dos domínios do bot/analytics. **NUNCA** `CREATE/ALTER/DROP`,
> nunca trigger, nunca função, nunca dado. Consumo read-only puro.

**NÃO TOCAR (V2 depende — quebra o bot/as métricas):**
- Schemas: `agent.*` (`turns`, `session_current`), `analytics.*` (todas as tabelas, MVs e
  views: `conversation_facts/classifications/signals`, `customer_journey`, `fact_evidence`,
  `linguistic_hints`, `*_mv`, `v_daily_metrics`, `v_top_*`, `v_clientes_pra_recuperar`,
  `v_conversation_summary`, `current_*`), `core.*` (normalização do Chatwoot), `raw.*`.
- Código: `src/atendente-v2/*`, `src/enrichment/*` (pipeline de métricas),
  `src/normalization/*`, `src/webhooks/*`, `src/shared/repositories/ops-atendente.repository.ts`.
- Triggers conhecidos: imutabilidade/env em `analytics.fact_evidence` (e quaisquer outros) —
  **não mexer**.
- Workers: `worker.ts`, `startAgentV2Worker`, reconciler, notify hub.

**Regra de ouro:** se algo é lido por `atendente-v2`, `enrichment`, `normalization` ou
`webhooks` → é V2 → **só leitura, jamais alterar**.

---

## 0.1 Fluxo de dado — `analytics` DERIVA do V2 (por isso ler é seguro)

`analytics` **não é fonte própria** — é uma **camada de métrica derivada**, construída em
cima do V2 (turns/conversas), do Chatwoot normalizado (`core.*`) e das vendas
(`commerce.orders`). A matriz lê **a jusante**, no resultado já mastigado.

```
Chatwoot → webhook → normalização → core.conversations / core.contacts / core.messages
                                          │
                        bot V2 responde → agent.turns / agent.session_current
                                          │
            src/enrichment/*  LÊ tudo isso e ESCREVE em:
              analytics.conversation_facts / signals / classifications / customer_journey (+ MVs)
                                          │
            Views agregam (READ-ONLY):
              v_conversation_summary → v_daily_metrics, v_top_*, v_clientes_pra_recuperar
```

Composição confirmada do `analytics.v_conversation_summary` (base do resumo):
- `core.conversations` + `core.contacts` → conversa / cliente
- `analytics.conversation_signals_mv` → mensagens, tempo de resposta, tokens, **custo do bot**, handoff
- `analytics.customer_journey_mv` → recorrência, nº de pedidos, **LTV**
- `commerce.orders` (join por `source_conversation_id`) → se **fechou venda** + faturamento
- `analytics.conversation_facts` → bairro / município (fatos extraídos)

E `v_daily_metrics` = só um `GROUP BY dia` de `v_conversation_summary`.

**Consequência pro plano:** a matriz consome essa camada agregada (read-only). **Nunca**
toca a fonte (V2/`core`) nem o `enrichment` que enche o `analytics`. Ler não altera o
pipeline — risco zero pras métricas automáticas.

---

## 1. O que é V1 MORTO (pode matar)

Fronteira confirmada por busca no código: o V1 do painel está **contido** em
`src/admin/painel/{route.ts,queries.ts}` + `painel/public/*`. Nada fora disso usa.

**Morto / quebrado (alvo de remoção):**
- `getPainelResumo` → lê `dashboard.resumo_hoje` (**não existe em prod**; depende de
  `agent.order_drafts/escalations` que **não existem** — modelo V1).
- `getPainelOperacao` → lê `dashboard.operacao_ativa` (idem; depende de `agent.session_slots`).
- Mock no front (`painel/public/app.js`): blocos de dados fake (resumo/operação/shadow).
- Abas "Operação" V1 no front.

**Avaliar (funcionam, decidir manter/retirar):**
- `getPainelPedidos`/`dashboard.pedidos_recentes` (existe e responde 200) — pedidos
  registrados no painel (varejo da matriz). Manter se ainda usado.
- `getPainelProdutos` (200) — catálogo. Manter se usado.
- `getPainelShadow`/`dashboard.shadow_pairs` (não existe em prod, mas é **recuperável**:
  só precisa de `ops.human_vs_bot_comparison` (existe) + tabela nova `ops.human_bot_reviews`).
  Decisão: criar read-only só se quiser monitorar o bot; senão retirar.

> Nenhum `DROP` em prod é necessário: as views V1 (`resumo_hoje`, `operacao_ativa`) **não
> existem** lá. "Matar V1" = remover os **caminhos de código** e o **mock**, não dropar banco.

---

## 2. O que CONSTRUIR — Resumo real da matriz

Fonte de dados, tudo **read-only** e **já populado**:

| Bloco do Resumo | View (read-only) | Mostra |
|---|---|---|
| Performance do tráfego/bot | `analytics.v_daily_metrics` | conversas, conversão %, faturamento, ticket, tempo de resposta, **custo do bot (R$)** por dia |
| Negócio da rede | `network.partner_unit_summary` | vendas/resultado/caixa por loja + consolidado (já real) |
| Leads a recuperar | `analytics.v_clientes_pra_recuperar` | quem esfriou (telefone, moto, último preço, motivo) |
| O que o tráfego pede | `analytics.v_top_produtos / v_top_motos / v_top_bairros` | insight de compra/anúncio |

---

## 3. Fases de execução

### Fase 0 — Congelar o intocável (✅ já mapeado)
- Lista do §0 é o contrato. Qualquer SQL na matriz é `SELECT`. Confirmado: só
  `admin/painel` consome o V1; `atendente-v2`/`enrichment` consomem o V2 (não serão tocados).

### Fase 1 — Backend: endpoint read-only do resumo
- Novo `getMatrizResumo()` em `src/admin/painel/queries.ts` (função NOVA, não mexe nas V1
  ainda): `SELECT` em `analytics.v_daily_metrics` (janela configurável), `network.partner_unit_summary`,
  `analytics.v_clientes_pra_recuperar`, `v_top_*`. Pool de leitura padrão.
- Nova rota `GET /admin/api/dashboard/matriz-resumo` (auth admin), defensiva: se uma view
  faltar, retorna o bloco vazio em vez de 500 (try/catch por bloco).

### Fase 2 — Front: Resumo novo + resiliência
- `painel/public/app.js`: `loadDashboard` vira **`Promise.allSettled`** — um endpoint
  quebrado nunca mais derruba tudo pro mock; cada aba trata seu próprio erro.
- Aba "Resumo" passa a ler `/matriz-resumo` e renderizar os 4 blocos reais.
- Remover o **mock** do resumo/operação/shadow (deixar estados "sem dados" honestos).

### Fase 3 — Aposentar o V1 (código)
- Remover `getPainelResumo`/`getPainelOperacao` (e rotas) que apontam pras views mortas.
- Remover a aba "Operação" V1 do front e os arrays mock.
- `getPainelShadow`: criar a versão read-only (se decidido manter) OU remover.
- **Sem DROP em prod** (nada V1 existe lá pra dropar).

### Fase 4 — Validação (provar que o V2 não quebrou)
- `npm run typecheck` + `npm run test` verdes.
- Subir `matriz-prod` (preview enxuto, **sem workers**) e conferir: Resumo real renderiza,
  nada de mock, nenhuma chamada de escrita em `analytics/agent/core`.
- Conferir que o **servidor de produção** (com workers) continua: bot processa (agent.turns
  cresce), pipeline de enrichment roda (analytics atualiza) — **nada disso é tocado pelo
  nosso código**, então é só confirmação de não-regressão.
- Checagem read-only: nenhuma migration nova no domínio bot/analytics; só código de app.

---

## 4. Rollback

- Tudo é **código + leitura**. Reverter = `git revert` do commit. **Zero** mudança de banco
  no domínio bot/analytics ⇒ rollback não tem risco de dado.
- O mock removido fica no histórico do git se precisar voltar.

---

## 5. Princípios honrados

- **Silo & camadas:** matriz lê `network.*` (rede) e `analytics.*`/`agent.*` (bot) — nunca
  escreve neles.
- **V2 sagrado:** o pipeline que transforma atendimento em métrica (`enrichment` + triggers
  em `analytics`) **não é tocado** — a matriz só colhe o resultado.
- **Confiança:** acabou o mock; tela mostra dado real ou "sem dados", nunca fake.

---

## 6. Decisões pendentes (rápidas) antes de codar

1. **Janela do Resumo:** hoje / 7d / 30d (default 7d?).
2. **Shadow:** manter (crio `ops.human_bot_reviews` + view read-only) ou aposentar?
3. **Pedidos/Produtos (varejo da matriz):** manter as abas ou focar 100% na rede + tráfego?

*Pronto para executar a partir da Fase 1 assim que as 3 decisões acima forem batidas.*
