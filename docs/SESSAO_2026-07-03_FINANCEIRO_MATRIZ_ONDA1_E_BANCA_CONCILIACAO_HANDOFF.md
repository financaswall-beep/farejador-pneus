# SESSÃO 2026-07-03 — Financeiro da Matriz (Onda 1) + Banca de Conciliação + Consertos

> Handoff. Detalhe vivo; o durável destilado vai pro `CLAUDE.md` (§7 e §11) e pra memória privada `project_financeiro_matriz_robusto`.

## TL;DR
- A aba **Financeiro** do painel da matriz virou uma tela **RICA** (não mais só um bloco de despesas): visão consolidada das 3 pernas do mês, "quem te deve", agenda de pagamentos e indicadores de dono — tudo **SÓ LEITURA** das fontes que já existiam (Onda 1). Commit **`c6dfb18`**, DEPLOYADO e conferido de fora (`?v=20260703-financeiro2`, hash prod==main).
- Depois: **banca de 4 especialistas** (matriz+banco+parceiro+seguranca, Opus) auditou se o Financeiro está conciliado com Vendas, Estoque e Rede + segurança. Achou **1 FURO REAL** (cancelar varejo não devolvia o galpão) + 2 robustezes.
- Os 3 achados **CONSERTADOS e PUSHADOS** (commit **`fdd9148`**, `?v=20260703-financeiro3`). **Aguarda 1 Deploy** (junto com o `c6dfb18` se ainda não subiu o financeiro3).

## Contexto que mudou o desenho da sessão
- O dono tinha pedido a Fase A (despesas 0120) na sessão 07-02d. Eu tinha posto o bloco de despesas **dentro de Vendas → Atacado** — LUGAR ERRADO. Correção do dono nesta sessão: **despesas moram na aba FINANCEIRO** do portal da matriz.
- A aba Financeiro estava no menu "Fase 2 · próximos" (cadeado). **Promovida pro menu vivo** (Resumo · Vendas · Compras · **Financeiro** · Rede). A lista Fase 2 agora começa em Estoque.
- O dono achou a tela "pobre" → pedi desenho de especialista financeiro (aprovado) → construí a **Onda 1** (leitura das fontes existentes). Fase B (livro-razão + pagamento parcial + saldo/extrato/projeção) segue adiada com banca antes.

## O que entrou (código)

### Onda 1 — visão consolidada do Financeiro (commit `c6dfb18`)
- **`getMatrizFinanceiroVisao`** (fim de `src/admin/painel/queries.ts`) — 1 GET agrega tudo:
  - **Consolidado do mês:** faturamento das 3 pernas (atacado `getWholesaleResumo` + varejo `getVarejoResumo` custo congelado 0117 + comissão realizada 0118) − despesas por competência (0120); lucro, margem, `itens_sem_custo` (aviso de honestidade).
  - **A RECEBER:** fiado do atacado (0115, linha a linha, **agora com `phone`** do borracheiro pro botão Cobrar) + comissão acumulada por parceiro (0118).
  - **A PAGAR (agenda):** fornecedor (0115) + despesa pendente (0120), ordenado por vencimento (vencido primeiro).
  - **Indicadores:** capital parado (Σ qty×custo médio do galpão), giro, fiado % em aberto, ponto de equilíbrio — todos com **guarda null** (UI mostra "—", não chuta).
- Rota **`GET /admin/api/matriz/financeiro`** (`route.ts`, `requireAdminAuth`). SEM flag própria: cada fatia respeita a flag da sua fonte (WHOLESALE_FINANCE / NETWORK_COMMISSION_LEDGER / MATRIZ_EXPENSES) e vem null com ela off.
- **A visão NÃO roda o sweep** da comissão (de propósito — leitura pura, sem efeito colateral; o sweep estorna lançamento órfão e já roda no boot/GET da Rede).
- Front (`painel/public/`): tela Financeiro nova (cards do pulso + barras das pernas + Quem te deve com Cobrar/Recebi + Agenda com Paguei + indicadores). Botões quitam pelos endpoints EXISTENTES (finance/settle, comissoes/settle, despesas/settle). Carregador `loadFinanceiro()` (visão + despesas juntas), gatilho no `$watch('currentPage')`.
- **Lição de front:** erro de REDE não pode zerar o estado da tela (mantém dado anterior; só `enabled:false` real zera). Uma race de loads concorrentes apagava o bloco de despesas — consertado (`visao ?? this.financeiroVisao`; catch das despesas não seta null).
- Migrations do lote (já aplicadas antes do push): **0119** (índice parcial 2w em partner_orders + trava física de grant no livro de comissão) + **0120** (`commerce.matriz_expenses`, zero grant pro parceiro). Flag **`MATRIZ_EXPENSES`** default OFF.

