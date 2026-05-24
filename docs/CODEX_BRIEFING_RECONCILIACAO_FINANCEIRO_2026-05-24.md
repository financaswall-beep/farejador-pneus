# Briefing para Codex — Reconciliação financeira Portal Parceiro

**Data:** 2026-05-24
**Autor:** Claude (Opus 4.7)
**Escopo:** Conjunto completo de mudanças no financeiro do Portal Parceiro (Farejador), incluindo banco, aplicação TypeScript e frontend Alpine.js. Tudo implementado, type-check passa, **migrations ainda não aplicadas em produção**.

Este documento é auto-contido: contém contexto, decisões, todos os arquivos tocados, todos os arquivos criados, pendências e cenários de teste sugeridos. Codex pode revisar sem precisar olhar nada além dos arquivos referenciados.

---

## 1. Contexto

### 1.1 Produto

Portal Parceiro é o painel operacional de uma unidade parceira (borracharia credenciada) dentro do Farejador. Roda em `parceiro/` (frontend Alpine.js + HTML estático) e `src/parceiro/` (Fastify + TypeScript). Banco Postgres com schemas `commerce.*`, `finance.*`, `network.*`, `audit.*`, `core.*`, `ops.*`.

Decisão arquitetural prévia (Wallace, 2026-05-19): **"matriz vê tudo do parceiro, parceiro não vê nada da matriz"**. Tradução: parceiro opera sobre `partner_*` tables (silo isolado), sem ler `commerce.products`/`commerce.orders`.

RLS estrita aplicada em 2026-05-21 (Etapa 5 RLS — não confundir com "Etapa 5" deste plano de reconciliação). Pool de conexão usa role `farejador_partner_app` sem `BYPASSRLS`. Toda transação faz `SET LOCAL app.partner_unit_id` via `withPartnerContext`.

### 1.2 Problema diagnosticado (2026-05-24)

Revisão a fundo do financeiro identificou que as peças (`partner_orders`, `partner_purchases`, `partner_expenses`, `partner_payables`, `partner_receivables`) **existiam mas não conversavam**:

| De → Para | Como ligava antes |
|---|---|
| venda → conta a receber | só por `idempotency_key` (string) |
| pagar conta → despesa | só por `idempotency_key` (string) |
| compra → conta a pagar | **não existia** |

Resumo do mês (`network.partner_unit_summary`) misturava regime de competência e caixa de forma incoerente. Sem fluxo de caixa projetado. Sem parcelamento. Bugs específicos:

1. Cancelar venda não cancelava `partner_receivable` auto-criada — ficava órfã em `'open'`, podia ser "recebida" depois (entrada de dinheiro de venda inexistente).
2. Pagamento a fornecedor caía como categoria `'maintenance'` em despesa (mapping `supplier: 'maintenance'`) — sumia do relatório "quanto gastei com fornecedor".
3. `settlePartnerPayable` sempre criava `partner_expense`, sem checar se já havia despesa manual igual — dupla contagem possível.

### 1.3 Decisão estratégica

Não fazer ERP. Não fazer NFe (loja é borracharia de pneu usado/velho, não emite nota). Fazer financeiro **simples e amarrado**:

- venda ligada à conta a receber via FK
- compra ligada à conta a pagar via FK
- pagamento ligado à despesa via FK
- cancelamento em cascade
- resumo separando "vendido" de "recebido" e "comprado" de "pago"
- fluxo de caixa projetado por data
- parcelamento de venda a receber

Plano de 6 etapas. **Todas implementadas.** Itens explicitamente fora de escopo:
- NFe / NFC-e
- Conta bancária como entidade + conciliação OFX
- Comissão de vendedor
- Devolução parcial de venda
- Múltiplas formas de pagamento na mesma venda
- Lock contábil de período
- Centro de custo

---

## 2. Migrations (6 novas, ordem importa)

Todas idempotentes (`CREATE OR REPLACE`, `IF NOT EXISTS`, `DROP IF EXISTS` antes de `ADD`).

### 2.1 `db/migrations/0050_partner_finance_fixes_etapa1.sql`

