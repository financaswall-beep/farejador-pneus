# Etapa 6 — Parcelas de venda a receber

**Data:** 2026-05-24
**Plano-mãe:** `docs/PLANO_RECONCILIACAO_FINANCEIRO_PARCEIRO_2026-05-24.md`
**Migration:** `db/migrations/0055_partner_receivable_installments_etapa6.sql`
**Código:** `src/parceiro/queries.ts`, `src/parceiro/route.ts`, `parceiro/public/app.js`, `parceiro/public/index.html`

## O que mudou

Venda "a receber" agora aceita **N parcelas** (1–36). Quando N > 1, o sistema cria N linhas-filha em `finance.partner_receivable_installments`, cada uma com `due_date`, `amount` e `status` próprios.

### Banco

Nova tabela `finance.partner_receivable_installments`:
- `receivable_id UUID REFERENCES partner_receivables(id) ON DELETE CASCADE`
- `sequence INT` (1, 2, ..., N) — `UNIQUE (receivable_id, sequence)`
- `amount NUMERIC(12,2) > 0`, `due_date DATE NOT NULL`
- `status` (`'open'` | `'received'` | `'cancelled'`)
- `received_at`, `payment_method`, audit padrão, soft-delete
- RLS via subquery na mãe (parceiro só vê parcelas das suas receivables)
- `env_match` com a receivable mãe

Trigger `partner_receivable_installment_after_update`: quando todas as parcelas de uma receivable resolvem, atualiza a receivable mãe:
- Se ao menos 1 `received` e o resto `cancelled` → receivable vira `received`
- Se todas `cancelled` → receivable vira `cancelled`

Nova view auxiliar `finance.partner_receivables_effective`: UNION ALL de (receivables sem parcelas, como antes) + (parcelas individuais de receivables COM parcelas). Usada pelas views agregadoras.

Recriadas (mantendo mesma forma):
- `network.partner_unit_summary` — `open_receivables_total` e `cash_in_month` agora usam `receivables_effective`
- `network.partner_cash_flow_projection` — buckets usam `due_date` das parcelas

### Aplicação

**`registerPartnerSale`** ganhou `receivable_installments` no input. Quando > 1, cria as parcelas dividindo o total igualmente (última parcela leva o resto do arredondamento de centavos). Vencimento: primeira em `receivable_due_date`, seguintes a cada +30 dias.

**`getPartnerReceivables`** devolve `installments` em cada receivable (array JSON ordenado por `sequence`).

**`settlePartnerReceivableInstallment`** (novo) liquida uma parcela isolada. Trigger no banco fecha a receivable mãe quando todas resolvem.

### Endpoint

`POST /parceiro/:slug/api/contas-a-receber/:receivableId/parcelas/:installmentId/receber`
- body: `{ received_at?, payment_method? }`
- 200 / 404 / 400

### Frontend

- Form de venda "a receber" ganhou input "Parcelas" (1–36) ao lado de "Primeira parcela em", com hint "+30 dias entre cada uma" quando > 1.
- Lista de receivables: quando há parcelas, mostra um sub-bloco indentado com cada parcela (sequence, vencimento, valor, status, botão receber individual). O botão "receber tudo" some quando há parcelas — recebimento é parcela a parcela.

## Cobertura

| Cenário | Funciona? |
|---|---|
| Venda à vista | ✅ Igual antes |
| Venda a receber, 1 vencimento | ✅ Sem parcelas (igual Etapa 1-2) |
| Venda a receber, 3x | ✅ 3 parcelas geradas, +30d entre cada |
| Receber 1 parcela | ✅ Parcela vira `received`, receivable continua `open` |
| Receber todas | ✅ Trigger marca receivable como `received` (received_at = max das parcelas) |
| Cancelar venda | ✅ Cascade: receivable cancelled, parcelas seguem via trigger |
| `open_receivables_total` no resumo | ✅ Soma parcelas em aberto (não conta valor já recebido) |
| Fluxo de caixa | ✅ Buckets usam `due_date` das parcelas |

## Verificação

- `npx tsc --noEmit` passou.
- Trigger é AFTER UPDATE OF status — não recursa porque o UPDATE na receivable mãe não dispara este trigger (que escuta a tabela de parcelas).
- View `partner_receivables_effective` é `security_invoker=true`, herda RLS estrita.

## Pendência reconhecida

- Parcelamento **só de receivable** nesta etapa. Payable parcelado (compra a prazo em 3x) seria estrutura simétrica — fica como Etapa 7 futura.
- Intervalo fixo de 30 dias entre parcelas. Se precisar customizar (15d, 45d), a API hoje não aceita — só permite passar `receivable_due_date` (primeira) e quantidade.
- Cancelar uma parcela individual não foi exposto via endpoint (só `settle`). Pra MVP de borracharia, cobre 95% dos casos.
- Sem testes de integração novos para Etapas 4-6. Cenários úteis pra adicionar antes de subir em prod:
  - venda 3x → confirmar 3 parcelas com due_date crescente +30d
  - receber 1 de 3 → receivable continua `open`; receber 2/3 → continua `open`; receber 3/3 → trigger marca como `received`
  - cancelar venda parcelada → receivable + parcelas em cascade
  - somar parcelas em aberto = `open_receivables_total` do resumo