### Consertos da banca (commit `fdd9148`)
1. **🔴 FURO REAL — cancelar VAREJO da matriz não devolvia o galpão** (achado do `banco`). `commerce.cancel_manual_order` (0032) só marcava status; a baixa do varejo (`applyMatrizGalpaoDecrement`) não tinha espelho no cancelamento. Após o 1º cancelamento de varejo, `capital_parado` ficava < estoque físico.
   - **Conserto (guiado por trilha, resolve a raiz):** `applyMatrizGalpaoDecrement` (`src/atendente-v2/wholesale-stock-read.ts`) agora grava `audit.events 'matriz_galpao_decrement'` com o **DELTA REAL** (CTE `antes`/`depois` + `FOR UPDATE`) — sob clamp, "pedi 5 mas só tinha 3" grava 3, não 5.
   - Nova **`applyMatrizGalpaoReturn`** devolve **guiada pela trilha** (não pelos itens do pedido, não pela flag atual): venda sem trilha (baixou com flag off) → devolve nada (não inventa); segundo cancelamento é idempotente (guard por `matriz_galpao_return`).
   - **Atômica** com o cancelamento (BEGIN/COMMIT) em `cancelManualOrder` (painel, `queries.ts`) e no `cancelar_pedido` do bot (`tools.ts`, SÓ caminho varejo da matriz — pedido de PARCEIRO intocado, galpão nunca foi tocado lá).
   - Isso é **melhor que o atacado (0116)**, cujo clamp assimétrico só a Camada 2 resolve.
2. **🟡 `fiado_aberto_pct` estourava pra 500%** (achado do `matriz`): numerador (header `total_amount`) × denominador (soma de itens `line_total`) eram bases diferentes. **Conserto:** numerador agora soma os ITENS (line_total) das vendas pending — mesma base — + **clamp em 100**.
3. **🟡 giro do estoque inflava no começo do mês** (achado do `banco`): usava custo do mês-calendário. **Conserto:** janela móvel de **30 dias corridos**. Card rotulado "(base 30 dias)".

## Provas (tudo verde)
| Prova | Resultado |
|---|---|
| `scripts/prova-financeiro-visao-test.ts` (nova) | **25/25** — 3 pernas, a receber/a pagar juntos, telefone no Cobrar, indicadores, quitações refletem |
| `scripts/prova-cancel-varejo-galpao-test.ts` (nova) | **11/11** — baixa+trilha+devolução exata+clamp+sem-trilha+idempotente |
| `scripts/prova-despesas-matriz-test.ts` | 15/15 (não-regressão) |
| `scripts/prova-financeiro-atacado-test.ts` | ok (não-regressão; cobre o campo `phone` novo) |
| `npm test` (vitest) | **522/522** (5→9 casos no teste da baixa do galpão) |
| `npm run typecheck` | ✓ |
| Preview 4215 (`matriz-financeiro-4215`) | fluxo completo pela UI, giro "(base 30 dias)", zero erro console/servidor |

Rodar as provas: `npx tsx --env-file=.env.pooler scripts/prova-<nome>-test.ts` (env test, seeds descartáveis, limpa no finally).