**Bug 2:** adiciona categoria `'supplier_payment'` ao CHECK de `finance.partner_expenses.category`.

```sql
ALTER TABLE finance.partner_expenses DROP CONSTRAINT IF EXISTS partner_expenses_category_check;
ALTER TABLE finance.partner_expenses ADD CONSTRAINT partner_expenses_category_check
  CHECK (category IN ('employee_payment','rent','utilities','maintenance','delivery','tax','supplier_payment','other'));
```

**Bug 1:** recria `commerce.cancel_partner_local_order` adicionando UPDATE em `finance.partner_receivables` (match por `idempotency_key = 'order:' || p_order_id || ':receivable'`). Emite `audit.events` tipo `partner_receivable_cancelled_by_sale_cancel`.

> Esta função é substituída de novo na migration 0051 (passa a usar FK `source_order_id`). A 0050 entra primeiro porque a 0051 espera estado consistente pós-bug.

### 2.2 `db/migrations/0051_partner_finance_fks_etapa2.sql`

Adiciona 3 colunas FK + backfill + UNIQUE parcial + env_match triggers + reescreve `cancel_partner_local_order` usando FK.

```sql
ALTER TABLE finance.partner_receivables ADD COLUMN IF NOT EXISTS source_order_id UUID;
ALTER TABLE finance.partner_payables    ADD COLUMN IF NOT EXISTS source_purchase_id UUID;
ALTER TABLE finance.partner_expenses    ADD COLUMN IF NOT EXISTS source_payable_id UUID;
```

Backfill via regex no `idempotency_key`:

```sql
UPDATE finance.partner_receivables
SET source_order_id = SUBSTRING(idempotency_key FROM 'order:([0-9a-fA-F-]{36}):receivable')::uuid
WHERE source_order_id IS NULL
  AND idempotency_key ~ '^order:[0-9a-fA-F-]{36}:receivable$';
-- análogo para partner_expenses.source_payable_id
```

Bloco `DO $$` emite `RAISE WARNING` se sobrarem linhas com padrão reconhecido mas FK vazia (regex falhou).

FKs `ON DELETE SET NULL`. UNIQUE parcial:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS partner_receivables_source_order_uniq
  ON finance.partner_receivables(source_order_id)
  WHERE source_order_id IS NOT NULL AND deleted_at IS NULL;
-- + 2 análogos
```

env_match triggers (defesa em profundidade): garantem `environment` igual entre filha e pai quando FK preenchida.

`cancel_partner_local_order` agora faz `WHERE source_order_id = p_order_id` (em vez do string match).

### 2.3 `db/migrations/0052_partner_purchase_payment_status_etapa3.sql`

```sql
ALTER TABLE commerce.partner_purchases
  ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'paid_now';
ALTER TABLE commerce.partner_purchases
  ADD COLUMN IF NOT EXISTS payable_due_date DATE;

ALTER TABLE commerce.partner_purchases ADD CONSTRAINT partner_purchases_payment_status_check
  CHECK (payment_status IN ('paid_now','payable'));
ALTER TABLE commerce.partner_purchases ADD CONSTRAINT partner_purchases_payable_due_date_check
  CHECK (payment_status='paid_now' OR (payment_status='payable' AND payable_due_date IS NOT NULL));
