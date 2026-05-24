# Runbook de deploy — Reconciliação Financeira Portal Parceiro

**Data:** 2026-05-24
**Pacote:** Etapas 1-6 + fixes pós-Codex (aprovado por Codex 2026-05-24)
**Plano-mãe:** `docs/PLANO_RECONCILIACAO_FINANCEIRO_PARCEIRO_2026-05-24.md`

## ⚠️ Regra de ouro

**Aplicar as 6 migrations no banco ANTES de redeployar o código.** O código novo já chama endpoints e tabelas que dependem das migrations. Se subir código antes do banco, o portal quebra em `loadData()`.

---

## Passo 1 — Aplicar migrations em ordem

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/0050_partner_finance_fixes_etapa1.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/0051_partner_finance_fks_etapa2.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/0052_partner_purchase_payment_status_etapa3.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/0053_partner_summary_3_blocos_etapa4.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/0054_partner_cash_flow_projection_etapa5.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/0055_partner_receivable_installments_etapa6.sql
```

### O que conferir em cada uma

| Migration | Conferir |
|---|---|
| 0050 | Sem erro. CHECK da nova categoria `'supplier_payment'` ativo. |
| **0051** | **Atenção ao `RAISE WARNING`** no bloco `DO $$`. Se aparecer "N receivables com idempotency_key tipo order: ficaram sem source_order_id", investigar antes de seguir — pode haver dado em formato inesperado. |
| 0052 | Sem erro. Colunas `payment_status`/`payable_due_date` em `partner_purchases`. |
| 0053 | View `network.partner_unit_summary` recriada com colunas novas (`cash_in_month`, `result_competencia_month`, etc). |
| 0054 | View `network.partner_cash_flow_projection` criada. |
| 0055 | Tabela `partner_receivable_installments` criada. View `partner_receivables_effective` criada. Views da 0053 e 0054 recriadas usando `partner_receivables_effective`. |

**Conferência rápida pós-migrations:**

```sql
-- Colunas FK existem?
SELECT column_name FROM information_schema.columns
WHERE table_schema='finance' AND table_name='partner_receivables' AND column_name='source_order_id';

-- View nova existe?
SELECT viewname FROM pg_views WHERE schemaname='network' AND viewname='partner_cash_flow_projection';

-- Tabela de parcelas existe?
SELECT tablename FROM pg_tables WHERE schemaname='finance' AND tablename='partner_receivable_installments';
```

---

## Passo 2 — Smoke dos 9 cenários (no staging, com código novo já rodando)

| # | Cenário | Esperado |
|---|---|---|
| 1 | Venda R$ 1 em 3x parcelas | 3 parcelas geradas (R$ 0,33 / 0,33 / 0,34) com due_dates +0 / +30 / +60 |
| 2 | Venda R$ 0,02 em 3x parcelas | **HTTP 400** `installments_below_minimum` com mensagem clara |
| 3 | Venda parcelada com retry HTTP (mesma idempotency_key) | Segunda chamada é no-op, sem 500, sem parcelas duplicadas |
| 4 | Payable já pago + despesa manual igual no histórico recente | **HTTP 409** `duplicate_expense` com lista; confirmar no popup → cria duplicata com `source_payable_id`; negar → payable open, sem expense extra |
| 5 | Payable já pago sem duplicata | Cria payable + expense com `source_payable_id`; `cash_out_month` conta uma vez só (via payable, NÃO via expense) |
| 6 | Apagar compra à vista (sem payable) | Soft-delete normal, estoque devolvido |
| 7 | Apagar compra a prazo com payable em `'open'` | Cancela payable em cascade |
| 8 | Apagar compra a prazo com payable já `'paid'` | **HTTP 409** `cannot_delete_paid_purchase` com mensagem nova |
| 9 | Apagar compra cujos itens não casam mais com estoque | **HTTP 409** `stock_reversal_incomplete` com lista dos itens; compra **NÃO** é apagada |

**Adicionais (sanidade dos 3 cards do resumo):**

- Vender R$ 200 à vista → `sales_month +200`, `cash_in_month +200`
- Vender R$ 400 a receber (1x) → `sales_month +400`, `cash_in_month` **não muda**, `open_receivables_total +400`
- Receber essa receivable → `cash_in_month +400`, `open_receivables_total -400`
- Comprar R$ 1000 a prazo (vence +15d) → `purchases_month +1000`, `cash_out_month` **não muda**, `open_payables_total +1000`, fluxo de caixa mostra +1000 em `next_30d_out`
- Pagar essa payable → `cash_out_month +1000`, sem expense criada (audit event tem `expense_skipped: 'origin_is_purchase'`)

---

## Passo 3 — Commit/push/redeploy do código

Só depois que as migrations rodaram e o smoke passou:

```bash
git add db/migrations/0050_partner_finance_fixes_etapa1.sql \
        db/migrations/0051_partner_finance_fks_etapa2.sql \
        db/migrations/0052_partner_purchase_payment_status_etapa3.sql \
        db/migrations/0053_partner_summary_3_blocos_etapa4.sql \
        db/migrations/0054_partner_cash_flow_projection_etapa5.sql \
        db/migrations/0055_partner_receivable_installments_etapa6.sql \
        src/parceiro/queries.ts \
        src/parceiro/route.ts \
        parceiro/public/app.js \
        parceiro/public/index.html \
        parceiro/README.md \
        docs/PLANO_RECONCILIACAO_FINANCEIRO_PARCEIRO_2026-05-24.md \
        docs/FIX_PARCEIRO_VENDA_RECEBER_2026-05-24.md \
        docs/FIX_PARCEIRO_RECONCILIACAO_ETAPA1_2026-05-24.md \
        docs/FIX_PARCEIRO_RECONCILIACAO_ETAPA2_2026-05-24.md \
        docs/FIX_PARCEIRO_RECONCILIACAO_ETAPA3_2026-05-24.md \
        docs/FIX_PARCEIRO_RECONCILIACAO_ETAPA4_2026-05-24.md \
        docs/FIX_PARCEIRO_RECONCILIACAO_ETAPA5_2026-05-24.md \
        docs/FIX_PARCEIRO_RECONCILIACAO_ETAPA6_2026-05-24.md \
        docs/FIX_PARCEIRO_RECONCILIACAO_POS_CODEX_2026-05-24.md \
        docs/CODEX_BRIEFING_RECONCILIACAO_FINANCEIRO_2026-05-24.md \
        docs/RUNBOOK_DEPLOY_RECONCILIACAO_2026-05-24.md

