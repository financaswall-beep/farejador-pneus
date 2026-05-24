# Etapa 2 — FKs reais entre venda/compra/payable/receivable/expense

**Data:** 2026-05-24
**Plano-mãe:** `docs/PLANO_RECONCILIACAO_FINANCEIRO_PARCEIRO_2026-05-24.md`
**Migration:** `db/migrations/0051_partner_finance_fks_etapa2.sql`
**Código:** `src/parceiro/queries.ts`

## O que mudou

Substituímos a "ligação por `idempotency_key` (string)" entre as entidades do financeiro do parceiro por **foreign keys formais**:

| De | Para | Coluna |
|---|---|---|
| `finance.partner_receivables` | `commerce.partner_orders(id)` | `source_order_id` |
| `finance.partner_payables` | `commerce.partner_purchases(id)` | `source_purchase_id` |
| `finance.partner_expenses` | `finance.partner_payables(id)` | `source_payable_id` |

Todas as colunas são **nullable** — receivable/payable/expense criados manualmente continuam não tendo origem.

## Garantias adicionais

- **UNIQUE parcial** em cada coluna (`WHERE source_X IS NOT NULL AND deleted_at IS NULL`) — uma venda gera no máximo uma receivable auto, uma compra no máximo um payable auto, um payable no máximo uma expense auto.
- **Índices não-únicos** pra JOIN reverso eficiente em relatórios.
- **`env_match` triggers** nas novas FKs (defesa em profundidade: garante que `partner_receivables.environment = partner_orders.environment` quando preenchido).
- **`ON DELETE SET NULL`** nas FKs — soft-delete de venda/compra/payable não derruba o filho; vira órfão preservando histórico.

## Backfill

A migration popula automaticamente as FKs a partir do `idempotency_key` existente (padrões `order:<UUID>:receivable` e `payable:<UUID>:expense`). Se sobrarem linhas com padrão reconhecido mas FK vazia (regex falhou), a migration emite `RAISE WARNING` para investigação.

`partner_payables.source_purchase_id` não tem o que backfillar — compra-a-prazo chega só na Etapa 3.

## Função de cancelamento usa FK

`commerce.cancel_partner_local_order` foi recriada (era da Etapa 1):

```sql
-- Antes (Etapa 1):
WHERE idempotency_key = 'order:' || p_order_id || ':receivable'

-- Depois (Etapa 2):
WHERE source_order_id = p_order_id
```

Mais robusto, query mais simples, independente de convenção de string.

## Trava de duplicidade no settle agora usa FK

Em `settlePartnerPayable`, a detecção de despesa duplicada passou a usar `source_payable_id <> payableId` em vez de comparar `idempotency_key`. Mesmo resultado funcional, mas independente de a chave estar bem formada.

## INSERTs no código preenchem as FKs

- `registerPartnerSale`: passa `source_order_id = orderId` ao criar a receivable da venda "a receber"
- `settlePartnerPayable`: passa `source_payable_id = payableId` ao criar a despesa do payable pago

`idempotency_key` continua sendo gravada — serve pra idempotência de retry HTTP. A FK é a fonte da verdade pra reconciliação.

## Verificação

- `npx tsc --noEmit` passou.
- Migration é idempotente: `ADD COLUMN IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS` antes de `ADD CONSTRAINT`, `CREATE UNIQUE INDEX IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`.
- Backfill é UPDATE condicional (`WHERE source_X IS NULL`) — rodar duas vezes não duplica nada.

## Pendências reconhecidas

- Receivables/expenses antigas que **não tinham `idempotency_key`** ficam para sempre sem FK preenchida. Aceitável — são registros pré-migração; o relatório de "vendas X receivables" terá pequeno gap histórico.
- Sem testes de integração novos para Etapa 2. Cenários para adicionar antes do deploy:
  - venda a receber → cancelar venda → confirmar que receivable foi cancelada via FK (não via idempotency_key)
  - tentar criar 2 receivables com mesmo `source_order_id` → segundo INSERT viola UNIQUE
  - criar receivable manual sem `source_order_id` → permitido
  - settlePartnerPayable cria expense com `source_payable_id` correto

## Próxima etapa

**Etapa 3 — Compra a prazo:** `commerce.partner_purchases` ganha `payment_status`. Se `'payable'`, cria `partner_payable` com `source_purchase_id` preenchido (já temos a FK pronta). O resumo do mês deixa de duplicar custo (compra a prazo entra como compromisso, não como caixa-out).