```

Default `'paid_now'` preserva comportamento existente. Aplicação (queries.ts) cria payable vinculado quando `'payable'`.

### 2.4 `db/migrations/0053_partner_summary_3_blocos_etapa4.sql`

`CREATE OR REPLACE VIEW network.partner_unit_summary` reescrita com 3 grupos de campos. Mantém todos os campos legados (`sales_month`, `purchases_month`, `expenses_month`, `estimated_result_month`, `stock_items`, `low_stock_items`) para compat com UI atual.

Novos campos:

**Competência:** `result_competencia_month` (alias de `estimated_result_month`)

**Caixa realizado:** `cash_in_month`, `cash_out_month`, `cash_net_month`
- `cash_in` = vendas com `payment_method <> 'A receber'` + receivables com `received_at` no mês
- `cash_out` = compras com `payment_status='paid_now'` + despesas com `source_payable_id IS NULL` + payables com `paid_at` no mês

Anti-dupla-contagem por construção: cada evento de caixa é contado exatamente uma vez. Ver comentários no SQL.

**Posição futura:** `open_receivables_total`, `open_payables_total`, `net_future_position` (sem janela temporal).

View `security_invoker=true` preservada.

### 2.5 `db/migrations/0054_partner_cash_flow_projection_etapa5.sql`

Nova view `network.partner_cash_flow_projection` — 1 linha por unidade parceira, agregando payables e receivables em aberto em 5 buckets de vencimento (em `America/Sao_Paulo`):

| Bucket | Critério |
|---|---|
| `overdue` | `due_date < hoje` |
| `today` | `due_date = hoje` |
| `next_7d` | `hoje < due_date ≤ hoje+7` |
| `next_30d` | `hoje+7 < due_date ≤ hoje+30` |
| `later` | `due_date > hoje+30` OU `due_date IS NULL` |

Para cada bucket: colunas `_in` (receivables), `_out` (payables), `_net = in - out`, `_in_count`, `_out_count`.

`security_invoker=true`.

### 2.6 `db/migrations/0055_partner_receivable_installments_etapa6.sql`

Nova tabela `finance.partner_receivable_installments`:

```sql
CREATE TABLE finance.partner_receivable_installments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment     env_t NOT NULL,
  receivable_id   UUID NOT NULL REFERENCES finance.partner_receivables(id) ON DELETE CASCADE,
  sequence        INT NOT NULL CHECK (sequence >= 1),
  amount          NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  due_date        DATE NOT NULL,
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','received','cancelled')),
  received_at     TIMESTAMPTZ,
  payment_method  TEXT,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ,
  deleted_by      TEXT,
  UNIQUE (receivable_id, sequence)
);
```

Trigger `partner_receivable_installment_after_update`: quando todas as parcelas resolvem, atualiza a receivable mãe:
- ≥1 `received` + restante `cancelled` → receivable `received` (`received_at = max(installment.received_at)`)
- todas `cancelled` → receivable `cancelled`

RLS via subquery na receivable mãe. `env_match` com a mãe. Grant `SELECT, INSERT, UPDATE` para `farejador_partner_app`.

Nova view `finance.partner_receivables_effective`:
- Linha por receivable SEM parcelas (igual antes)
- Linha por parcela de receivable COM parcelas

Recria `network.partner_unit_summary` e `network.partner_cash_flow_projection` para usar `partner_receivables_effective` no lugar de `partner_receivables` direta. Mesma forma das views.

### 2.7 Ordem e idempotência

Aplicar em ordem: **0050 → 0051 → 0052 → 0053 → 0054 → 0055**.

Todas seguem padrão idempotente:
- `ADD COLUMN IF NOT EXISTS`
- `DROP CONSTRAINT IF EXISTS` antes de `ADD CONSTRAINT`
- `CREATE OR REPLACE` para functions e views
- `CREATE UNIQUE INDEX IF NOT EXISTS`
- `DROP TRIGGER IF EXISTS` antes de `CREATE TRIGGER`
- Backfill (na 0051) é `UPDATE ... WHERE source_X IS NULL` (re-rodar não duplica)

---

## 3. Aplicação (TypeScript)

### 3.1 `src/parceiro/queries.ts`

**Novas interfaces:**

```ts
export interface RegisterPartnerSaleInput {
  // ... campos existentes ...
  payment_status?: 'received' | 'receivable' | null;
  receivable_due_date?: string | null;
  receivable_installments?: number | null;  // novo Etapa 6
  // ...
}

export interface RegisterPartnerPurchaseInput {
  // ... campos existentes ...
  payment_status?: 'paid_now' | 'payable' | null;  // novo Etapa 3
  payable_due_date?: string | null;
  // ...
}

export interface RegisterPartnerExpenseInput {
  category: 'employee_payment' | 'rent' | 'utilities' | 'maintenance'
          | 'delivery' | 'tax' | 'supplier_payment' | 'other';  // Etapa 1: + 'supplier_payment'
  // ...
}

export interface SettlePartnerPayableInput {
  paid_at?: string | null;
  payment_method?: string | null;
  force_duplicate?: boolean;  // Etapa 1
}

