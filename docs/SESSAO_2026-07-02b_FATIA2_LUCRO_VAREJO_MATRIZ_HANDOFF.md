# SESSÃO 2026-07-02b — Fatia 2 do financeiro: LUCRO REAL do VAREJO da matriz (0117) + recorte por mês

> Continuação da sessão 07-02 (ver `SESSAO_2026-07-02_FRETE_PINO_FIADO_E_CANCELAMENTO_ATACADO_HANDOFF.md`).
> Nesta: (0) push do CANCELAMENTO (`ed82fa5`, ordenado pelo dono), (1) confirmação de que o
> Deploy do fiado JÁ TINHA SIDO FEITO (prod respondeu `?v=20260702-fiado` — fiado VIVO), e
> (2) a FATIA 2 construída e provada: custo do galpão CONGELADO na venda do varejo da matriz.
> Fatia 2 PRONTA LOCAL, **NÃO pushada** — aguarda ordem do dono. Migration 0117 JÁ APLICADA.

---

## 1. O problema (por que fatia 2)

O ATACADO congela o custo na venda (`wholesale_order_items.unit_cost`, 0112) → card de lucro
confiável. O VAREJO da matriz (balcão + bot) não guardava custo nenhum: se o custo médio do
galpão mudar amanhã, o lucro de ontem vira chute. O card de lucro contava só metade do negócio.
Bônus da obra: os cards eram todos "desde sempre" — entrou o recorte **Tudo × Esse mês**.

## 2. O que entrou (tudo atrás da flag `WHOLESALE_MATRIZ_RETAIL_COST`, default OFF)

- **Migration `0117_matriz_retail_cost.sql` — APLICADA** (via `scripts/aplicar-0117.cjs`,
  untracked; banco único): `commerce.order_items.matriz_unit_cost numeric NULL`, aditiva.
  **Sem risco de vazamento**: `commerce.orders`/`order_items` têm ZERO grant pra role de app
  além do sistema (conferido em `role_table_grants` 07-02) — custo da matriz não chega ao parceiro.
- **Helpers na ponte** (`src/atendente-v2/wholesale-stock-read.ts`):
  `getMatrizGalpaoCostByProduct` (produto→tire_specs→tireSizeKey→wholesale_stock.unit_cost;
  entre linhas da mesma chave vale a de MAIOR estoque COM custo; sem custo → fora do mapa) e
  `applyMatrizRetailCostSnapshot` (UPDATE só onde `matriz_unit_cost IS NULL` → retry não
  sobrescreve; flag por parâmetro).
- **3 caminhos de venda da matriz congelam** (parceiro JAMAIS passa):
  1. **Bot** — `insertCommerceOrderMirror` (tools.ts), dentro do `if (!partnerOrderId)`, MESMA
     transação da venda (rollback desfaz junto), ao lado da baixa do galpão.
  2. **Balcão walk-in** — `registerWalkinOrder` (queries.ts), best-effort pós-commit (mesmo
     padrão da baixa), gate `unit_id` vazio/= matriz (slug `main`).
  3. **Manual (Chatwoot)** — `registerManualOrder`: congela quando cai na 'main' (a função SQL
     defaulta unit vazia pra main). ⚠️ NÃO baixa estoque (assimetria PRÉ-EXISTENTE: só walk-in
     e bot baixam) — documentada, não mexida.
- **Resumo do varejo** — `getVarejoResumo(period)` (queries.ts) + rota GET
  `/admin/api/varejo/resumo?period=mes|tudo`. MESMA régua do card/lista (unit `main`, status
  <> 'cancelled'): nunca diverge. **Honestidade:** Custo/Lucro só somam linhas COM custo
  congelado; `itens_sem_custo` conta as de fora e a UI avisa (banner âmbar) em vez de chutar.
- **Recorte por mês** — `period=mes` = mês corrente no fuso **America/Sao_Paulo**;
  `getWholesaleResumo` ganhou o MESMO period (3º parâmetro opcional — assinatura antiga intacta).
- **UI (aba Vendas)** — Varejo: bloco "Financeiro do varejo (Matriz)" (Vendas · Faturamento ·
  Custo (galpão) · Lucro · Canceladas) + toggle Tudo × Esse mês + banner de item sem custo;
  fallback: sem resumo carregado, Faturamento/contagem caem no cálculo local da lista, Custo/
  Lucro mostram "—". Atacado: mesmo toggle no card Faturamento/Custo/Lucro.
  `?v=20260702-varejo-lucro` bumpado.