## Banca de conciliação — veredictos (relatórios completos nos outputs da sessão)
- **Financeiro × Vendas (`matriz`): CONCILIADO.** 3 pernas em tabelas disjuntas (sem dupla contagem, provado); réguas lista×card idênticas; cancelada some de faturamento/fiado/ranking. Achados 🟡 já consertados (fiado_aberto_pct + latência do sweep — a visão não varre, pode divergir da tela Rede por alguns minutos: latência, não erro).
- **Financeiro × Estoque (`banco`): 1 FURO (consertado).** Cancelar varejo não devolvia o galpão (item acima). Atacado OK (baixa atômica, devolução espelhada). Limitação estrutural esperada: equação completa do galpão por linha não fecha sem trilha = Camada 2.
- **Financeiro × Rede (`parceiro`): CONCILIADO.** Réguas sweep = getPainelRede = view byte a byte; estorno preserva settled_at; total×drill consistentes (hard-delete de parceiro bloqueado por FK). Avisos de NEGÓCIO (não bug): parceiro soft-deletado segue na lista de cobrança.
- **Segurança (`seguranca`): ZERO FURO.** `has_table_privilege` em PROD: zero grant do `farejador_partner_app` em TODAS wholesale_*/commission_entries/matriz_expenses (incl. as 2 views); zero default ACL; todas as rotas /admin/api com auth; bot sem caminho pra dado financeiro; PII (telefone) só pro dono autenticado.

## Flags no Coolify (o dono colou a lista nesta sessão — TODAS on)
`DELIVERY_FREIGHT_FROM_PIN, ROUTING_MATRIZ_AS_STORE, MATRIZ_EXPENSES, NETWORK_COMMISSION_LEDGER, WHOLESALE_MATRIZ_RETAIL_COST, WHOLESALE_FINANCE, WHOLESALE_MATRIZ_OVERSELL_GUARD, WHOLESALE_STOCK_DECREMENT, WHOLESALE_MATRIZ_DECREMENT, WHOLESALE_UNIFIED_STOCK` = todas `true`.
- ⚠️ **A lista colada NÃO tinha as flags do motor** (`AGENT_V2_WORKER_ENABLED`, `ROUTING_GEO`, `ROUTING_GEO_ROAD_DISTANCE`, `ROUTING_PROXIMITY_FIRST`, `PICKUP_TO_PARTNER`, `ROUTING_MULTI_CANDIDATE`, `ROUTING_FAIRNESS`, `PHOTO_REQUESTS`). Como o bot atende/roteia em prod, provavelmente estão mais acima na tela do Coolify — **CONFIRMAR com o dono que essas 8 estão `=true`** (flag ausente = OFF; sem `ROUTING_GEO` o frete pelo pino não tem efeito).
- ⚠️ `WHOLESALE_MATRIZ_OVERSELL_GUARD` foi LIGADA agora (era dormente). Segura — no pior caso trava venda esquisita, nunca inventa. Entra na fila de validar ao vivo junto com o frete pelo pino.

## Estado / o que falta
- **Prod LIVE:** `c6dfb18` deployado e conferido (`financeiro2`). **`fdd9148` (financeiro3) PUSHADO, aguarda Deploy** — os dois commits sobem num Deploy só. Pós-deploy: conferir de fora `?v=20260703-financeiro3` + hash prod==main.
- **Preview de pé:** `matriz-financeiro-4215` (todas as flags + despesas). NÃO derrubar 4213/4214 (outras sessões).
- **5 dos 7 parceiros com `commission_percent` NULL = TESTE** (palavra do dono nesta sessão) — sem ação; não são reais.

## Próximo tijolo — Fase B (o coração, banca ANTES)
Livro-razão de caixa único + pagamento parcial ("recebi R$200 por conta") + saldo/extrato entrou×saiu + projeção de caixa 30d. É a peça que resolve os resíduos da banca: **Camada 2 do galpão** (equação por linha, clamp assimétrico do atacado, devolução de atacado feita antes da flag). Migrations tentativas 0121+. Gate: banca de 4 antes da 1ª linha (regra do dono em obra de dinheiro). Planta: `docs/PLANO_FINANCEIRO_MATRIZ_ROBUSTO_2026-07-02.md`.

— Orquestrador (Claude Fable 5) — domínios `matriz` + `banco` + `bot`
