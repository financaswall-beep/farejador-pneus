# Vendas de lotes

Acesso: **Vendas → Lotes**, depois de Atacado. A tela vende os lotes não catalogados já recebidos ou separados no Estoque. Não oferece seleção de produto do catálogo. O botão “Iniciar venda com este lote” do Estoque abre esta tela com o lote escolhido; a quantidade pode ser reduzida ou combinada com outras entradas.

O formulário usa os compradores existentes do atacado e permite cadastrar outro. Recebe descrição, data, quantidade, valor total negociado, desconto e pagamento. A distribuição começa pelos lotes mais antigos e pode ser editada. A prévia mostra custo da saída, margem bruta e saldo físico restante em cada lote. Reservas não ficam disponíveis para venda. O rascunho fica apenas na sessão do navegador, identificado pelo operador e ambiente; não reserva estoque nem cria financeiro.

## Confirmação e financeiro

- `POST /admin/api/wholesale/lot-sales`: somente owner, permissão Vendas. Ambiente vem da configuração do servidor, nunca do corpo. Validação de comprador único, quantidades inteiras, centavos, desconto, vencimento e lotes distintos.
- Uma transação trava os lotes por ID, revalida recebimento, reservas e saldo, compara o custo atual com o revisado na tela e confirma estoque + venda + financeiro + auditoria. Chave de idempotência e impressão dos parâmetros impedem duplicação por reenvio. Falhas com resultado incerto mantêm os mesmos dados para repetição.
- O custo proporcional sai do **valor restante** do lote. O saldo conserva os centavos residuais. Cada item congela sua quantidade, custo e parcela do valor líquido negociado; cancelamentos usam esses registros, não preços atuais.
- Usa `commerce.wholesale_orders` e `wholesale_order_items`, distinguindo `is_lot_sale` e `tire_lot_id`. Os itens de lote não têm condição de catálogo; a descrição é uma identificação para as telas existentes. Nenhum produto ou saldo em `wholesale_stock` é criado. Acréscimos de catálogo não podem ser vinculados a uma venda de lotes.
- À vista reconhece recebimento e custo no livro central existente. Fiado cria recebível, quitável no Financeiro já existente. Totais de vendas e relatórios financeiros continuam incluindo o valor e o custo dessa operação uma única vez. Margem bruta não desconta as demais despesas.
- `POST /admin/api/wholesale/lot-sales/:id/cancel`: cancelamento integral com motivo e idempotência, usando o cancelador existente. Repõe cada quantidade e custo no lote original. Fiado ainda aberto é revertido; venda já paga gera devolução a pagar, sem fingir que o dinheiro já foi devolvido. Cancelamentos não apagam o histórico.
- `GET /admin/api/wholesale/lot-sales`: histórico paginado de 20 vendas e lotes disponíveis. O histórico inclui canceladas e detalha os lotes usados. Movimentações aparecem também em Estoque → Lotes.

## Migração e publicação

Requer **0232_tire_lot_sales.sql**, depois de 0230 e 0231. A migração acrescenta a distinção da venda/itens e movimentos de saída/cancelamento. Os custos e preços unitários dos itens passam a preservar casas decimais necessárias para dividir um total negociado; os totais monetários continuam arredondados em centavos. Triggers protegem o tipo da operação e a imutabilidade dos itens de lotes. Os itens existentes continuam catalogados, com as validações da API anterior.

Não cria variável nova. Usa `WHOLESALE_FINANCE` e `MATRIZ_CENTRAL_LEDGER`, que precisam estar ativos. Sem a migração, a tela informa a atualização pendente e bloqueia confirmação. Não foi aplicada migração nem alteração de dados em produção neste trabalho; 0231 já estava pendente de autorização na sessão anterior.

## Validação local

- Unitários: distribuição com reservas, centavos residuais, dados inválidos, permissões por módulo, dinheiro brasileiro, rascunho sem escrita e repetição segura de venda/cancelamento.
- Integração: replay integral das migrações em PostgreSQL local via PGlite; compras e vendas parciais reais, mistura de dois lotes, financeiro e totais, desconto, fiado e quitação pelo fluxo existente, cancelamento pago/pendente, imutabilidade e isolamento de ambiente. Impede custo desatualizado, venda anterior ao recebimento, compra pendente e cancelamento de compra consumida. A regressão inclui compras, separação, custos do estoque, atacado multimarcas e livro central do atacado. PGlite não prova concorrência entre conexões; a implementação usa `FOR UPDATE` com ordem estável.
- Navegador: aplicação real servida em localhost com respostas simuladas, sem requisições de produção. Testes do menu, distribuição automática/manual, reserva/saldo inválido, desconto, à vista/fiado, rascunho, confirmação com resposta perdida, histórico/cancelamento, atualização pendente, erro/repetição e celular.
- O fiscal global de tamanho mantém 12 falhas anteriores fora deste trabalho. Os arquivos alterados respeitam seus tetos. Há 13 erros iniciais preexistentes de `row is not defined` na aplicação completa; nenhum erro novo nos fluxos da tela de lotes.
