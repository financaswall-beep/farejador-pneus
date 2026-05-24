# Fixes pós-revisão Codex — Reconciliação Financeira Portal Parceiro

**Data:** 2026-05-24
**Plano-mãe:** `docs/PLANO_RECONCILIACAO_FINANCEIRO_PARCEIRO_2026-05-24.md`
**Briefing original ao Codex:** `docs/CODEX_BRIEFING_RECONCILIACAO_FINANCEIRO_2026-05-24.md`
**Arquivos:** `src/parceiro/queries.ts`, `src/parceiro/route.ts`, `parceiro/public/app.js`, `parceiro/public/index.html`
**Migrations novas:** zero — só app-layer

Codex revisou o pacote 1-6 e flagrou 4 problemas. 3 confirmados como bugs reais (deixam número errado em prod), 1 reconhecido como dívida pré-existente. Este doc detalha o que mudou em resposta.

## Fix #1 — Helper interno `_settlePartnerPayableWithClient`

**Problema apontado:** `registerPartnerPayable` quando recebia `status='paid'` criava o payable + criava expense **sem `source_payable_id`**. A view nova somava expenses com `source_payable_id IS NULL` E payables `paid_at no mês` → dupla contagem no `cash_out_month`.

**Correção:** consolidar em caminho único. Codex levantou risco técnico de `registerPartnerPayable` chamar `settlePartnerPayable` direto: abriria novo `withPartnerContext`, nova connection, nova transação → conta recém-criada poderia não estar visível. Abordagem certa: helper interno compartilhado.

**Implementação:**

```ts
// Helper privado — recebe client/transação já aberta
async function _settlePartnerPayableWithClient(
  client: PoolClient,
  ctx: PartnerContext,
  payableId: string,
  input: SettlePartnerPayableInput,
): Promise<{ payable_id: string; paid: boolean }> {
  // ... corpo do antigo settlePartnerPayable, sem o withPartnerContext wrapper ...
}

// Público — wrapper que abre transação
export async function settlePartnerPayable(ctx, payableId, input) {
  return withPartnerContext(ctx.partnerUnitId, async (client) => {
    return _settlePartnerPayableWithClient(client, ctx, payableId, input);
  });
}

// registerPartnerPayable — SEMPRE insere em 'open', depois chama helper se foi pedido 'paid'
export async function registerPartnerPayable(ctx, input) {
  return withPartnerContext(ctx.partnerUnitId, async (client) => {
    // INSERT em 'open' (mesmo se input.status='paid')
    // ... audit event "partner_payable_created" com requested_paid: wantedStatus === 'paid' ...
    if (wantedStatus === 'paid') {
      await _settlePartnerPayableWithClient(client, ctx, payableId, {
        paid_at: input.paid_at,
        payment_method: input.payment_method,
        force_duplicate: input.force_duplicate,
      });
    }
    return { payable_id: payableId };
  });
}
```

**Ganhos:**
- Um caminho único pra criar expense vinda de payable → `source_payable_id` sempre preenchido
- Trava de duplicidade (`DuplicateExpenseError`) e skip para origem-compra reaproveitados
- Audit simétrico: `partner_payable_created` (status='open') + `partner_payable_paid` (do helper)
- Schema do payable ganhou `force_duplicate: boolean` (opcional)
- Endpoint `POST /contas-a-pagar` agora também trata 409 `duplicate_expense` (caso usuário cadastre payable pago e bata com despesa manual existente)

## Fix #2 — Parcelas: valor mínimo + retry idempotente

**Dois problemas distintos:**

**2a) Valor pequeno gerava parcela R$ 0,00 que violava CHECK:**
- R$ 0,01 em 2 parcelas: `baseCents = floor(1/2) = 0` → parcelas 1 = R$ 0 → viola `CHECK (amount > 0)`

**Correção:** validação explícita antes do loop:
```ts
if (totalCents < installments) {
  throw new InstallmentsTooSmallError(totalCents, installments);
}
```

**2b) Loop de parcelas sem `ON CONFLICT`:**
- Retry HTTP com mesma `idempotency_key`: `partner_orders` e `partner_receivables` deduplicam (já têm `ON CONFLICT (idempotency_key)`), mas loop de parcelas tentava INSERT de novo → violava `UNIQUE (receivable_id, sequence)` → 500.

**Correção:**
```sql
INSERT INTO finance.partner_receivable_installments (...) VALUES (...)
ON CONFLICT (receivable_id, sequence) DO NOTHING
```

(Codex confirmou: migration 0055 tem `UNIQUE (receivable_id, sequence)` — isso é pré-requisito do `ON CONFLICT`.)

**Route mapeia para 400:**
```ts
if (err instanceof InstallmentsTooSmallError) {
  return reply.status(400).send({
    error: err.code,
    message: err.message,
    total_cents: err.total_cents,
    installments: err.installments,
  });
}
```

Era 500 antes (erro de domínio caía no catch-all do Fastify).

## Fix #3 — `deletePartnerPurchase` bloqueia compra com payable já pago

**Problema:** `deletePartnerPurchase` só cancelava payable `'open'`. Se já fosse `'paid'`, a compra sumia mas o pagamento ficava órfão. `cash_out_month` continuaria contando o `payable.paid_at`, mas `purchases_month` (competência) cairia → competência e caixa ficavam desalinhadas.

**Correção:** novo erro `PaidPurchaseLockedError`. Antes do soft-delete, SELECT em `partner_payables WHERE source_purchase_id = $1 AND status = 'paid'`. Se achar, throw. Route mapeia para 409:

