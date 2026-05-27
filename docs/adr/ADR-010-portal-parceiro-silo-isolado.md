# ADR-010 - Portal Parceiro como silo isolado

## Status

Aceito em 2026-05-27.

## Contexto

O Portal Parceiro evoluiu para cobrir frente de caixa, estoque e financeiro da borracharia parceira. Esses fluxos precisam escrever dados operacionais da unidade sem contaminar o bot, o Chatwoot, as vendas historicas da matriz ou o schema principal de atendimento.

Ao mesmo tempo, o painel da matriz precisa enxergar os dados agregados dos parceiros para acompanhar operacao, estoque, vendas e financeiro.

## Decisao

O Portal Parceiro permanece em um silo operacional proprio:

- Vendas do parceiro ficam em `commerce.partner_orders` e `commerce.partner_order_items`.
- Estoque e compras do parceiro ficam em `commerce.partner_stock_levels`, `commerce.partner_purchases` e `commerce.partner_purchase_items`.
- Financeiro do parceiro fica em `finance.partner_payables`, `finance.partner_receivables`, `finance.partner_receivable_installments` e `finance.partner_expenses`.
- O parceiro autentica pela role `farejador_partner_app`, sem `BYPASSRLS`, com RLS estrita por unidade.
- A matriz/admin pode ler dados consolidados por views de rede, mas o parceiro nao escreve em tabelas da matriz.

O Portal Parceiro nao escreve em:

- `raw.*`
- `core.contacts`, `core.messages` ou demais tabelas normalizadas do Chatwoot
- `agent.*`
- `ops.*`
- `commerce.orders` e `commerce.order_items` da matriz/legado

## Consequencias

Essa decisao permite evoluir PDV, estoque e financeiro do parceiro com baixo risco para o bot e para a base de atendimento. Se uma tela do parceiro tiver bug, o impacto fica limitado ao silo `partner_*` daquela unidade.

A matriz continua enxergando tudo que precisa por views e endpoints administrativos, mas essa leitura nao muda a regra de escrita: parceiro escreve apenas no proprio silo.

Qualquer proposta futura que faca o Portal Parceiro escrever em tabelas do bot, Chatwoot ou vendas da matriz deve abrir um ADR novo e justificar a quebra do silo.
