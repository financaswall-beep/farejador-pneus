# Etapa 5 — Fluxo de caixa projetado por bucket de vencimento

**Data:** 2026-05-24
**Plano-mãe:** `docs/PLANO_RECONCILIACAO_FINANCEIRO_PARCEIRO_2026-05-24.md`
**Migration:** `db/migrations/0054_partner_cash_flow_projection_etapa5.sql`
**Código:** `src/parceiro/queries.ts` (`getPartnerFluxoCaixa`), `src/parceiro/route.ts` (`/api/fluxo-caixa`), `parceiro/public/app.js`, `parceiro/public/index.html` (4 cards)

## O que mudou

Nova view `network.partner_cash_flow_projection` agrega payables/receivables em aberto por bucket de vencimento (calculado em `America/Sao_Paulo`):

| Bucket | Critério |
|---|---|
| `overdue` | `due_date < hoje` |
| `today` | `due_date = hoje` |
| `next_7d` | `hoje < due_date ≤ hoje + 7` |
| `next_30d` | `hoje + 7 < due_date ≤ hoje + 30` |
| `later` | `due_date > hoje + 30` OU `due_date IS NULL` |

Para cada bucket: `_in` (receivables), `_out` (payables), `_net` (in − out), `_in_count`, `_out_count`.

## Endpoint

`GET /parceiro/:slug/api/fluxo-caixa` → devolve `{ rows: [row_da_unidade] }`.

## Frontend

Adicionada uma fileira de **4 cards** no topo da aba financeiro, antes dos cards existentes:
- **Vencido** (borda rosa, ícone alerta)
- **Hoje** (borda âmbar, ícone calendário)
- **Próximos 7d**
- **Próximos 30d**

Cada card mostra o net do bucket + breakdown in/out + contagem.

## Cobertura

A view responde "quanto vai entrar/sair em cada janela" — propósito principal de ter contas a pagar/receber separadas. Antes, o `due_date` existia mas não havia agregação consumível.

## Verificação

- `npx tsc --noEmit` passou.
- View tem `security_invoker = true` (RLS estrita preservada).
- Etapa 6 substitui esta view por uma versão que usa `partner_receivables_effective` (considera parcelas).

## Pendência reconhecida

- Bucket `later` agrupa "due_date > 30d" e "due_date NULL" no mesmo balde — pode confundir. Em iteração futura, separar em `later_dated` e `no_date`.