export interface SettlePartnerReceivableInstallmentInput {
  received_at?: string | null;
  payment_method?: string | null;
}

export class DuplicateExpenseError extends Error {
  readonly code = 'duplicate_expense';
  readonly duplicates: Array<{ id: string; expense_date: string; amount: string; description: string }>;
  constructor(duplicates) { /* ... */ }
}
```

**Mapeamento `payableCategoryToExpenseCategory`** (Etapa 1):

```ts
const map = {
  supplier: 'supplier_payment',  // era 'maintenance'
  employee: 'employee_payment',
  rent: 'rent',
  utilities: 'utilities',
  tax: 'tax',
  maintenance: 'maintenance',
  other: 'other',
};
```

**`registerPartnerSale`** (Etapas 1, 2, 6):
- Quando `payment_status='receivable'`:
  - SELECT do pedido recém-criado; se vazio → `throw Error('partner_sale_receivable_missing_order: ...')` (Etapa 1)
  - INSERT em `partner_receivables` agora preenche `source_order_id = orderId` (Etapa 2)
  - `idempotency_key = 'order:' || orderId || ':receivable'` mantido (idempotência HTTP)
  - Audit event `partner_receivable_auto_created` com `installments` no payload
  - Se `receivable_installments > 1` e `receivable_due_date` definido: cria N parcelas dividindo o total em centavos (última leva o resto), `due_date = primeira + (i-1)*30 dias` (Etapa 6)

**`registerPartnerPurchase`** (Etapa 3):
- Aceita `payment_status` e `payable_due_date`. Se `'payable'` sem due_date → throw `'payable_due_date_required_when_payment_status_payable'`
- INSERT em `partner_purchases` grava `payment_status` e `payable_due_date`; `payment_method` vira `'A pagar'` quando payable
- Depois da entrada de estoque, se `paymentStatus === 'payable'`: INSERT em `finance.partner_payables` com `source_purchase_id = purchaseId`, `category = 'supplier'`, `idempotency_key = 'purchase:UUID:payable'`
- Audit event `partner_payable_auto_created`

**`deletePartnerPurchase`** (Etapa 3):
- Após soft-delete da compra, UPDATE em `partner_payables WHERE source_purchase_id = purchaseId AND status='open'` → status `'cancelled'`, `deleted_at=now()`
- Audit event `partner_payable_cancelled_by_purchase_delete`

**`settlePartnerPayable`** (Etapas 1, 2, 3):
- UPDATE retorna também `source_purchase_id`
- **Se `source_purchase_id` preenchido:** não cria expense (compra já foi contabilizada no momento da compra). Audit event com `expense_skipped: 'origin_is_purchase'`. Retorna.
- Senão, antes de criar expense, faz dedupe (Etapa 1): SELECT em `partner_expenses` com mesma descrição + amount + janela de ±7 dias + `source_payable_id <> payableId`. Se achar duplicatas → `throw new DuplicateExpenseError(rows)`
- Se chegou aqui (sem duplicata OU `force_duplicate=true`), INSERT em expense preenchendo `source_payable_id = payableId` (Etapa 2)

**`settlePartnerReceivableInstallment`** (Etapa 6, nova):
- UPDATE em `partner_receivable_installments` para `status='received'`, gravando `received_at`/`payment_method`
- Audit event `partner_receivable_installment_received`
- Trigger no banco fecha a receivable mãe quando todas resolvem

**`getPartnerCompras`** (Etapa 3): SELECT inclui `payment_status` e `payable_due_date`.

**`getPartnerReceivables`** (Etapa 6): SELECT faz LEFT JOIN com installments e agrega `jsonb_agg(...)` em campo `installments` ordenado por `sequence`.

**`getPartnerFluxoCaixa`** (Etapa 5, nova): SELECT `*` da view `network.partner_cash_flow_projection`.

### 3.2 `src/parceiro/route.ts`

**Schemas Zod atualizados:**

```ts
const saleSchema = z.object({
  // ... existentes ...
  payment_status: z.enum(['received','receivable']).nullable().optional(),
  receivable_due_date: z.string().date().nullable().optional(),
  receivable_installments: z.number().int().min(1).max(36).nullable().optional(),  // Etapa 6
  // ...
}).refine(/* delivery_address obrigatório quando delivery */)
  .refine(/* receivable_due_date obrigatório quando receivable */);

