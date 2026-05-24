# Plano de reconciliação financeira — Portal Parceiro

**Data:** 2026-05-24
**Escopo:** Borracharia pequena (pneu usado/novo), controle interno do caixa. **Sem NFe, sem ERP**.

## Diagnóstico (resumo)

O financeiro do parceiro hoje (vendas, compras, despesas, contas a pagar, contas a receber) opera em nível MVP funcional. A ligação entre essas peças é frágil:

- venda → conta a receber: só por `idempotency_key` (sem FK)
- pagar conta → despesa: só por `idempotency_key` (sem FK)
- compra → conta a pagar: **não existe**
- resumo do mês mistura competência e caixa de forma incoerente

Detalhamento completo nos logs da sessão 2026-05-24 (avaliação ponto a ponto, validada por LLM secundário).

## Decisão estratégica

Não fazer ERP. Não fazer NFe. Fazer financeiro **simples e amarrado**:

- venda ligada à conta a receber (cascade no cancelamento)
- compra ligada à conta a pagar
- pagamento ligado à despesa, sem dupla contagem
- painel separa "vendido" de "recebido" e "comprado" de "pago"
- fluxo de caixa projetado por data

## Etapas

### Etapa 1 — Parar o sangramento ✅ aplicada 2026-05-24
Os 3 bugs vermelhos. Sem isso, qualquer coisa que vier em cima cresce torta.

- Cancelar venda cancela receivable vinculada (migration `0050`, função `commerce.cancel_partner_local_order`)
- Categoria `supplier_payment` em `partner_expenses` + mapeamento corrigido
- Trava de duplicidade no `settlePartnerPayable` com confirmação no frontend

Detalhes: `docs/FIX_PARCEIRO_RECONCILIACAO_ETAPA1_2026-05-24.md`.

### Etapa 2 — FKs reais ✅ aplicada 2026-05-24
Substituiu a gambiarra de `idempotency_key` por FK formal:

- `finance.partner_receivables.source_order_id UUID REFERENCES commerce.partner_orders(id)`
- `finance.partner_payables.source_purchase_id UUID REFERENCES commerce.partner_purchases(id)`
- `finance.partner_expenses.source_payable_id UUID REFERENCES finance.partner_payables(id)`
- Backfill executado via regex no `idempotency_key` existente
- `commerce.cancel_partner_local_order` reescrita pra usar FK em vez de string
- Trava de duplicidade em `settlePartnerPayable` migrada pra FK
- UNIQUE parcial impede duplicidade auto; env_match triggers nas novas FKs

Migration: `db/migrations/0051_partner_finance_fks_etapa2.sql`. Detalhes: `docs/FIX_PARCEIRO_RECONCILIACAO_ETAPA2_2026-05-24.md`.

### Etapa 3 — Compra a prazo ✅ aplicada 2026-05-24
- `commerce.partner_purchases` ganhou `payment_status` (`'paid_now'` default, `'payable'`) e `payable_due_date`
- Compra `'payable'` cria `partner_payable` com `source_purchase_id` preenchido (FK da Etapa 2)
- `settlePartnerPayable` pula criação de expense quando o payable veio de compra (evita dupla contagem)
- `deletePartnerPurchase` cancela payable vinculado em cascade
- Form de compra ganhou select "Pagamento" e input "Vencimento" condicional

Migration: `db/migrations/0052_partner_purchase_payment_status_etapa3.sql`. Detalhes: `docs/FIX_PARCEIRO_RECONCILIACAO_ETAPA3_2026-05-24.md`.

### Etapa 4 — Resumo em 3 blocos ✅ aplicada 2026-05-24
`partner_unit_summary` recriada com 3 blocos:
- **Competência:** `sales_month`, `purchases_month`, `expenses_month`, `result_competencia_month`
- **Caixa realizado:** `cash_in_month`, `cash_out_month`, `cash_net_month` (anti-dupla-contagem com Etapas 1-3)
- **Posição futura:** `open_receivables_total`, `open_payables_total`, `net_future_position`
- Campos legados preservados (`estimated_result_month` etc)

Migration: `0053`. Frontend: fileira de 3 cards na aba financeiro. Detalhes: `docs/FIX_PARCEIRO_RECONCILIACAO_ETAPA4_2026-05-24.md`.

### Etapa 5 — Fluxo de caixa projetado ✅ aplicada 2026-05-24
Nova view `network.partner_cash_flow_projection` agrega payables/receivables em aberto por bucket (`overdue`/`today`/`next_7d`/`next_30d`/`later`). Endpoint `GET /api/fluxo-caixa`. UI: 4 cards no topo do financeiro com net por bucket + breakdown in/out + contagem.

Migration: `0054`. Detalhes: `docs/FIX_PARCEIRO_RECONCILIACAO_ETAPA5_2026-05-24.md`.

### Etapa 6 — Parcelas ✅ aplicada 2026-05-24
Nova tabela `finance.partner_receivable_installments` filha de `partner_receivables`. Form de venda aceita N parcelas (1-36, +30d entre cada). Cada parcela tem `due_date`/`amount`/`status` próprios. Trigger fecha receivable mãe quando todas resolvem. View auxiliar `partner_receivables_effective` permite agregadores tratarem parcelas como receivables individuais. Endpoint `POST /api/contas-a-receber/:id/parcelas/:installmentId/receber`.

