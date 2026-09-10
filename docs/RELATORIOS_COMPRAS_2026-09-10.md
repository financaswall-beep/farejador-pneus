# Compras e fornecedores na central de Relatórios

Implementação em 10/09/2026, seguindo o conceito aprovado. Não requer migration, variável de ambiente ou dependência nova. As consultas são somente leitura; o cadastro de compras, a conferência, o estoque e o bot mantêm seus fluxos.

## Telas

- **Visão geral:** indicadores, evolução do valor comprado ou dos pneus recebidos, principais fornecedores e produtos.
- **Produtos:** medida, marca e condição; quantidade, custo médio com rateio e comparação com o período anterior. Expandir mostra fornecedores; o detalhe abre as compras da variante exata.
- **Fornecedores:** valores, quantidades e compras por fornecedor. Clicar mostra seus produtos; atalhos aplicam o fornecedor nas abas Produtos ou Compras.
- **Compras:** lista paginada e detalhe com quantidades solicitadas/aceitas, custo base e custo com rateio. O código CP abreviado identifica a compra; a OC é mostrada separadamente porque uma ordem pode ter várias compras.

Filtros compartilhados de semana/mês/período personalizado, comparação, fornecedor, marca, condição, recebimento e medida. Visão salva no navegador por usuário/operação, em chave separada da visão de Vendas. CSV e PDF respeitam a aba e os filtros; exportam todas as linhas, independentemente da página visível.

## Regras dos números

O período usa `wholesale_purchases.purchased_at` no fuso de São Paulo. Entram compras `pending` e `confirmed`; canceladas ficam fora. Recebimento e pagamentos representam a **posição atual das compras desse período**, não os movimentos de caixa ou recebimentos ocorridos no intervalo.

Quantidade é `accepted_quantity` após conferência, ou a quantidade registrada enquanto pendente. `ordered_quantity` permanece disponível no detalhe. Recusas não são classificadas como pneus em trânsito. Valores vêm de `allocated_cost`, incluindo frete e desconto rateados; o custo atual do estoque não participa.

O custo médio é ponderado pela quantidade. A comparação de produtos exige a mesma medida, marca e condição. A média geral pode variar também pela composição das compras. Mês compara os mesmos dias do mês anterior; semana e personalizado comparam o intervalo anterior de igual duração. O filtro de recebimento usa o estado atual em ambos os períodos.

Cada compra conta uma única vez. Pagamentos parciais usam o saldo da obrigação no livro financeiro. Filtrar um produto limita seus valores e quantidades, mas **pago e em aberto permanecem valores da compra inteira**, claramente identificados na interface e nas exportações. Não existe rateio artificial de pagamentos por item.

## Acesso e limites

Relatórios fica disponível na Matriz para usuários com Vendas **ou** Compras. Cada relatório e suas três APIs mantêm a permissão do respectivo módulo. Pagamentos só são retornados para dono ou usuário com Financeiro; usuário de Compras continua vendo seus custos de aquisição.

APIs: `GET /admin/api/relatorios/compras`, `/exportar` e `/imprimir`. Ambiente definido pelo servidor, joins isolados por ambiente, respostas sem cache. Nomes comerciais dos fornecedores são usados; documentos, telefones e notas não são consultados.

Até 366 dias e 50.000 itens somando os dois períodos antes dos filtros. Excesso retorna 422, sem truncamento silencioso. Listas usam páginas de 25; PDF aceita até 1.000 linhas da aba escolhida. Falha de consulta tem mensagem de erro, distinta de período vazio.

## Validação

- Build e TypeScript passaram; `git diff --check` limpo.
- **1.798 testes unitários passaram**, incluindo 9 do novo relatório e a verificação de acesso ao menu com somente Compras ou somente Vendas.
- **2 testes de integração** passaram em PostgreSQL 17 descartável, com migrations reais, conferência parcial, frete/desconto, pagamento parcial, cancelamento, limites de data no fuso e isolamento de ambiente. Nenhum dado de teste foi inserido em produção.
- `scripts/prova-relatorios-compras-ui.cjs --full`: quatro abas, detalhes, filtros concorrentes, paginação, visão salva, CSV/PDF, pagamentos restritos, erro/vazio e celular. Painel completo com usuário de Compras não consulta Vendas.
- `scripts/prova-relatorios-ui.cjs --full`: relatório de Vendas continua passando após compartilhar as primitivas de PDF e as regras de período.
- PDFs exportados renderizados e conferidos visualmente; evidências locais em `artifacts/relatorios-compras/`.

As provas gerais ainda apontam as mesmas pendências anteriores: 9 propriedades e 9 rotas ausentes dos baselines, 9 arquivos antigos acima do teto de linhas e erros `row is not defined` em gráficos SVG antigos do módulo operacional de Compras. Não houve novo erro no painel completo. Os baselines receberam somente 26 propriedades e 9 rotas desta entrega, preservando as divergências anteriores.