const purchaseSchema = z.object({
  // ... existentes ...
  payment_status: z.enum(['paid_now','payable']).nullable().optional(),
  payable_due_date: z.string().date().nullable().optional(),
  // ...
}).refine(/* payable_due_date obrigatório quando payable */);

const expenseSchema = z.object({
  category: z.enum(['employee_payment','rent','utilities','maintenance',
                    'delivery','tax','supplier_payment','other']),  // + supplier_payment
  // ...
});

const settlePayableSchema = z.object({
  paid_at: z.string().datetime().nullable().optional(),
  payment_method: z.string().max(80).nullable().optional(),
  force_duplicate: z.boolean().optional(),  // Etapa 1
});

const receivableInstallmentParamsSchema = paramsSchema.extend({
  receivableId: z.string().uuid(),
  installmentId: z.string().uuid(),
});
```

**Endpoints novos/atualizados:**

```
GET  /parceiro/:slug/api/fluxo-caixa                                      # Etapa 5
POST /parceiro/:slug/api/contas-a-pagar/:payableId/pagar                  # Etapa 1: trata DuplicateExpenseError → 409
POST /parceiro/:slug/api/contas-a-receber/:receivableId/parcelas/:installmentId/receber  # Etapa 6
```

O endpoint `/contas-a-pagar/:id/pagar` faz try/catch em volta de `settlePartnerPayable`; se `err instanceof DuplicateExpenseError`, retorna:

```json
HTTP 409
{ "error": "duplicate_expense", "duplicates": [...] }
```

### 3.3 Notas de implementação

- Tudo dentro de `withPartnerContext(ctx.partnerUnitId, ...)` — uma transação por request, com `SET LOCAL app.partner_unit_id` para ativar RLS.
- `idempotency_key` continua sendo gravada nos INSERTs novos (`order:UUID:receivable`, `purchase:UUID:payable`, `payable:UUID:expense`) — serve pra idempotência HTTP em retries. **FK é a fonte da verdade** pra reconciliação; idempotency é só guard contra duplicar a mesma chamada.
- Trigger de parcela é `AFTER UPDATE OF status`. Não recursa: o UPDATE que o trigger faz é em `partner_receivables`, não na própria tabela de parcelas.

---

## 4. Frontend (Alpine.js)

### 4.1 `parceiro/public/app.js`

**Estado (`saleForm`/`purchaseForm`):**

```js
saleForm: {
  // ... existentes ...
  payment_status: 'received',
  receivable_due_date: '',
  receivable_installments: 1,  // Etapa 6
  // ...
},
purchaseForm: {
  // ... existentes ...
  payment_status: 'paid_now',
  payable_due_date: '',
},
fluxoCaixa: null,  // Etapa 5
```

**`api()` agora expõe `status` e `payload`** no Error pra tratar 409:

```js
if (!response.ok) {
  const payload = await response.json().catch(() => ({}));
  const err = new Error(payload.error || `api_${response.status}`);
  err.status = response.status;
  err.payload = payload;
  throw err;
}
```

**`loadData()`** agora também faz `api('fluxo-caixa')` no `Promise.all` e atribui a `this.fluxoCaixa`.

**`saveSale()`** envia `receivable_installments` no body quando `payment_status='receivable'`.

**`savePurchase()`** envia `payment_status` e `payable_due_date`; valida client-side que due_date está presente quando payable.

**`settlePayable()`** (Etapa 1):
- Tenta com `force_duplicate: false`
- Se erro 409 com `error='duplicate_expense'`, mostra `confirm()` listando as duplicatas e pede confirmação; se OK, retenta com `force_duplicate: true`

**`settleInstallment(receivableId, installmentId)`** (Etapa 6, nova): POST no endpoint da parcela.

**`categoryLabel('supplier_payment') = 'Fornecedor'`** (Etapa 1).

### 4.2 `parceiro/public/index.html`

Cache-bust → `v=20260524-financeiro-parceiro-5`.

**Form de venda** ganhou (quando `payment_status='receivable'`):
- "Primeira parcela em" (label mudou de "Receber em")
- "Parcelas" (1-36) + hint "+30 dias entre cada uma" quando > 1

**Form de compra** ganhou:
- Select "Pagamento" (Pago na hora / A prazo)
- "Vencimento" condicional

**Aba financeiro, no topo:** 4 cards de fluxo de caixa (Vencido / Hoje / Próximos 7d / Próximos 30d) — cada um mostra net + breakdown in/out + contagem.

**Aba financeiro, depois dos 5 cards existentes:** fileira de 3 cards (Competência do mês / Caixa do mês / Posição futura), cada um com número principal + sub-números.

**Lista de receivables:** quando `installments.length > 1`, mostra sub-bloco indentado com cada parcela (sequence/N, vencimento, valor, status badge, botão "receber parcela"). O botão "receber tudo" some quando há parcelas — recebimento é parcela a parcela.

---

## 5. Arquivos tocados

### 5.1 Novos arquivos

**Migrations:**
- `db/migrations/0050_partner_finance_fixes_etapa1.sql`
- `db/migrations/0051_partner_finance_fks_etapa2.sql`
- `db/migrations/0052_partner_purchase_payment_status_etapa3.sql`
- `db/migrations/0053_partner_summary_3_blocos_etapa4.sql`
- `db/migrations/0054_partner_cash_flow_projection_etapa5.sql`
- `db/migrations/0055_partner_receivable_installments_etapa6.sql`

**Docs:**
- `docs/PLANO_RECONCILIACAO_FINANCEIRO_PARCEIRO_2026-05-24.md` (plano-mãe)
- `docs/FIX_PARCEIRO_VENDA_RECEBER_2026-05-24.md` (3 bugs pós-review do commit 522bf86)
- `docs/FIX_PARCEIRO_RECONCILIACAO_ETAPA1_2026-05-24.md`
- `docs/FIX_PARCEIRO_RECONCILIACAO_ETAPA2_2026-05-24.md`
- `docs/FIX_PARCEIRO_RECONCILIACAO_ETAPA3_2026-05-24.md`
- `docs/FIX_PARCEIRO_RECONCILIACAO_ETAPA4_2026-05-24.md`
- `docs/FIX_PARCEIRO_RECONCILIACAO_ETAPA5_2026-05-24.md`
- `docs/FIX_PARCEIRO_RECONCILIACAO_ETAPA6_2026-05-24.md`
- `docs/CODEX_BRIEFING_RECONCILIACAO_FINANCEIRO_2026-05-24.md` (este arquivo)

### 5.2 Arquivos modificados

- `src/parceiro/queries.ts` — novas interfaces, FKs nos inserts, dedupe, parcelas, fluxo de caixa, settle de parcela
- `src/parceiro/route.ts` — schemas atualizados, 2 endpoints novos, tratamento de 409
- `parceiro/public/app.js` — api() com payload, saleForm/purchaseForm com novos campos, settle de parcela, dedupe via confirm()
- `parceiro/public/index.html` — 4 cards fluxo + 3 cards blocos + form venda/compra + lista de parcelas + cache-bust
- `parceiro/README.md` — notas das 6 etapas no topo, status "100% implementado"
- `docs/PLANO_RECONCILIACAO_FINANCEIRO_PARCEIRO_2026-05-24.md` — atualizado a cada etapa

---

## 6. Verificação

### 6.1 O que rodou local

- `npx tsc --noEmit -p tsconfig.json` — passou (zero erros) após cada etapa.
- Cache-bust do `app.js` bumpado em todas as etapas que tocaram frontend (`v=20260524-financeiro-parceiro-2/3/4/5`).
- Nenhum teste novo foi escrito. Suíte existente (`tests/integration/partner-*.test.ts`) **não foi rodada** pelo agente.

### 6.2 O que falta verificar antes de subir

**1) Migrations num staging:**
```bash
psql $STAGING_URL -f db/migrations/0050_partner_finance_fixes_etapa1.sql
psql $STAGING_URL -f db/migrations/0051_partner_finance_fks_etapa2.sql
psql $STAGING_URL -f db/migrations/0052_partner_purchase_payment_status_etapa3.sql
psql $STAGING_URL -f db/migrations/0053_partner_summary_3_blocos_etapa4.sql
psql $STAGING_URL -f db/migrations/0054_partner_cash_flow_projection_etapa5.sql
psql $STAGING_URL -f db/migrations/0055_partner_receivable_installments_etapa6.sql
```

Conferir saídas. Em especial, a 0051 pode emitir `RAISE WARNING` se backfill regex falhar — investigar antes de seguir.

**2) Suíte existente:**
```bash
npm test -- tests/integration/partner
```

**3) Smoke manual no Portal Parceiro:**

| # | Cenário | Esperado |
|---|---|---|
| 1 | Venda à vista R$ 200 | Estoque baixa, `sales_month +200`, `cash_in_month +200`, sem receivable |
| 2 | Venda a receber R$ 400 (1x, vence +30d) | Receivable criada com `source_order_id`; `sales_month +400`, `cash_in_month` **não** muda; `open_receivables_total +400` |
| 3 | Cancelar a venda do #2 | Estoque devolve; receivable some da lista (cancelled+deleted); audit event `partner_receivable_cancelled_by_sale_cancel` |
| 4 | Venda a receber R$ 600 em 3x | Receivable criada + 3 parcelas R$ 200 cada com due_dates 0/+30/+60 |
| 5 | Receber parcela 1/3 | Parcela vira `received`; receivable continua `open`; `cash_in_month +200`; `open_receivables_total -200` |
| 6 | Receber parcela 2 e 3 | Trigger marca receivable mãe `received`; `cash_in_month +400`; `open_receivables_total 0` |
| 7 | Compra à vista R$ 1000 | `purchases_month +1000`, `cash_out_month +1000`, sem payable |
| 8 | Compra a prazo R$ 800 (vence +15d) | Compra criada `payment_status='payable'`; payable criado com `source_purchase_id`, categoria `'supplier'`; `purchases_month +800` mas `cash_out_month` **não muda**; `open_payables_total +800`; fluxo de caixa mostra +800 em `next_30d_out` |
| 9 | Pagar payable do #8 | Payable vira `paid`; **NÃO cria expense** (audit event tem `expense_skipped: 'origin_is_purchase'`); `cash_out_month +800` |
| 10 | Cadastrar despesa manual "Aluguel R$ 1500" + cadastrar payable "Aluguel R$ 1500" + marcar payable como pago | Retorna 409 `duplicate_expense` com lista; confirmar no popup → cria a segunda despesa, contas duplicadas. Ou negar → payable continua aberto, despesa única |
| 11 | Pagar payable manual (não vindo de compra) "Salário R$ 2000" sem duplicata | Cria expense com `source_payable_id` preenchido; categoria mapeada (`employee` → `employee_payment`); `cash_out_month +2000` |

### 6.3 Pontos de atenção para revisão

- **Backfill da 0051:** receivables/expenses que não tinham `idempotency_key` ficam para sempre sem FK. Aceito como gap histórico — não há como reconstruir o vínculo.
- **`later` bucket** no fluxo de caixa agrupa "due_date > 30d" e "due_date NULL" no mesmo balde. Pode confundir relatórios.
- **Parcelamento só de receivable.** Payable parcelado (compra em 3x) não existe — seria estrutura simétrica, fica como Etapa 7 futura.
- **Intervalo fixo de 30 dias** entre parcelas — não customizável via API.
- **Cancelar uma parcela individual** não tem endpoint (só `settle`). Cobre 95% dos casos de uma borracharia pequena, mas é limitação consciente.
- **`partner_payables.source_purchase_id`** foi adicionada sem env_match na 0051 — adicionei depois. Confirmar que está coberto (linha `env_match_partner_payables_source_purchase` na 0051).
- **`commerce.cancel_partner_local_order`** é recriada DUAS vezes: na 0050 (com idempotency_key match) e na 0051 (com FK). Por isso a ordem importa — aplicar 0050 antes da 0051.
- **Dedupe** usa janela ±7 dias e match de descrição (case-insensitive trim) + amount exato. Pode dar falsos positivos se o parceiro tiver duas despesas parecidas no mesmo período (ex: 2 contas de luz no mesmo mês com descrição idêntica). Trava é **soft** — usuário pode forçar via 409+confirm.
- **`source_payable_id` IS NULL** no critério de cash_out_month da view: significa que despesas migradas (sem FK preenchida no backfill) continuam contando como cash_out. OK conceitualmente, mas se houver despesas auto-criadas pré-Etapa 2 sem backfill, podem contar em duplicidade com o payable. Aceitável pra histórico.

### 6.4 Decisões de design que Codex pode questionar

1. **`payment_method='A receber'`** como string mágica (em venda) e `'A pagar'` (em compra). Funciona, mas vira label visível no histórico. Alternativa: deixar `payment_method` NULL nesses casos e a UI decidir pelo `payment_status` da venda/compra. Não fiz porque exigiria mudança em mais lugares.
2. **`ON DELETE SET NULL`** nas FKs (não CASCADE). Razão: soft-delete preserva histórico — não queremos derrubar receivables/payables se a venda/compra for fisicamente deletada (improvável, mas defensivo).
3. **Trigger fechar receivable mãe via parcelas** — alternativa seria sempre derivar status na view. Optei por materializar no banco pra simplificar queries downstream e ter status canônico.
4. **Parcelas dividem o total em centavos** com última parcela levando o resto (ex: R$ 100 em 3x → R$ 33,33 / R$ 33,33 / R$ 33,34). Comum em mercado. Alternativa seria distribuir o resto entre as primeiras — minoritário.
5. **Categoria do payable de compra é hardcoded `'supplier'`** em `registerPartnerPurchase`. Faz sentido (toda compra é fornecedor), mas se um dia houver compra de outra categoria (ex: ferramenta única que não vira estoque), seria limitação.

---

## 7. Como Codex deve revisar

Ordem sugerida:

1. **Plano-mãe:** `docs/PLANO_RECONCILIACAO_FINANCEIRO_PARCEIRO_2026-05-24.md` (~3 min)
2. **Docs por etapa** em ordem (1→6): contexto antes de ver SQL/código
3. **Migrations** em ordem (0050→0055): cada uma tem comentário-cabeçalho explicando o quê e por quê
4. **Código TypeScript:** `src/parceiro/queries.ts` (mudanças concentradas em `registerPartnerSale`, `registerPartnerPurchase`, `settlePartnerPayable`, `deletePartnerPurchase`, novas funções de parcela e fluxo de caixa), `src/parceiro/route.ts` (schemas + 2 endpoints novos + tratamento 409)
5. **Frontend:** `parceiro/public/app.js` (foco em `settlePayable`, `settleInstallment`, `saveSale`, `savePurchase`), `parceiro/public/index.html` (cards novos + form de venda/compra com novos campos + lista de parcelas)

Perguntas-chave pra Codex responder:

- Algum bug em pontos 6.3 / 6.4?
- Cenários de teste 6.2 cobrem o suficiente, ou há caso de borda esquecido?
- A divisão de centavos nas parcelas pode dar arredondamento que estoura o `CHECK (amount > 0)` em algum caso extremo?
- Trigger `partner_receivable_installment_after_update` está safe contra recursão? (Acredito que sim — UPDATE na receivable mãe não dispara trigger nesta tabela.)
- Backfill da 0051 funciona em produção com volume real? (Devia, mas pode demorar — sem `LIMIT`.)

## 8. O que NÃO foi feito

- Aplicar migrations em prod ou staging
- Rodar testes existentes
- Escrever testes novos para as 6 etapas
- Touch em `painel/` (admin) — todas as views consumidas pelo admin foram preservadas em forma (mesmas colunas + colunas novas)
- Verificar que o consumidor admin (`painel/`) ainda lê `partner_unit_summary` sem quebrar — colunas legadas foram preservadas justamente pra isso, mas confirmar é prudente
- Commit Git — tudo está working tree, não commitado
