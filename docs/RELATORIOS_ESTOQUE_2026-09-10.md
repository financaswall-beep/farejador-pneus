# Estoque e reposição na central de Relatórios

Implementado em 10/09/2026 a partir do modelo aprovado. Não requer migration, variável de ambiente ou dependência nova. As APIs do relatório são somente leitura e usam as tabelas existentes de estoque, políticas de mínimo, compras e movimentações.

## Telas

- **Visão geral:** disponibilidade, reservas, compras a caminho, grupos que precisam repor, prioridades, maior saída e produtos sem giro. Clicar na medida atualiza o detalhe com mínimo, sugestão, cobertura e marcas.
- **Produtos:** medidas agrupadas por condição, somando marcas; saldo físico, reservas, disponível, trânsito, giro, cobertura e situação. Lista paginada de 25 linhas.
- **Reposição:** somente grupos com sugestão positiva, descontando compras em trânsito. Produtos sem mínimo são identificados e têm acesso ao cadastro no módulo Estoque.
- **Movimentações:** histórico físico por medida, marca e condição, com origem e saldos antes/depois. Filtros de entradas, saídas, registros sem alteração e origem; páginas de 25 eventos.

Base do giro de 30, 60 ou 90 dias, condição, situação e busca por medida. Visão salva neste navegador por usuário/operação, em chave própria. Restaurar consulta os saldos novamente. CSV e PDF respeitam filtros e aba, exportando todas as linhas, independentemente da página visível. Exportar também consulta a posição atual novamente.

## Regras dos números

**Estoque é a posição atual, e não um saldo reconstruído do período.** O período cobre hoje e os 29, 59 ou 89 dias anteriores no fuso de São Paulo. Mudar essa base afeta giro e movimentações; os saldos continuam atuais.

Disponível = físico menos reservado. Trânsito = quantidade ainda não aceita em compras pendentes; compras canceladas e recusas de compras já concluídas ficam fora. Uma marca ainda ausente do estoque também entra se tiver compra pendente. Políticas de mínimo sem saldo cadastrado continuam visíveis.

O mínimo é por medida e condição, somando marcas; nunca se somam mínimos repetidos por marca. A política vigente prevalece, com compatibilidade para o mínimo legado do estoque. A sugestão é `max(0, mínimo − disponível − trânsito)`. Sem mínimo, retorna ausência de sugestão em vez de inventar uma quantidade.

Giro corresponde às saídas físicas de atacado/varejo menos devoluções registradas no período, limitado a zero por grupo. Reservas abertas, compras e ajustes manuais não contam como vendas. O histórico de uma marca removida continua no giro quando sua medida/condição existe no estoque, no trânsito ou nas políticas atuais.

Cobertura = disponível dividido pelo giro médio diário. Desconsidera o que ainda chegará e retorna “Sem giro para estimar” quando não há saída líquida. É estimativa, não promessa de prazo. Grupos sem disponível têm essa indicação mesmo quando o físico está integralmente reservado.

Movimentações mostram a trilha da variante, não o saldo agregado entre marcas. Alterações apenas de reserva não são eventos físicos. Seus filtros de origem/tipo não modificam os indicadores do estoque ou o cálculo de giro. A situação, quando filtrada, é a situação **atual** da medida/condição.

## Integração e acesso

“Abrir plano em Compras” exige permissão de Compras, lê novamente estoque e referências de preço e reutiliza o planejador existente. Preserva compras em trânsito de marcas novas. Abre o plano filtrado pela medida/condição escolhida; não grava nem envia uma compra automaticamente.

Relatórios fica disponível na Matriz para usuários com Vendas, Compras ou Estoque. A biblioteca e as APIs respeitam a permissão de cada módulo. Este relatório exige Estoque e não retorna custos, dados de clientes ou notas livres.

APIs: `GET /admin/api/relatorios/estoque`, `/exportar` e `/imprimir`. Ambiente definido pelo servidor. Consultas usam uma transação `REPEATABLE READ READ ONLY`, limite de 15 segundos por consulta e respostas sem cache. Falha retorna erro distinto de conjunto vazio.

Limites explícitos: 20.000 variantes e 50.000 movimentos antes dos filtros, com erro 422 em vez de truncamento. PDF até 1.000 linhas da aba; CSV cobre o conjunto consultado. Nenhuma alteração no bot, no registro de compras ou nas movimentações operacionais.

## Validação

- Build/TypeScript e `git diff --check` passaram.
- **1.808 testes unitários passaram**, incluindo dez do novo relatório e acesso ao menu com somente Estoque.
- **Três testes de integração passaram** em PostgreSQL 17 descartável com migrations reais: reservas, mínimo agregado, marca nova em trânsito, cancelamento, devolução, políticas sem saldo, bases de giro e isolamento de ambiente. Nenhum dado de teste foi inserido em produção.
- `scripts/prova-relatorios-estoque-ui.cjs --full`: quatro abas, detalhes, filtros concorrentes, paginação, visão salva, CSV/PDF completos, plano sem gravação, erro/vazio, celular e usuário com somente Estoque.
- Provas de navegador dos relatórios de Vendas e Compras continuam passando no painel completo.
- PDFs renderizados e conferidos visualmente, assim como as telas de computador e celular. Evidências locais em `artifacts/relatorios-estoque/`.

As provas gerais mantêm as pendências já documentadas em Compras: nove propriedades e nove rotas anteriores ausentes dos baselines, nove arquivos antigos acima do limite de linhas e erros `row is not defined` em gráficos SVG antigos de Compras. Nenhuma divergência nova: os baselines receberam somente as 23 propriedades e oito rotas desta entrega.
