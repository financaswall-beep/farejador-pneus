# Etapa 1 — Correção dos 3 bugs vermelhos do financeiro (Portal Parceiro)

**Data:** 2026-05-24
**Plano-mãe:** `docs/PLANO_RECONCILIACAO_FINANCEIRO_PARCEIRO_2026-05-24.md`
**Migration:** `db/migrations/0050_partner_finance_fixes_etapa1.sql`
**Arquivos código:** `src/parceiro/queries.ts`, `src/parceiro/route.ts`, `parceiro/public/app.js`, `parceiro/public/index.html`

## Bug #1 — Cancelar venda não cancelava conta a receber vinculada

### Antes
A venda "a receber" criava `finance.partner_receivables` (idempotency_key = `'order:UUID:receivable'`). `commerce.cancel_partner_local_order` só restaurava estoque e marcava a venda como `'cancelled'`. A receivable ficava órfã em `'open'` — usuário podia clicar "recebi" e registrar entrada de dinheiro de venda inexistente. Trail contábil quebrado.

### Depois
Migration `0050` recria `commerce.cancel_partner_local_order` adicionando:

```sql
UPDATE finance.partner_receivables
SET status = 'cancelled', deleted_at = now(), deleted_by = p_actor_label
WHERE idempotency_key = 'order:' || p_order_id || ':receivable'
  AND environment = v_environment
  AND unit_id = v_unit_id
  AND status = 'open'
  AND deleted_at IS NULL
RETURNING id INTO v_receivable_id;
```

Se houve cancelamento, emite `audit.events` tipo `partner_receivable_cancelled_by_sale_cancel` com `source_order_id` e `reason`. Tudo na mesma transação do cancelamento da venda.

**Migração para Etapa 2:** essa lógica vai ser reescrita com FK `source_order_id` (mais robusta que string match no `idempotency_key`). O comportamento permanece igual.

## Bug #2 — Pagamento a fornecedor virava "manutenção"

### Antes
`payableCategoryToExpenseCategory` mapeava:
```ts
supplier: 'maintenance'
```
Porque o enum de `partner_expenses` não tinha categoria `'supplier_payment'`. Resultado: pagar fornecedor de pneu sumia do relatório "gastei X com fornecedores".

### Depois
- Migration `0050`: adiciona `'supplier_payment'` ao CHECK de `partner_expenses.category`
- `queries.ts`: mapeamento `supplier → 'supplier_payment'`
- `RegisterPartnerExpenseInput['category']` ganha `'supplier_payment'`
- `parceiro/public/app.js`: `categoryLabel('supplier_payment') = 'Fornecedor'`

## Bug #3 — Pagar payable podia contar despesa em dobro

### Antes
`settlePartnerPayable` sempre inseria uma linha em `partner_expenses` com `idempotency_key = 'payable:UUID:expense'`. Idempotência protegia contra retry do mesmo payable, mas **não** protegia contra: usuário cadastra despesa manualmente, depois cadastra payable, depois marca payable como pago → resumo do mês conta a despesa duas vezes.

### Depois
Antes de inserir a despesa, busca duplicatas:

```sql
SELECT id, expense_date, amount, description
FROM finance.partner_expenses
WHERE environment = $1 AND unit_id = $2
  AND deleted_at IS NULL
  AND lower(trim(description)) = lower(trim($3))
  AND amount = $4::numeric
  AND expense_date BETWEEN (paid_at - 7 days) AND (paid_at + 7 days)
  AND (idempotency_key IS NULL OR idempotency_key <> 'payable:UUID:expense')
LIMIT 5;
```

Se achar alguma, lança `DuplicateExpenseError`. `route.ts` converte em HTTP `409 { error: 'duplicate_expense', duplicates: [...] }`.

Frontend (`app.js > settlePayable`):
1. Tenta pagar com `force_duplicate: false`
2. Se receber 409 com `duplicate_expense`, exibe `confirm()` listando as duplicatas suspeitas
3. Se usuário confirma, retenta com `force_duplicate: true`
4. Se nega, mostra flash pedindo pra conferir despesas antes de marcar como paga

A trava é **soft** (usuário pode forçar). A trava **hard** (FK) virá na Etapa 2.

## Verificação

- `npx tsc --noEmit` passou sem erros.
- Migration `0050` não destrói dados; só DROP+ADD do CHECK constraint e CREATE OR REPLACE da função.
- Cache-bust do `app.js` bumpado para `v=20260524-financeiro-parceiro-3`.

## Pendências reconhecidas (Etapa 2+)

- Bug #1 e #3 ainda dependem de string-match no `idempotency_key`. Etapa 2 substitui por FK formal (`source_order_id`, `source_payable_id`) — mais robusto, queries mais simples, cancelamento em cascade via constraint.
- Sem testes de integração novos para Etapa 1. Recomenda-se adicionar antes do deploy: cenário "vende a receber → cancela venda → receivable cancelada"; cenário "cadastra despesa manual + payable + paga → 409"; cenário "supplier payment cai na categoria certa".
