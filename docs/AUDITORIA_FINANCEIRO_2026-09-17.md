# Correções e revisão financeira — 17/09/2026

Status: migrações **0237 e 0238 aplicadas em produção** em 17/09/2026, por volta de 11:58 (Brasília), pelo executor oficial com commit e checksums registrados. Correções do backend preparadas para publicação; deploy e reteste da interface ainda precisam ser confirmados.

## Falhas confirmadas e corrigidas

| Falha | Evidência e comportamento corrigido |
| --- | --- |
| Financeiro bloqueado por reserva cancelada | PED-0017 gerava `retail_revenue_missing` e `retail_stock_decrement_missing` sem venda. A conciliação agora distingue realização de custo congelado na reserva. Venda realmente realizada e sem lançamento continua gerando alerta, inclusive se cancelada posteriormente. |
| Faturamento do Bot incluía pedidos abertos | Os indicadores usam a mesma visão de vendas realizadas, pela data da entrega/retirada. Excluem reservas, cancelamentos, pedidos manuais e conversas com `farejador_simulator=true`. A situação, valor e data do parceiro são respeitados. |
| Reprocessamento podia criar recebimento de pedido cancelado | Reproduzido em Postgres descartável: o caminho de pagamento retornava uma transação para retirada cancelada. Agora não cria receita, recebimento ou obrigação de devolução nesse cenário. A seleção do backfill também ignora reservas canceladas e entregas pendentes. |
| Entrega pendente podia gerar alerta de CMV ausente | Baixa física antecipada não exige reconhecimento do custo de venda antes da entrega, conforme a regra já usada pelo lançamento. Conciliação e contabilização passaram a seguir a mesma condição. |
| Reserva cancelada na virada do mês gerava divergência | A comparação origem × livro exclui reservas que nunca se realizaram. O cancelamento realizado usa a data auditada, com fallback histórico para `updated_at`. |
| Retirada reconhecida no mês da criação | Reproduzido com pedido criado em julho e retirado em setembro. Receita e indicadores passam a usar `retrieved_at`; vendas antigas sem esse campo mantêm `created_at` como fallback. Nenhum lançamento histórico foi reescrito. |
| Custo pendente de outro mês afetava o mês consultado | O cálculo de receita com custo pendente agora respeita o mês da realização e exclui entregas ainda pendentes. |
| Cancelamento após pagamento parcial no atacado e nas compras | Reproduzido em ambos: operação de R$ 100 com R$ 40 pagos gerava estorno integral sem separar a devolução. Agora cancela os R$ 60 restantes e registra R$ 40 a devolver ao cliente ou recuperar do fornecedor, preservando o caixa até a devolução efetiva. |
| Baixa posterior de título com cancelamento composto | A seleção da obrigação bloqueia também cancelamentos que geram devolução parcial, além dos estornos espelhados. A proteção vale para varejo, atacado e compras. |

## Arquivos principais

- `db/migrations/0237_retail_reservation_financial_reconciliation.sql`: realização do varejo e conciliação, preservando as demais verificações existentes.
- `db/migrations/0238_bot_realized_sales_metrics.sql`: visão comum das vendas realizadas e indicadores diários.
- `src/admin/painel/matriz-ledger-retail-sales.ts`: data de retirada e bloqueio de recebimento indevido.
- `src/admin/painel/matriz-ledger-stage3-reconciliation.ts`: seleção do reprocessamento.
- `src/admin/painel/matriz-ledger-financial-read.ts`: origem, cancelamento e custo pendente por competência.
- `src/admin/painel/matriz-ledger-purchases.ts` e `matriz-ledger-wholesale-sales.ts`: cancelamento com pagamento parcial.
- `src/admin/painel/matriz-ledger-settlement-payment.ts`: bloqueio de nova baixa após cancelamento.
- `src/admin/painel/queries-bot-movimento.ts`: mesma visão comercial dos cards diários.

## Validação

- 113 cenários de integração distintos, em 18 arquivos, cobrindo as regressões novas e os fluxos de compras, vendas, estoque, despesas, logística, marketing, rede, colaboradores, crédito e relatórios. Bancos locais descartáveis; não foram criados pedidos na produção nesta revisão.
- 83 testes unitários passaram. Três verificações antigas de texto/layout falham porque esperam textos e uma versão de CSS que já não existem no HTML do `HEAD`. O arquivo de interface está idêntico ao `HEAD`; essas falhas não foram ocultadas nem corrigidas alterando a tela. Evidências: `artifacts/finance-unit-results.json` e `artifacts/finance-ui-baseline.json`.
- TypeScript, manifesto das migrações e verificação de whitespace executados.
- Testes novos reproduziram os erros antes das correções; a reprodução de cancelamentos parciais ficou em `artifacts/finance-partial-cancel-before.json`.

### Ensaio na produção, sem persistência

Em 17/09/2026 às 11:32, horário de Brasília, as duas migrações foram executadas dentro de uma transação encerrada obrigatoriamente com rollback. Os alertas do PED-0017 passaram de dois para zero durante o ensaio. As demais verificações da etapa 3 ficaram iguais.

Antes e depois: 3 transações financeiras, 7 pedidos, 536 eventos de auditoria, 5 pneus físicos e 0 reservados. Nenhum desses fatos mudou. O faturamento realizado do dia foi zero. Depois do rollback, a conciliação original voltou; naquele momento a aplicação permanente ainda estava pendente.

Evidência: `artifacts/finance-production-dry-run.json`. Executor local: `artifacts/validar-correcao-financeiro.cjs`, sem opção de commit.

### Aplicação permanente na produção

As migrações 0237 e 0238 foram aplicadas, nessa ordem, com `scripts/apply-migration-file.cjs`, destino verificado e manifesto conferido. O banco passou da versão 236 para 238. Todos os indicadores da conciliação da etapa 3 ficaram zerados, incluindo faltas, divergências de valor, órfãos e duplicidades.

Permaneceram iguais: 3 transações financeiras, 7 pedidos, 5 pneus físicos e 0 reservados. A visão diária retornou zero vendas realizadas e faturamento zero no dia. Evidência local: `artifacts/finance-migration-apply.json`. A verificação do banco não substitui a validação da interface após o deploy do backend.

## Publicação e validação restantes

1. Publicar o backend com os arquivos desta correção. As visões necessárias já estão disponíveis no banco de produção.
2. Conferir a saúde completa da integração, abrir o Financeiro e comparar os dois indicadores do Bot. Não executar backfill com a versão antiga do backend.
3. Retestar cancelamento de reserva com a nova versão e confirmar ausência de lançamentos, liberação da reserva, conciliação saudável e faturamento inalterado.

Não apagar pedidos/custos, criar receita fictícia ou desativar a trava do Financeiro. As migrações alteram definições, não os fatos financeiros históricos. O relatório não certifica ausência de qualquer defeito: concorrência entre cancelamento e recebimento e cancelamento após baixa por perda de crédito não foram validados nesta rodada.
