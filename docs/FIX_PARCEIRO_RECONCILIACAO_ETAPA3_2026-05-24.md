# Etapa 3 — Compra a prazo cria conta a pagar (sem dupla contagem)

**Data:** 2026-05-24
**Plano-mãe:** `docs/PLANO_RECONCILIACAO_FINANCEIRO_PARCEIRO_2026-05-24.md`
**Migration:** `db/migrations/0052_partner_purchase_payment_status_etapa3.sql`
**Código:** `src/parceiro/queries.ts`, `src/parceiro/route.ts`, `parceiro/public/app.js`, `parceiro/public/index.html`

## O que mudou

Antes da Etapa 3, compra de fornecedor "a prazo" não existia no fluxo — o parceiro tinha que registrar a compra (atualiza estoque + entra em `purchases_month`) e separadamente cadastrar uma conta a pagar manualmente, sem ligação nenhuma. Resultado: duplicação de trabalho, sem rastreio.

Agora a compra tem dois modos: **pago na hora** (default, igual antes) ou **a prazo**.

## Mudanças

### Banco (migration 0052)

- `commerce.partner_purchases.payment_status TEXT NOT NULL DEFAULT 'paid_now'` com CHECK `IN ('paid_now', 'payable')`
- `commerce.partner_purchases.payable_due_date DATE` (nullable)
- CHECK obrigando `payable_due_date IS NOT NULL` quando `payment_status = 'payable'`
- Default `'paid_now'` preserva o comportamento atual de toda compra existente.

### Aplicação (`queries.ts`)

**`registerPartnerPurchase`:**
- Aceita `payment_status` e `payable_due_date` no input
- Quando `'payable'`, grava `payment_method = 'A pagar'` na compra e cria `finance.partner_payable` com:
  - `category = 'supplier'`
  - `source_purchase_id = purchaseId` (FK da Etapa 2 — `UNIQUE` parcial garante 1 payable por compra)
  - `idempotency_key = 'purchase:UUID:payable'` (mantido pra idempotência HTTP)
- Emite `audit.events` tipo `partner_payable_auto_created`

**`settlePartnerPayable`:**
- Quando o payable tem `source_purchase_id` preenchido, **não cria expense**. A compra já foi contabilizada como saída no momento da compra (entra em `purchases_month`). Criar expense aqui contaria a saída duas vezes.
- Emite `audit.events` com `expense_skipped: 'origin_is_purchase'`
- (Limitação: a view de resumo da Etapa 4 vai reescrever a lógica pra separar competência vs caixa de fato. Por enquanto a regra "compra entra como custo no momento da compra" preserva o comportamento atual sem duplicar.)

**`deletePartnerPurchase`:**
- Cancela payable vinculado (`UPDATE WHERE source_purchase_id = ... AND status = 'open'`)
- Mesma lógica que `cancel_partner_local_order` faz pra receivable de venda
- Emite `audit.events` tipo `partner_payable_cancelled_by_purchase_delete`

**`getPartnerCompras`:**
- Devolve `payment_status` e `payable_due_date` pra UI mostrar.

### Route (`route.ts`)

- `purchaseSchema` aceita `payment_status` (`'paid_now' | 'payable'`) e `payable_due_date` (date string)
- `.refine()` exige `payable_due_date` quando `payment_status='payable'`
- `expenseSchema.category` ganha `'supplier_payment'` (alinhamento com Etapa 1)

### Frontend (`app.js` + `index.html`)

- `purchaseForm` ganha `payment_status` (default `'paid_now'`) e `payable_due_date`
- Form de compra exibe dois novos campos: select "Pagamento" (Pago na hora / A prazo) e input "Vencimento" condicional
- Validação client-side: se `'payable'` sem `payable_due_date`, mostra flash e bloqueia
- Botão muda label: "Salvar compra a prazo" vs "Salvar compra e atualizar estoque"
- Flash de sucesso distingue os dois casos
- Cache-bust → `v=20260524-financeiro-parceiro-4`

## Cenários cobertos

| Ação do parceiro | O que acontece |
|---|---|
| Compra à vista | Estoque sobe, custo do mês sobe (`paid_now`, igual antes) |
| Compra a prazo | Estoque sobe, custo do mês sobe, **payable criado com vencimento** |
| Pagar payable de compra | Payable vira `paid`, **não cria expense** (sem dupla contagem) |
| Pagar payable manual (rent, employee, etc) | Payable vira `paid`, **cria expense** com `source_payable_id` (Etapa 1+2) |
| Cancelar compra a prazo | Estoque devolve, **payable vinculado é cancelado** em cascade |
| Cancelar venda a receber | Receivable vinculada é cancelada (Etapa 1+2) |

## Verificação

- `npx tsc --noEmit` passou.
- Migration é idempotente (`ADD COLUMN IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS` antes de `ADD`).
- UNIQUE parcial `partner_payables_source_purchase_uniq` (criado na Etapa 2) impede 2 payables pra mesma compra.

## Pendências reconhecidas

- A view `network.partner_unit_summary` ainda soma `partner_purchases.total_amount` em `purchases_month` independentemente de `payment_status`. Isso é deliberado nesta etapa — o resumo no modelo atual ainda é "compra entra como custo no momento da compra". A **Etapa 4** vai reescrever o resumo separando:
  - **Competência:** vendas confirmadas − compras confirmadas − despesas
  - **Caixa realizado:** recebimentos efetivos − pagamentos efetivos
  - **Posição futura:** receivables em aberto, payables em aberto, saldo projetado
- Sem testes de integração novos para Etapa 3. Cenários para adicionar:
  - registrar compra a prazo → confirmar payable criado com `source_purchase_id`
  - pagar payable de compra → confirmar que expense não é criada
  - cancelar compra a prazo → confirmar payable cancelado
  - registrar compra a prazo sem `payable_due_date` → erro 400
