# Relatórios — Faltas por loja

Implementação do segundo conceito aprovado, com lojas selecionáveis em cartões, medidas, consultas e detalhe das lojas verificadas pelo bot. Disponível na biblioteca central para usuários da Matriz com permissão do módulo Bot.

## Entrega

- Quatro abas: Visão geral, Por medida, Consultas e Potencial de venda.
- Semana, mês e período personalizado; busca de medidas; lista completa de lojas pesquisável.
- Seleção encadeada de loja, medida e consulta, mantendo a trilha completa das lojas consultadas.
- Estoque atual da medida, somado entre marcas e condições, descontadas as reservas. Controle incompleto ou inexistente aparece como “Não informado”.
- Receita potencial da loja, detalhe por medida e lista das conversas agrupadas que compõem a estimativa.
- Visão salva por usuário no navegador, CSV e PDF de todas as páginas da aba, estados de erro/vazio e adaptação ao celular.

## Significado do valor estimado

O histórico `ops.bot_stock_searches` registra disponibilidade, medida, filtros e lojas. Não registra preço nem quantidade desejada. Portanto, o relatório **não mede lucro perdido ou perda confirmada**.

A estimativa considera uma unidade por combinação de conversa e medida na loja, dentro do período. Usa o menor preço atual positivo em reais dos produtos que correspondem à medida e aos filtros registrados de marca, condição e posição. Uma posição não cadastrada não serve de referência quando a busca exige posição. A Matriz usa `commerce.matriz_current_prices`; os parceiros usam os preços `regular` vigentes de `commerce.product_prices`, como o fluxo comercial da Rede. Preços expirados, futuros, em outra moeda ou ausentes ficam fora.

Buscas repetidas da mesma conversa e medida não somam unidades. Se os filtros variaram dentro desse grupo, vale a menor referência elegível encontrada nas buscas agrupadas. É uma estimativa conservadora de uma unidade, inclusive se a pessoa consultou duas marcas. Conversas sem referência aparecem na contagem de exclusões, nunca como preço zero.

Não se verifica intenção de compra ou conversão posterior. A mesma procura pode gerar falta em várias lojas; os potenciais das lojas **não devem ser somados** como perda da rede. Por isso, o relatório não publica um total monetário global.

Consultas com falta contam buscas distintas. Faltas contam cada combinação de busca, medida e loja indisponível. O card de potencial remove repetições por conversa; sua base é diferente dos contadores de eventos. Uma consulta com falta pode ter encontrado disponibilidade em outra loja, identificada na trilha.

Na Visão geral e em Por medida, a linha selecionada controla o detalhe, enquanto CSV/PDF exportam a lista de medidas filtrada pela busca. Em Consultas e Potencial de venda, o seletor de medida restringe a lista e a exportação. O PDF calcula o potencial do recorte exportado.

## Dados e implantação

Somente leitura, em transação `REPEATABLE READ READ ONLY`, com ambiente definido no servidor, período no fuso de São Paulo, limite de 366 dias e timeout de 15 segundos por instrução. Limites explícitos: 20.000 registros de busca, 20.000 produtos e 50.000 linhas de estoque. Excesso retorna erro, sem publicar totais truncados. Não expõe identificadores de conversa, mensagens, telefones ou endereços completos.

Não altera o coletor de faltas nem as decisões, preços ou mensagens do bot. Não reescreve trilhas antigas e não cria lançamentos financeiros. O relatório anterior dentro do Bot permanece disponível. Registros antigos sem trilha por loja ficam sinalizados separadamente.

**Não exige migration nem variável nova.** Reutiliza as tabelas existentes. Inclui três rotas autenticadas em `/admin/api/relatorios/faltas`, quatro arquivos JavaScript e uma folha CSS, com atualização de cache dos arquivos compartilhados alterados.

## Validação

- Build e TypeScript aprovados; suíte unitária completa: 1.844 testes aprovados.
- Sete testes do relatório: deduplicação, separação de canais, filtros, ausência de preço, moeda, estoque desconhecido, CSV e proteção de rotas.
- Dois testes com PostgreSQL 17 temporário: schema real, reservas, preços vigentes/futuros, limites de datas, isolamento prod/test e preservação das buscas após mudança de preço.
- `scripts/prova-relatorios-faltas-ui.cjs --full`: quatro abas, busca e seleção de loja/medida/consulta, requisições concorrentes, paginação, visão salva, CSV/PDF completos, falta de preço, erro, vazio, celular e painel completo com permissão somente Bot. Sem escrita ou dados fictícios em produção.
- Regressões visuais de Vendas da Matriz e Desempenho dos parceiros aprovadas. PDFs renderizados e conferidos; evidências em `artifacts/relatorios-faltas/` (não versionadas).

As verificações gerais de paridade e tamanho mantêm as pendências anteriores: nove propriedades do Catálogo/Clientes fora do baseline, nove rotas de Faltas/Clientes/Catálogo fora do baseline e nove arquivos antigos acima do limite. Esta entrega acrescenta somente suas 31 propriedades e oito rotas aos baselines. O aviso legado `row is not defined` do gráfico de Compras permanece; a tela nova não acrescenta erros.
