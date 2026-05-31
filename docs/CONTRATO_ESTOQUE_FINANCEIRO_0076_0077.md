# Contrato operacional - Estoque reservado e financeiro realizado

> Status: implementado em producao em 2026-05-31.
> Dono da regra: Wallace.
> Implementacao/auditoria: Codex + Claude Opus.
> Commits principais:
> - `6f45b80` - estoque reservado 0076.
> - `3f832e9` - Frente de caixa mostra disponivel.
> - `7ffcb3f` - cliente/VIP conta so venda concluida.
> - `d2b772c` - financeiro alinhado a venda realizada 0077.

Este documento e leitura obrigatoria antes de qualquer mudanca em Estoque,
Frente de caixa, Pedidos/Entrega, Clientes, Compras ou Financeiro do parceiro.

## Regra-matriz

O sistema separa tres quantidades:

- `quantity_on_hand`: fisico. O que existe de verdade na loja.
- `quantity_reserved`: reservado. O que esta prometido em delivery/COD aberto.
- `available`: disponivel para vender agora.

Formula obrigatoria:

```text
available = quantity_on_hand - quantity_reserved
```

Pedido aberto/reservado nao e venda concluida.

Delivery/COD so vira venda realizada quando marcado como `delivered`.

## Fluxos obrigatorios

### Balcao / pickup

- Baixa fisica acontece na criacao da venda.
- Entra como venda realizada no financeiro na data `created_at`.
- Entra nos indicadores de cliente/VIP imediatamente, desde que nao seja cancelada.

### Delivery / COD

Na criacao:

- reserva estoque;
- aumenta `quantity_reserved`;
- nao baixa `quantity_on_hand`;
- cria conta a receber aberta;
- nao conta como venda realizada;
- nao conta para VIP;
- nao entra em "Caixa do dia".

Na entrega (`delivery_status = delivered`):

- converte reserva em baixa fisica;
- diminui `quantity_on_hand`;
- zera/diminui `quantity_reserved`;
- marca a conta a receber como `received`;
- entra no "Caixa do dia" via recebivel recebido;
- entra em vendas do mes pela data `delivered_at`;
- conta para cliente/VIP.

No cancelamento/falha antes da entrega:

- libera reserva;
- fisico fica intacto;
- conta a receber e cancelada;
- nao conta como venda;
- nao conta como caixa;
- nao conta para cliente/VIP.

## Banco de dados

### Migration 0076

Arquivo: `db/migrations/0076_partner_stock_reserved.sql`.

Responsabilidades:

- adiciona `commerce.partner_stock_levels.quantity_reserved`;
- adiciona CHECK `quantity_reserved >= 0`;
- garante `quantity_on_hand >= quantity_reserved` quando `quantity_on_hand` nao e NULL;
- libera `stock_status = 'reserved'`;
- cria `commerce.partner_stock_status(...)`;
- altera `commerce.register_partner_local_order(...)`;
- cria `commerce.deliver_partner_local_order(...)`;
- altera `commerce.cancel_partner_local_order(...)`.

### Migration 0077

Arquivo: `db/migrations/0077_partner_finance_realized_delivery_dates.sql`.

Responsabilidades:

- recria `network.partner_unit_summary`;
- `sales_month`, `orders_month` e `cogs_month` usam data de realizacao;
- pickup/balcao usa `created_at`;
- delivery/COD usa `delivered_at`;
- preserva `security_invoker = true`;
- preserva `GRANT SELECT` para `farejador_partner_app`.

## Funcoes e helpers obrigatorios

### Status de estoque

Qualquer atualizacao de status deve usar:

```sql
commerce.partner_stock_status(quantity_on_hand, quantity_reserved, minimum_quantity, is_tracked)
```

Nao recalcular `stock_status` no braco com `CASE` antigo que ignora reserva.

### Entrega

Ao marcar delivery como entregue, a ordem obrigatoria e:

1. chamar `commerce.deliver_partner_local_order(orderId, actor)`;
2. depois atualizar `commerce.partner_orders.delivery_status = 'delivered'`;
3. depois marcar a conta a receber como `received`.

Nunca atualizar `delivery_status = 'delivered'` antes de converter a reserva.

### Data de realizacao

No front, usar:

```js
saleRealizedAt(sale)
```

Regra:

- delivery: `delivered_at || created_at`;
- pickup/balcao: `created_at`.

