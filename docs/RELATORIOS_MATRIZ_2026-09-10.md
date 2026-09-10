# Relatórios da Matriz — primeira entrega

Implementação local em 10/09/2026, seguindo o modelo aprovado. Sem migration, variável de ambiente ou dependência nova. Nenhuma alteração nos fluxos do bot ou gravação de dados operacionais.

## O que foi entregue

- Menu **Relatórios**, exclusivo da Matriz e disponível para quem tem acesso a Vendas.
- Biblioteca com **Vendas da Matriz**, incluindo produtos e marcas na aba **Produtos**. O atalho lateral duplicado foi removido a pedido do usuário. Os demais itens são atalhos identificados para os módulos existentes; não são relatórios novos completos.
- Visão geral, produtos e lista paginada de vendas, com detalhe dos itens do recorte.
- Semana, mês e intervalo personalizado; comparação anterior; canal, marca, condição e medida. O clique em uma medida abre suas vendas; o clique em uma variante preserva marca e condição.
- CSV com todos os itens filtrados e PDF com resumo e todas as linhas da aba selecionada, independentemente da página visível.
- Uma visão salva por usuário/operação no navegador. Guarda apenas filtros e seleção da tela, não resultados. As datas salvas são fixas.
- Estados distintos de carregamento, ausência de vendas, erro e custo pendente; apresentação responsiva.

## Regras dos números

**Escopo:** varejo da unidade `main`, sem espelhos de pedidos de parceiros, com status `confirmed`, `paid` ou `delivered`; atacado confirmado. Transferências em trânsito ficam fora. Nas transferências acertadas/recebidas entram somente as quantidades aceitas.

**Datas:** fuso de São Paulo, início inclusivo e fim exclusivo no dia seguinte. Varejo usa `created_at`; atacado usa `sold_at`, como a tela Vendas. Trata-se de relatório comercial: caixa, entregas e reconhecimento financeiro podem usar outras datas.

**Vendas:** soma de quantidade × preço dos itens, menos descontos do varejo. Frete não entra. Serviços e outros produtos entram no valor vendido e nas quantidades gerais, mas não no indicador de pneus vendidos. Canceladas ficam fora.

**Custos e margem:** custo histórico de cada item da venda, nunca o custo atual do estoque. Se algum item não tem custo registrado, custo e margem totais do recorte ficam pendentes. Receita e quantidade continuam disponíveis. Margem é anterior às despesas. Custo zero explicitamente registrado continua sendo zero.

**Ticket:** valor dos itens filtrados dividido pelo número de vendas distintas que contêm esses itens. Uma venda com vários itens não é contada várias vezes.

**Identidade dos produtos:** no varejo, marca e medida vêm do catálogo vinculado, pois não há snapshot histórico desses dois campos. Preço, desconto, condição e custo vêm dos itens da venda. No atacado os campos vêm dos próprios itens históricos. A marca passa pelo normalizador já existente do catálogo.

**Comparação:** mês iniciado no dia 1 compara os mesmos dias do mês anterior, limitado ao fim daquele mês. Semana e personalizado usam o intervalo imediatamente anterior, de mesma duração. Ambos recebem os mesmos filtros. Gráficos longos agrupam dias, mantendo todos os valores no total.

## Acesso e limites

As três APIs GET exigem sessão da Matriz com permissão de Vendas. Custos e margens só são retornados para o dono ou usuário com acesso ao Financeiro, inclusive nos arquivos exportados. Consultas usam o ambiente do servidor; o cliente não pode escolher outro ambiente. As respostas usam `Cache-Control: no-store`.

As consultas não leem nomes, telefones, endereços nem mensagens dos clientes. O CSV identifica a venda por UUID; a tela mostra um código abreviado para leitura.

Intervalo máximo de 366 dias. Até 50.000 itens de origem, somando período e comparação antes dos filtros de marca/condição/medida. Acima disso, a API retorna 422 e pede redução do período ou canal; não trunca silenciosamente. Vendas são paginadas em grupos de 25. PDF aceita até 1.000 linhas da aba escolhida; acima disso orienta reduzir filtros ou usar CSV.

## Validação

- 1.789 testes unitários passaram, incluindo 8 específicos para regras, autorização, custos ocultos, exportação completa e erros.
- 3 testes de integração passaram em PostgreSQL descartável com as migrations reais: isolamento de ambiente/unidade, cancelamentos, datas no fuso, descontos, custos pendentes e históricos, serviços e transferências parciais.
- Build e TypeScript passaram; `git diff --check` sem erros.
- `scripts/prova-relatorios-ui.cjs` usa apenas dados fictícios locais e a agregação real. Confere filtros concorrentes, detalhe, paginação, visão salva, arquivos, custo restrito, estados de erro/vazio e celular.
- Com `--full`, também valida o acesso pelo menu e a renderização dentro do painel completo. Os PDFs foram renderizados e conferidos visualmente.

As verificações gerais de paridade e tamanho ainda apontam pendências anteriores a esta entrega: 9 propriedades e 9 rotas antigas ausentes dos baselines e 9 arquivos antigos acima dos tetos. Nenhuma propriedade ou rota anterior foi removida ou teve contrato alterado. Os baselines receberam somente os 29 membros e as 8 rotas desta funcionalidade; não absorveram as divergências anteriores.

O navegador do painel completo também reproduz erros anteriores `row is not defined` em expressões SVG dos gráficos de Compras. Não houve erro de expressão dos Relatórios. Esses gráficos e os arquivos antigos acima dos tetos não foram modificados nesta entrega.

Evidências locais ficam em `artifacts/relatorios/`: resultados unitários, imagens de desktop/celular, PDFs e diagnóstico do painel completo. Dados de teste não foram injetados em produção.
