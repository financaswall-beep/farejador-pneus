# Demanda por município — 11/09/2026

## Entrega

Relatórios → Demanda por município agora abre uma análise própria na central, em vez do atalho para Bot → Demanda e estoque. As abas são Visão geral, Municípios, Medidas e Evolução. Nenhuma delas contém mapas. O mapa já existente no módulo Bot continua no seu lugar.

- Ranking, busca, ordenação, paginação e seleção de município, inclusive fora da antiga região do mapa.
- Detalhe de conversas, pedidos, entregas, faltas, conversão e medidas por município.
- Medidas clicáveis, posição física atual da Matriz e procura da mesma medida nos demais municípios.
- Gráficos de linhas por indicador, dia ou blocos de sete dias; valores acessíveis também em tabela.
- Semana, mês, intervalo personalizado, comparação, visão salva por usuário/unidade no navegador, CSV e PDF vetorial.
- Estados distintos para carregamento, consulta vazia, filtro inválido, excesso de registros e falha no banco. Falha não aparece como zero.

## Significado dos números

**Conversas:** cada conversa com atividade registrada no intervalo conta uma vez. Atividade inclui respostas do Bot V2 com status enviado/entregue, consultas de medidas, faltas, pedidos criados ou entregas realizadas vinculadas. Não representa pessoas únicas.

**Com pedido:** conversa com pedido comercial criado no período, excluindo cancelados. Se houver pedido parceiro vinculado, ele também precisa existir, não estar cancelado nem excluído. Fatos analíticos antigos de `pedido_criado` não substituem o pedido comercial.

**Com entrega:** conversa com entrega realizada no intervalo, usando `delivered_at` da Matriz ou do parceiro responsável. Retirada não é entrega. O pedido pode ter sido criado antes do intervalo.

**Com falta:** conversa com ao menos um fato vigente de falta ou uma trilha de busca com loja indisponível no período. Pode haver pedido e falta na mesma conversa. Os indicadores não são etapas exclusivas de um funil.

**Conversão:** conversas com pedido criado no intervalo / conversas com atividade no intervalo. Sem conversas, não existe base para a taxa.

**Evolução:** cada indicador entra na primeira data em que ocorreu para a conversa dentro do intervalo. Os dias somam exatamente o indicador do período; retornos da mesma conversa não inflam a curva. Semanas são blocos de sete dias a partir da data inicial, com último bloco possivelmente parcial.

**Município:** último município conhecido da conversa, consultado em `analytics.v_bot_demand_location`; na ausência, última localização registrada na trilha de estoque. A normalização agrupa variações de caixa e acentos. Conversas sem município ficam separadas e podem ser selecionadas. A localização atual também é aplicada aos períodos anteriores; novas localizações ou correções podem mudar a distribuição histórica.

**Medidas:** uma ocorrência por conversa e medida normalizada dentro do intervalo, unindo fatos vigentes e trilhas sem duplicá-los. Uma conversa pode procurar vários pneus; a soma de consultas por medida pode superar a quantidade de conversas.

**Estoque:** posição física atual da Matriz somada entre marcas e condições, incluindo reservas. Não representa saldo disponível para prometer entrega nem estoque na data da consulta. Ausência de registro é “Não informado”, distinta de zero.

**Comparação:** sempre o mesmo número de dias. Mês em andamento usa os mesmos dias do mês anterior quando possível. Se o mês anterior não comportar a duração atual, usamos o intervalo imediatamente anterior de igual duração. As duas datas são exibidas. Base anterior zero não gera crescimento percentual artificial.

Os indicadores gerais e a lista de municípios abrangem o período inteiro. Município selecionado filtra os detalhes, medidas e série. A busca por município afeta a lista; a busca por medida afeta suas linhas e indicadores específicos. A distribuição da medida por outros municípios é explicitamente de toda a rede.

## Implementação e proteção

Três rotas GET em `/admin/api/relatorios/demanda`: consulta, `/exportar` e `/imprimir`, com `requireAdminAuth`, permissão `bot` da Matriz e `Cache-Control: no-store`. O ambiente vem da configuração do servidor e não pode ser escolhido na requisição. As respostas não expõem identificadores de conversa, endereços, telefone ou coordenadas.

Consultas em transação `REPEATABLE READ READ ONLY`, com limite de 15 segundos por instrução. Todas as fontes são filtradas por ambiente, datas de São Paulo e conversa não excluída. Limites: 366 dias, 50.000 combinações agregadas de conversa/tipo/medida por intervalo e 20.000 medidas de estoque. Ao exceder, retorna 422 pedindo um recorte menor, sem totais parciais. PDF limita a 1.500 linhas; CSV inclui todas as páginas dentro do limite do relatório e protege células contra interpretação como fórmula.

Nenhuma migration, variável, API externa ou dependência nova. Nenhuma alteração no prompt, nas ferramentas de atendimento ou nas regras de entrega. Nenhuma escrita no banco de produção. Dados demonstrativos existem apenas no teste local do navegador.

## Validação

- Build TypeScript e CSS.
- Suíte unitária completa: 343 arquivos e 1.850 testes aprovados. Um timeout de carga local na primeira execução foi repetido com sucesso; a execução completa final passou com tolerância de 20 segundos por teste.
- Testes unitários do relatório: deduplicação, reconciliação das séries, municípios sem localização ou fora do mapa, duração da comparação, filtros, CSV, autenticação e erros.
- Integração em Postgres temporário com migrations reais: limites de data BRT, isolamento prod/test, fatos substituídos, reservas, cancelados, entregas por data e leitura sem modificar trilhas.
- `scripts/prova-relatorios-demanda-ui.cjs --full`: quatro abas desktop/celular, cidade, medida, paginação, comparação, gráfico, visão salva, oito exportações, estados de erro/vazio e painel completo com acesso somente ao Bot.
- CSVs e PDFs salvos em `artifacts/relatorios-demanda/` para inspeção local. Artefatos de teste não são versionados.

As verificações gerais de paridade e tamanho ainda apontam as mesmas nove divergências anteriores em cada categoria. Nenhuma função ou rota existente foi removida ou teve seu tipo/guarda alterado; o baseline recebeu apenas 31 propriedades e nove rotas desta entrega. O painel completo também mantém o erro anterior `row is not defined` no gráfico de Compras; nenhuma nova falha de JavaScript foi encontrada no relatório.

## Ajuste visual da aba Medidas

A composição foi corrigida para seguir a imagem aprovada: tabela e gráfico na coluna esquerda; card da medida na direita com total de conversas, participação, estado do estoque e barras de comparação entre municípios. Cabeçalho, biblioteca, filtros e indicadores foram compactados apenas nesta aba. A lista de municípios admite rolagem e mantém todas as cidades acessíveis; clicar nela preserva a medida selecionada.

A miniatura do gráfico de medidas destaca o período selecionado. A comparação continua disponível nos dados exportados e no relatório de evolução do município. Nenhuma regra de cálculo, consulta SQL, migration ou variável foi alterada. O teste no navegador verifica também a geometria das duas colunas, o percentual da medida, a troca de cidade preservando a medida e a navegação nas quatro abas.