## 3. Provas (tudo verde)

- `scripts/prova-custo-varejo-matriz-test.ts` **15/15** (integração real, env test, por DELTAS,
  faxina no finally): congela 21.25 · item sem medida fica NULL · custo médio muda p/ 30 e a
  venda SEGUE 21.25 · resumo +400/+42.50/+257.50 · venda de PARCEIRA não congela nem entra ·
  40 dias atrás sai do "mes" e fica no "tudo" · cancelada some · helper seguro.
  Rodar: `WHOLESALE_MATRIZ_RETAIL_COST=true npx tsx --env-file=.env.pooler scripts/prova-custo-varejo-matriz-test.ts`
- vitest **519/519** (7 novos em `tests/unit/atendente/wholesale-stock-read.test.ts`) · typecheck.
- Não-regressão: cancelar 13/13 · fiado 14/14 · baixa do atacado 12/12 · fornecedores 10/10 ·
  prova-geo 9/9 (toquei o caminho do bot).
- **Visual** (preview `matriz-fatia2-4212`, launch.json — env test + flags on): cards
  R$ 400,00 / R$ 42,50 / R$ 257,50 + banner "1 item sem custo congelado" + toggle chamando
  `?period=mes` na rede (200). Demo semeada e LIMPA (`scripts/seed-demo-fatia2.cjs`, untracked).

## 4. Avisos honestos

1. **Números valem DO DEPLOY+FLAG EM DIANTE**: venda antiga não tem custo congelado → aparece
   no banner "sem custo" e fica FORA do Custo/Lucro (nunca reescrever retroativo — retrato é
   retrato). Como commerce.orders está ZERADO em prod (faxina do go-live), na prática começa limpo.
2. **Manual não baixa estoque** (só congela custo) — assimetria pré-existente; se doer, obra à parte.
3. Recorte de mês usa `created_at` (dia do REGISTRO), fuso São Paulo; cancelada fora em qualquer período.
4. O card do varejo agora vem do SERVIDOR (a soma antiga era no navegador, limitada às ~50
   linhas carregadas da lista — enchendo, subcontava).

## 5. Estado / o que falta (ordem)

| Obra | Commit | Deploy | Flag |
|---|---|---|---|
| Cancelamento (0116) | `ed82fa5` PUSHADO | **pendente** (`?v=20260702-cancelar`) | sem flag |
| Fatia 2 (0117) | **NÃO COMMITADA** (working tree) | — | `WHOLESALE_MATRIZ_RETAIL_COST` OFF |

1. Dono manda **push** → commit da fatia 2 (env.ts, wholesale-stock-read.ts, tools.ts,
   queries.ts, route.ts, app.js, index.html, 0117, prova, teste unit, launch.json) + este handoff
   + CLAUDE.md.
2. **Deploy** no Coolify (carrega cancelamento + fatia 2) → conferir `?v=20260702-varejo-lucro`.
3. Ligar **`WHOLESALE_MATRIZ_RETAIL_COST=true`** no Coolify (dá pra ligar junto do Deploy —
   é aditiva e provada; sem ela o card mostra tudo "sem custo").
4. Validar ao vivo: venda de balcão pequena → card Custo/Lucro mexe na hora.
5. Pendências herdadas: validar FIADO ao vivo (já no ar) · botão Cancelar (após Deploy) ·
   raios REAIS das lojas · matar zz-teste · rotacionar chave Google · ligar frete-pino.

## 6. Roadmap de Vendas depois desta

(a) **Comissão virar lançamento** (a receber por parceiro — regras do DONO: quando é devida,
o que faz no cancelamento, percentual por parceiro/editor do modelo comercial); (b) **consolidado
das 3 pernas** (varejo+atacado+comissão — só depois de (a)); (c) ligar+validar
`WHOLESALE_MATRIZ_OVERSELL_GUARD`; (d) validar ENTREGA pela matriz (frete 9,90/13/19).
Adiados de propósito: PEPS por fornecedor; Camada 2 (reserva+livro-razão).

— Orquestrador (Claude Fable 5) — domínios `matriz` + `bot` + `banco`, 2026-07-02