Migration: `0055`. UI: input "Parcelas" no form + lista expandida de parcelas em cada receivable. Detalhes: `docs/FIX_PARCEIRO_RECONCILIACAO_ETAPA6_2026-05-24.md`.

## Resumo das migrations

| # | Etapa | Migration |
|---|---|---|
| 1 | Bugs vermelhos | `0050_partner_finance_fixes_etapa1.sql` |
| 2 | FKs reais | `0051_partner_finance_fks_etapa2.sql` |
| 3 | Compra a prazo | `0052_partner_purchase_payment_status_etapa3.sql` |
| 4 | Resumo 3 blocos | `0053_partner_summary_3_blocos_etapa4.sql` |
| 5 | Fluxo de caixa | `0054_partner_cash_flow_projection_etapa5.sql` |
| 6 | Parcelas | `0055_partner_receivable_installments_etapa6.sql` |

Aplicar **na ordem**. Todas idempotentes (`CREATE OR REPLACE`, `IF NOT EXISTS`, `DROP IF EXISTS`).

## Fixes pós-revisão Codex ✅ aplicados 2026-05-24

Codex revisou o pacote 1-6 e flagrou 4 problemas. 3 corrigidos (bugs que vazariam número errado em prod), 1 reconhecido como dívida pré-existente e movido pra Etapa 7.

**#1 (CONFIRMADO):** `registerPartnerPayable` com `status='paid'` criava expense sem `source_payable_id` → dupla contagem em `cash_out_month`. Corrigido via helper interno `_settlePartnerPayableWithClient` compartilhado entre `registerPartnerPayable` e `settlePartnerPayable` (mesma transação, evita race de visibilidade que aconteceria se chamasse `settlePartnerPayable` direto).

**#2 (CONFIRMADO):** Parcelas com `totalCents < installments` violavam `CHECK (amount > 0)` → INSERT quebrava. Retry HTTP sem `ON CONFLICT` estourava `UNIQUE (receivable_id, sequence)`. Corrigido com `InstallmentsTooSmallError` (→ 400) + `ON CONFLICT DO NOTHING`.

**#3 (CONFIRMADO):** `deletePartnerPurchase` não bloqueava compra com payable já pago → pagamento órfão. Corrigido com `PaidPurchaseLockedError` (→ 409) bloqueando o delete.

**#4 (mini-trava):** `deletePartnerPurchase` apagava compra mesmo quando não conseguia estornar todos os itens de estoque. Corrigido com `PartialStockReversalError` (→ 409) abortando o delete inteiro. Fix estrutural fica em **Etapa 7** abaixo.

Detalhes: `docs/FIX_PARCEIRO_RECONCILIACAO_POS_CODEX_2026-05-24.md`. Zero migration nova — todos os fixes são app-layer.

## Etapa 7 (futura) — FK direta em `partner_purchase_items`

Dívida pré-existente: `cancelPartnerSale`/`deletePartnerPurchase` casam estoque por `(item_name, supplier_name, tire_size, brand)` em vez de FK direta. Tornar isso estrutural exige:
- `ALTER TABLE commerce.partner_purchase_items ADD COLUMN partner_stock_id UUID REFERENCES commerce.partner_stock_levels(id)`
- Backfill quando o match atual funciona
- Refatorar `deletePartnerPurchase` pra estornar item por item via FK
- Same para `cancel_partner_local_order` em vendas (provavelmente já está OK, mas conferir)

Mini-trava da Fix #4 cobre o risco operacional imediato: hoje, se algum item não casa, o delete aborta inteiro em vez de apagar a compra deixando estoque inconsistente.

## Status: 100% implementado (Etapas 1-6 + Fixes pós-Codex)

Próximos passos sugeridos antes de subir:
1. Aplicar as 6 migrations em ambiente de teste; rodar suíte existente (`tests/integration/partner-*.test.ts`)
2. Adicionar testes de integração para cenários listados nos docs de cada etapa (incluindo `docs/FIX_PARCEIRO_RECONCILIACAO_POS_CODEX_2026-05-24.md` seção "Cenários de smoke test")
3. Smoke test no Portal Parceiro: vender a prazo 3x, receber 2 parcelas, conferir resumo/fluxo; tentar apagar compra paga; tentar parcelar R$ 0,02 em 3x
4. Aplicar em prod em janela calma
5. **Etapa 7** entra no backlog separado, sem bloquear esta entrega

## Itens deliberadamente fora de escopo

- NFe / NFC-e (loja não emite nota fiscal de pneu)
- Conta bancária como entidade + conciliação OFX
- Comissão de vendedor
- Devolução parcial de venda
- Múltiplas formas de pagamento na mesma venda
- Lock contábil de período
- Centro de custo

Esses ficam parqueados. Podem voltar se o produto for evoluir pra SaaS pra outras borracharias — não é o caso hoje.
