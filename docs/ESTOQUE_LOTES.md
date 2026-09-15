# Estoque → Lotes

A aba **Lotes** do Estoque da Matriz lista as entradas registradas em **Comprar lote** e em **Registrar separação**. A lista permite busca, situação, seleção do lote e paginação; a aba Movimentações mostra o histórico completo, também paginado.

Os indicadores consideram todos os lotes da operação. A busca e a situação filtram a lista. Compras ainda a caminho aparecem nesse filtro com saldo zero. O disponível desconta reservas; o custo restante inclui todo o estoque físico do lote. O custo por pneu inclui frete e desconto alocados pela compra e é apresentado em reais com duas casas decimais.

## Separação

O proprietário escolhe um pneu já disponível no estoque cadastrado, a quantidade, a descrição do lote e o motivo. A operação transfere essa quantidade para um lote sem marca/medida comercial, conservando a identificação e o custo da origem no histórico.

O servidor bloqueia a origem durante a operação, respeita reservas e calcula o custo transferido pela diferença entre o valor do estoque antes e depois, em centavos. Assim, separar em partes não perde centavos de custos como R$ 100 divididos por três pneus. A baixa no estoque e a entrada no lote são atômicas. A chave de idempotência persiste na sessão do navegador e permite reenviar após uma resposta perdida sem duplicar a separação. Não há nova compra, pagamento ou despesa. O lote permanece separado do estoque consultado pelo bot.

## Entrega desta etapa

- Migration **0231_tire_lot_separation.sql**, posterior à 0230 das compras. Aplicar antes de publicar a aplicação; nenhuma variável nova.
- Consultas limitadas ao ambiente configurado e protegidas pelo módulo Estoque. Compra de origem exige Compras. Mutações somente para o proprietário.
- Origem do lote e movimentações preservadas. A separação não entra no relatório de itens comprados.
- A terceira tela, **Venda de lote**, permanece para a próxima etapa combinada. O botão aparece na posição aprovada, desabilitado com indicação explícita; não usa a venda atual de pneus cadastrados.

Verificação: integração com PostgreSQL, incluindo compra recebida/a caminho, reservas, custo, origem, trilha da separação, ausência de novos pagamentos, isolamento de ambientes, idempotência e imutabilidade. Testes do navegador usam dados ilustrativos somente em localhost, sem registros em produção.

O verificador histórico `prova-colisoes-painel` também compara um manifesto antigo de propriedades: ele continua acusando funcionalidades adicionadas desde aquela refatoração (incluindo esta tela), sem propriedades removidas ou mudanças de tipo. A montagem real do painel e as interações de Lotes foram verificadas no navegador sem novos erros. A página completa já apresenta erros `row is not defined` em outras seções na carga inicial, presentes antes desta alteração.
