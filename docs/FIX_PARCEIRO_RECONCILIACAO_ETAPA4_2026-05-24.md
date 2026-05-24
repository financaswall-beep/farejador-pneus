# Etapa 4 — Resumo em 3 blocos (competência / caixa / futuro)

**Data:** 2026-05-24
**Plano-mãe:** `docs/PLANO_RECONCILIACAO_FINANCEIRO_PARCEIRO_2026-05-24.md`
**Migration:** `db/migrations/0053_partner_summary_3_blocos_etapa4.sql`
**Código:** `parceiro/public/index.html` (3 cards novos na aba financeiro)

## O que mudou

A view `network.partner_unit_summary` passou a responder **três perguntas separadas** em vez de misturar regimes contábeis:

### Bloco 1 — Competência do mês ("o que aconteceu")
- `sales_month`: vendas confirmadas do mês
- `purchases_month`: compras do mês (todas)
- `expenses_month`: despesas do mês
- `result_competencia_month` = vendas − compras − despesas
- `estimated_result_month` (legado, alias do anterior — UI atual segue funcionando)

### Bloco 2 — Caixa realizado do mês ("o que entrou/saiu de verdade")
- `cash_in_month` = vendas à vista do mês + receivables recebidas no mês
- `cash_out_month` = compras paid_now do mês + despesas manuais do mês + payables pagos no mês
- `cash_net_month` = in − out

**Regras anti-dupla-contagem** (alinhadas com Etapas 1–3):
- Cash-in só conta venda quando `payment_method <> 'A receber'` (a entrada da venda "a receber" acontece na receivable.received_at)
- Cash-out só conta compra quando `payment_status = 'paid_now'` (compra a prazo entra no caixa quando o payable é pago)
- Cash-out só conta despesa quando `source_payable_id IS NULL` (despesa derivada de payable seria duplicada — o caixa-out canônico é o payable.paid_at)

### Bloco 3 — Posição futura ("contas em aberto")
- `open_receivables_total`: SUM amount de receivables `status='open'` (sem janela temporal)
- `open_payables_total`: SUM amount de payables `status='open'`
- `net_future_position` = receber − pagar

## Frontend

Adicionada uma fileira de 3 cards na aba financeiro, abaixo dos 5 cards existentes (preservados pra não quebrar muscle memory). Cada card mostra:
- O número principal (verde/vermelho conforme sinal)
- 2–3 sub-números do bloco (vendas/compras/despesas; entrou/saiu; a receber/a pagar)

## Verificação

- View é `CREATE OR REPLACE` — substitui a versão anterior atomicamente.
- Mantém `security_invoker = true` (RLS estrita preservada).
- Todos os campos legados continuam (`sales_month`, `purchases_month`, `estimated_result_month`...).
- `npx tsc --noEmit` passou.

## Pendência reconhecida

- A Etapa 6 (parcelas) refaz a view novamente pra considerar parcelas individuais em `open_receivables_total` e `cash_in_month` via view auxiliar `partner_receivables_effective`.