Indicadores financeiros e de cliente devem usar `completedSales`, nao `activeSales`.

## Proibicoes

Nao fazer:

- vender usando `quantity_on_hand` direto sem descontar `quantity_reserved`;
- inativar item com `quantity_reserved > 0`;
- ajustar saldo fisico para abaixo do reservado;
- contar delivery aberto como venda realizada;
- contar delivery cancelado/falhado como venda do cliente;
- contar pedido reservado para VIP;
- recalcular status ignorando `quantity_reserved`;
- criar novo fluxo de baixa fisica fora de `register`, `deliver` e `cancel`;
- reativar parcelamento de venda sem uma nova auditoria de recebiveis/parcelas.

## Frontend

### Frente de caixa

O card e o dropdown devem mostrar quantidade vendavel:

```text
9 disp. (10 fis.)
```

quando houver reserva.

O carrinho deve bloquear pela disponibilidade:

```js
stockAvailable(item)
```

### Estoque

Tela de estoque pode mostrar fisico, reservado e disponivel.

Valor em estoque continua usando fisico, porque o produto ainda esta na loja ate a entrega.

### Clientes

Clientes, total comprado, ultima venda e VIP devem usar somente venda realizada:

- pickup/balcao nao cancelado;
- delivery entregue.

Delivery aberto, cancelado ou falhado nao conta.

### Financeiro

"Caixa do dia" soma:

1. vendas realizadas hoje pagas na hora;
2. recebiveis com `status = 'received'` e `received_at` hoje.

Isso inclui COD entregue hoje via recebivel recebido.

Nao somar COD aberto como caixa.

Nao duplicar venda a vista: venda a vista nao gera recebivel.

## Parcelamento

Regra atual do negocio: nao existe venda parcelada.

O sistema deve enviar:

```json
{ "receivable_installments": 1 }
```

O backend deve recusar `receivable_installments > 1` com:

```text
installments_not_supported
```

Nao remover tabelas antigas de parcelas sem projeto separado. Elas ficam como estrutura
legada/desligada.

## Testes obrigatorios apos mexer nesses fluxos

1. Criar delivery/COD com 1 item rastreado.
2. Confirmar: fisico nao baixa, reservado sobe, disponivel cai.
3. Confirmar: Frente de caixa nao deixa vender mais que o disponivel.
4. Confirmar: cliente/VIP nao conta enquanto delivery esta aberto.
5. Marcar como entregue.
6. Confirmar: fisico baixa, reservado zera, caixa do dia sobe via recebivel.
7. Confirmar: contas a receber baixa.
8. Confirmar: cliente/VIP passa a contar.
9. Criar outro delivery e cancelar antes de entregar.
10. Confirmar: reserva libera, caixa nao sobe, cliente/VIP nao conta.
11. Tentar ajustar saldo abaixo do reservado.
12. Confirmar: bloqueia com mensagem, sem erro 500.
13. Tentar inativar item reservado.
14. Confirmar: bloqueia com mensagem, sem erro 500.
15. Chamar API com `receivable_installments > 1`.
16. Confirmar: retorna 400 `installments_not_supported`.

## Checks tecnicos antes de deploy

Rodar:

```text
node --check parceiro/public/app.js
npm run typecheck
```

Se houver migration:

```text
node --env-file=.env scripts/apply-migration-file.cjs db/migrations/NNNN.sql
```

Primeiro em dry-run. So depois aplicar com `--commit`.

## Estado conhecido em 2026-05-31

- `quantity_reserved` existe em producao.
- `commerce.partner_stock_status(...)` existe em producao.
- `network.partner_unit_summary` usa `delivered_at` para delivery realizado.
- `delivered_sem_delivered_at = 0` no momento da 0077.
- `parcelas_ativas = 0` no momento da 0077.
- 0076 e 0077 aplicadas em producao.
- Deploy do runtime deve sempre vir depois da migration correspondente.

## Para proximas LLMs/devs

Antes de alterar qualquer secao relacionada, leia este arquivo inteiro.

Se sua mudanca mexer com venda, entrega, estoque, cliente ou financeiro, explique
explicitamente qual impacto ela tem sobre:

- fisico;
- reservado;
- disponivel;
- venda realizada;
- caixa;
- a receber;
- cliente/VIP.

Se nao conseguir explicar esses impactos, nao implemente ainda.
