# Entregas e rotas na central de Relatórios

Implementado em 10/09/2026 a partir do modelo aprovado. Não requer migration, variável ou dependência nova. Usa a flag existente `MATRIZ_LOGISTICS` e consultas somente leitura sobre os registros atuais de Logística.

## Telas

- **Visão geral:** entregas concluídas, rotas encerradas, quilômetros registrados, despesa por entrega, gráfico e últimas rotas. A seleção atualiza o detalhe com horários, quilometragem, fretes, despesas, comprovantes e motivos das ocorrências.
- **Rotas:** todas as rotas do período, com paginação de 25 linhas e o mesmo detalhe lateral.
- **Entregas:** pedidos vinculados às rotas, cliente, entregador, situação, previsão/conclusão e motivo da falha. Permite restringir pela rota e situação da entrega.
- **Custos e comprovantes:** despesas efetivamente vinculadas e documentos pendentes/rejeitados, com filtro por rota e situação. O comprovante abre em uma janela sobre o relatório, pelo endpoint autenticado já existente.

Semana, mês ou período personalizado de até 366 dias, entregador, situação da rota e busca. A visão salva guarda apenas filtros neste navegador, por usuário/operação, em chave própria. Restaurar ou exportar consulta os registros novamente. CSV e PDF respeitam a aba e os filtros, independentemente da página visível. O botão “Abrir Logística” abre o módulo operacional, sem alterar registros.

## Regras dos números

**O período seleciona rotas:** encerradas pela data de retorno, abertas pela saída, no fuso de São Paulo. Indicadores e gráfico usam esse mesmo conjunto. O gráfico agrupa pelo dia da rota, não pelo horário individual de cada entrega. Pedidos ainda sem rota permanecem na fila do módulo operacional.

O relatório consulta períodos anteriores aos 30 dias do painel operacional. Entregas consideram somente pedidos de entrega da Matriz. Uma tentativa sem sucesso pode aparecer na rota original e a reentrega na rota seguinte. As falhas desvinculadas no encerramento são recuperadas dos eventos existentes `delivery_report_detached_on_trip_close`, com o motivo daquele momento. A consulta não inventa histórico para ações antigas que não deixaram esse registro.

Quilometragem = final menos inicial, somente de rotas encerradas. Dados ausentes não viram zero; há indicação das rotas sem medição. Despesa por entrega = despesas vinculadas às rotas encerradas divididas pelas entregas concluídas nessas mesmas rotas. Sem entregas concluídas, não existe base para a média.

Frete conhecido = total do pedido menos seus itens, considerando os descontos dos itens e limitado a zero. Pedido sem itens é identificado como frete desconhecido. O saldo de fretes considera somente entregas concluídas, desconta as despesas vinculadas à rota e não representa margem da venda dos pneus.

O valor de combustível anotado na rota não é somado novamente à despesa financeira. Uma mesma despesa ligada ao combustível e a vários comprovantes conta uma vez por rota. Se um vínculo legado compartilhar a mesma despesa entre rotas, os detalhes são sinalizados como parciais e o indicador geral deduplica a despesa; não se inventa rateio. Na aba Custos, o total das linhas representa os vínculos exibidos.

Documentos pendentes ou rejeitados não viram despesa lançada. Despesas removidas ficam fora dos valores; comprovantes que perderam o vínculo válido aparecem como pendência. Vínculos legados são identificados. Rotas abertas, conciliação pendente/divergente, documentos pendentes ou fretes ausentes deixam o resultado marcado como parcial.

## Integração e acesso

Relatórios fica disponível na Matriz para quem possui Vendas, Compras, Estoque ou Logística. Cada relatório exige a permissão correspondente. Este exige **Logística**, inclusive nas exportações; utiliza a mesma visibilidade de despesas e comprovantes já existente nesse módulo. Não retorna custo dos pneus, margem das vendas, telefone, endereço ou conteúdo de anexos na consulta geral.

APIs: `GET /admin/api/relatorios/logistica`, `/exportar` e `/imprimir`. Ambiente definido pelo servidor, joins por ambiente, transação `REPEATABLE READ READ ONLY`, limite de 15 segundos por consulta e respostas sem cache. Não grava em tabelas operacionais ou de auditoria.

Limites explícitos: 2.000 rotas e 20.000 registros de cada coleção relacionada, antes dos filtros em memória. Exceder retorna 422 em vez de truncamento. PDF até 1.000 linhas da aba; CSV cobre todo o conjunto consultado. Falha na consulta e ausência de registros têm apresentações diferentes. Nenhuma alteração nas regras do bot ou nas ações operacionais de Logística.

## Validação

- Build/TypeScript e `git diff --check` passaram.
- **1.819 testes unitários passaram**, incluindo 11 do relatório e acesso ao menu com somente Logística. Os 11 foram repetidos após o ajuste final de ordenação.
- **Quatro testes de integração passaram** em PostgreSQL 17 descartável com migrations reais: encerramento com falha e reentrega, aprovação humana de comprovante, deduplicação, vínculos legados, pendências, período antigo, fronteira de data em São Paulo, isolamento de ambiente e ausência de gravações pelo relatório. Nenhum dado de teste foi inserido em produção.
- `scripts/prova-relatorios-logistica-ui.cjs --full`: quatro abas, seleção e filtros, navegação semanal, concorrência, paginação, visão salva, comprovante e erro de imagem, CSV/PDF completos, erro/vazio, celular e usuário com somente Logística.
- As provas de navegador de Vendas, Compras e Estoque continuam passando no painel completo.
- PDFs e telas de computador/celular renderizados e conferidos visualmente. Evidências locais em `artifacts/relatorios-logistica/`.

As provas gerais mantêm somente as pendências anteriores já documentadas em Estoque: nove propriedades e nove rotas ausentes dos baselines, nove arquivos antigos acima dos limites e `row is not defined` em gráficos SVG antigos de Compras. Foram adicionadas ao baseline apenas as **30 propriedades e oito rotas** desta entrega, sem novas colisões ou divergências.