git commit -m "feat(parceiro): reconciliacao financeira 6 etapas + fixes pos-Codex

- Etapa 1: 3 bugs vermelhos (cancel sale → cancel receivable, supplier_payment categoria, dedupe expense)
- Etapa 2: FKs source_order_id/source_purchase_id/source_payable_id + backfill
- Etapa 3: compra a prazo cria payable vinculado (payment_status='payable')
- Etapa 4: resumo em 3 blocos (competencia / caixa realizado / posicao futura)
- Etapa 5: view partner_cash_flow_projection por bucket (overdue/today/7d/30d/later)
- Etapa 6: parcelas de receivable (table + trigger + view efetiva)
- Fixes pos-Codex: helper interno settlePartnerPayableWithClient, InstallmentsTooSmallError,
  PaidPurchaseLockedError, PartialStockReversalError

Migrations 0050-0055. Aplicar no banco ANTES de redeploy do codigo.
"

git push origin <branch>
```

Trigger redeploy no Coolify.

---

## Passo 4 — Smoke pós-deploy em prod

Rápido, só confirmar que o portal carregou:

- Abrir Portal Parceiro logado, aba financeiro
- Os 4 cards de fluxo de caixa carregam (mesmo que zerados)
- Os 3 cards de blocos (competência / caixa / futuro) carregam
- DevTools console limpo (sem 404 em `/api/fluxo-caixa`)
- Cache-bust ativo (`app.js?v=20260524-financeiro-parceiro-6`)

Se algo quebrar, **as migrations não derrubam — só o código novo derruba**. Rollback do código (git revert + redeploy) é seguro porque as colunas/views/tabelas novas continuam existindo no banco (são aditivas).

---

## Rollback

**Código:** `git revert <commit> && push` → redeploy. Banco continua com as colunas novas, mas sem ninguém escrevendo nelas.

**Banco:** as migrations 0050-0055 são aditivas (não dropam coluna nem dado). Não há script de rollback. Se precisar reverter, manualmente:
```sql
DROP TABLE IF EXISTS finance.partner_receivable_installments CASCADE;
DROP VIEW IF EXISTS finance.partner_receivables_effective CASCADE;
DROP VIEW IF EXISTS network.partner_cash_flow_projection;
-- views partner_unit_summary: reaplicar 0046_partner_summary_sao_paulo_month.sql
-- (volta à forma antes da Etapa 4)
ALTER TABLE commerce.partner_purchases DROP COLUMN IF EXISTS payment_status;
ALTER TABLE commerce.partner_purchases DROP COLUMN IF EXISTS payable_due_date;
ALTER TABLE finance.partner_receivables DROP COLUMN IF EXISTS source_order_id CASCADE;
ALTER TABLE finance.partner_payables DROP COLUMN IF EXISTS source_purchase_id CASCADE;
ALTER TABLE finance.partner_expenses DROP COLUMN IF EXISTS source_payable_id CASCADE;
-- categoria 'supplier_payment' em expenses: dropar/recriar CHECK
-- function cancel_partner_local_order: reaplicar 0040_partner_orders_local.sql (versão original)
```

Rollback de banco **não é trivial** — preferir manter o banco "à frente" e reverter só o código.