```ts
return reply.status(409).send({
  error: 'cannot_delete_paid_purchase',
  message: 'Esta compra ja foi paga. Para manter o financeiro correto, ela nao pode ser apagada. Faca ajuste manual/estorno em etapa futura.',
  purchase_id: ...,
  paid_payable_id: ...,
});
```

(Mensagem ajustada conforme sugestão do Codex: não falar "cancele o pagamento antes" enquanto não existe endpoint para desfazer pagamento.)

**Estorno automático não foi implementado** — fica para etapa futura. O contrato atual: compra paga não some sem ação humana fora do sistema.

Frontend (`deletePurchase`) detecta o 409 e mostra a mensagem no flash.

## Fix #4 (mini-trava) — Abortar delete se estorno de estoque incompleto

**Posição:** dívida pré-existente do match de estoque por `item_name + supplier_name + tire_size + brand`. Solução estrutural exige FK direta `partner_purchase_items → partner_stock_levels` — entra como **Etapa 7** no plano-mãe, não bloqueia este PR.

**Mas:** Codex pediu uma trava mínima imediata. Hoje o loop silenciosamente pulava itens que não casavam com nenhum stock, mas a compra era apagada do mesmo jeito. Resultado: estoque inflado sem rastro.

**Correção:** rastrear `failedReversals` no loop. Se sobrar item sem estorno, throw `PartialStockReversalError` → rollback automático da transação → compra NÃO é apagada.

```ts
const failedReversals: Array<{ item_name: string; quantity: number }> = [];
for (const item of items.rows) {
  const moved = await client.query(...);
  if (moved.rowCount && moved.rowCount > 0) {
    moves.push(moved.rows[0]!);
  } else {
    failedReversals.push({ item_name: item.item_name, quantity: Number(item.quantity) });
  }
}
if (failedReversals.length > 0) {
  throw new PartialStockReversalError(failedReversals);
}
```

Route mapeia para 409 com lista dos itens problemáticos:
```ts
return reply.status(409).send({
  error: 'stock_reversal_incomplete',
  message: 'Nao foi possivel localizar no estoque todos os itens desta compra para estornar...',
  failed_items: [...],
});
```

Frontend mostra a lista no flash.

## Resumo do que mudou

### `src/parceiro/queries.ts`
- 3 classes de erro novas: `InstallmentsTooSmallError`, `PaidPurchaseLockedError`, `PartialStockReversalError`
- `RegisterPartnerPayableInput.force_duplicate?` adicionado
- `_settlePartnerPayableWithClient(client, ctx, payableId, input)` extraído (helper privado)
- `settlePartnerPayable` reduzido a wrapper que chama o helper
- `registerPartnerPayable` reescrito: INSERT sempre em `'open'`, depois chama helper se `wantedStatus === 'paid'`
- `registerPartnerSale`: validação `totalCents >= installments` antes do loop + `ON CONFLICT (receivable_id, sequence) DO NOTHING` no INSERT das parcelas
- `deletePartnerPurchase`: SELECT de payable pago antes do delete + rastreamento de estorno incompleto + throws

### `src/parceiro/route.ts`
- Imports dos 3 novos erros
- `payableSchema` aceita `force_duplicate`
- `POST /contas-a-pagar` trata 409 `duplicate_expense`
- `POST /vendas` trata 400 `installments_below_minimum`
- `DELETE /compras/:id` trata 409 `cannot_delete_paid_purchase` e `stock_reversal_incomplete`

### `parceiro/public/app.js`
- `deletePurchase`: trata os dois 409s da compra
- `saveMaterialPayable`: pattern de confirm() pra `duplicate_expense` (igual `settlePayable` já fazia)

### `parceiro/public/index.html`
- Cache-bust → `v=20260524-financeiro-parceiro-6`

## Verificação

- `npx tsc --noEmit` passou.
- **Zero migration nova** — todos os fixes são app-layer. Risco de quebrar dados em prod: zero pelo lado de schema; risco de comportamento mudado: cobertos pelos cenários abaixo.

## Cenários de smoke test (atualizados pós-Codex)

1. **Venda parcelada R$ 1 em 3x** → deve criar parcelas R$ 0,33 + R$ 0,33 + R$ 0,34
2. **Venda parcelada R$ 0,02 em 3x** → 400 `installments_below_minimum` com mensagem clara
3. **Venda parcelada 3x, retry HTTP com mesma idempotency_key** → segunda chamada idempotente, sem 500
4. **Cadastrar payable já pago "Aluguel R$ 1500"** com despesa manual "Aluguel R$ 1500" no histórico recente → 409 `duplicate_expense`; confirmar → cria a despesa duplicada com `source_payable_id`; negar → payable continua aberto, sem expense extra
5. **Cadastrar payable já pago sem duplicata** → cria payable + expense com `source_payable_id` → `cash_out_month` conta uma vez via payable (e expense não conta porque `source_payable_id IS NOT NULL` na regra do cash_out)
6. **Apagar compra à vista (não tem payable)** → soft-delete normal, estoque devolvido
7. **Apagar compra a prazo (payable em aberto)** → soft-delete + cancela payable em cascade (igual antes)
8. **Apagar compra a prazo já paga** → 409 `cannot_delete_paid_purchase` com mensagem nova
9. **Apagar compra cujos itens não estão mais no estoque** → 409 `stock_reversal_incomplete` com lista; compra NÃO some

## Status

Pacote 1-6 + 4 fixes pós-Codex prontos. **Recomendo subir os 3 bugs reais (#1-3) antes de migrar prod**, já feito. **Etapa 7** (FK em `partner_purchase_items`) entra no plano-mãe como pendente.
