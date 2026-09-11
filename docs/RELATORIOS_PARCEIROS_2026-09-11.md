# Relatórios — Desempenho dos parceiros

Implementa o conceito aprovado em Relatórios, com Visão geral, Parceiros, Vendas e Comissões. A biblioteca abre a consulta dentro da central. O acesso acompanha a permissão Rede, inclusive quando ela é o único módulo liberado ao administrador.

## Comportamento

- Semana, mês e período personalizado de até 366 dias; comparação, município cadastrado da loja, busca, atividade e situação.
- Gráfico diário, ranking e parceiro selecionável com vendas, ticket, participação, origem e comissões. Várias lojas do mesmo parceiro são agrupadas; o município restringe as lojas consideradas.
- Vendas e comissões com detalhes, filtros próprios e paginação de 25 linhas. Os filtros da lista não alteram os indicadores gerais do recorte.
- CSV com todas as linhas e PDF vetorial com até 1.000 registros. As exportações consultam os dados novamente. Visão salva guarda somente filtros no navegador, por usuário e local de trabalho.
- Estados explícitos de erro, vazio, período inválido e comissões indisponíveis; apresentação adaptada ao celular.

## Regras de leitura

Vendas usam a mesma realização da Rede: entrega concluída em `delivered_at`; retirada concluída em `retrieved_at`, com criação como alternativa para venda direta. Pedidos ainda aguardando retirada, cancelados ou removidos ficam fora dos totais. Entregas concluídas sem data são sinalizadas e não recebem uma data inventada. O fuso é America/Sao_Paulo. O total da venda inclui frete.

Comissões vêm de `network.commission_entries`, com base e percentual congelados. Geradas preservam os valores originais realizados no período. Recebimentos e estornos têm suas próprias datas. O detalhe mostra também quanto das comissões daquele período foi recebido ou estornado até agora.

Em aberto e devoluções pendentes mostram a posição atual, inclusive de outros períodos. Devolução ao parceiro após estorno de comissão recebida é separada do que ele deve à Matriz. Mensalidades ficam fora deste relatório. Vendas do Farejador sem comissão vinculada são sinalizadas sem estimativa, pois o contrato pode ser de mensalidade.

O relatório usa transação `REPEATABLE READ READ ONLY`, isolamento por ambiente, timeout e limites explícitos: 2.000 lojas, 20.000 vendas e 20.000 comissões no conjunto consultado. Exceder um limite retorna erro, sem total parcial. Não chama a conciliação operacional nem cria lançamentos. A resposta não inclui telefone, documento ou endereço do cliente.

## Implantação

Não exige migration nem variável nova. Reutiliza as tabelas e a flag existente `NETWORK_COMMISSION_LEDGER`. Com a flag desligada, as vendas funcionam e as comissões aparecem como indisponíveis. Os arquivos estáticos foram registrados e a versão do cache do painel foi atualizada.

## Validação

- Build e TypeScript aprovados; suíte unitária: 1.837 testes aprovados.
- Postgres 17 temporário: venda com frete, taxa congelada após mudança contratual, entrega e retirada pendentes, isolamento prod/test, cancelamento após recebimento, devolução e consulta sem criação de registros.
- `scripts/prova-relatorios-parceiros-ui.cjs --full`: quatro abas, seleção, filtros, comparação, paginação, concorrência, visão salva, exportação completa, estados de erro/vazio/flag desligada, celular e painel com somente Rede. Dados fictícios locais; nenhuma carga em produção.
- PDFs renderizados e conferidos visualmente. Evidências locais em `artifacts/relatorios-parceiros/`.

As verificações gerais de paridade e tamanho continuam apontando as pendências anteriores: nove propriedades do Catálogo/Clientes fora do baseline, nove rotas de Faltas/Clientes/Catálogo fora do baseline e nove arquivos antigos acima do limite de linhas. Esta entrega registra apenas suas 39 propriedades e nove rotas, sem ocultar essas pendências. O painel completo mantém o aviso anterior `row is not defined` do gráfico legado de Compras; a nova tela não acrescentou erros.
