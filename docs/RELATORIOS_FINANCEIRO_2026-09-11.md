# Relatórios — Resultado, caixa e títulos

Implementação de 10–11/09/2026. Disponível em **Matriz → Relatórios → Resultado, caixa e títulos**. Usa o livro financeiro central existente, sem novas migrations, variáveis ou bibliotecas. Não altera lançamentos nem regras operacionais do bot.

## Telas

- **Visão geral:** resultado conhecido e margem, gráfico de linhas do resultado acumulado, movimentação do caixa, maiores despesas/perdas e agenda atual de vencimentos. A agenda permite abrir os títulos e selecionar um lançamento.
- **Resultado:** receitas, custos, despesas/perdas, ganhos de estoque, composição por origem e detalhes dos lançamentos por competência.
- **Fluxo de caixa:** realizado com saldo anterior, entradas, saídas, saldo final, gráfico diário clicável e extrato; previsto pelos vencimentos dos próximos 7, 30 ou 90 dias.
- **Títulos:** posição atual de contas a receber e pagar, vencidos, próximos vencimentos, títulos sem data e detalhe do saldo pendente.

Semana, mês ou intervalo personalizado de até 366 dias. Origem restringe também os indicadores e o saldo anterior. Busca, direção, componente e dia selecionado filtram as listas; não mudam os indicadores do período/origem. Listas paginadas em 25 registros, com rolagem própria e detalhe ao lado; adaptação para celular.

Salvar visão guarda apenas filtros neste navegador, por usuário/operação, em chave própria. Restaurar e exportar consultam os dados novamente. CSV e PDF usam toda a coleção filtrada, independentemente da página visível. Abrir Vendas/Compras/Financeiro navega ao módulo operacional, respeitando as permissões.

## Regras dos números

Valores vêm das **entradas contábeis**, não do total do cabeçalho da transação. O resultado usa a data de competência; o caixa usa a data efetiva do pagamento. Estornos permanecem na data em que foram registrados e não apagam o movimento original de um mês anterior.

Resultado conhecido = receitas − receitas de itens do varejo com custo pendente reconhecidos no período − custo dos pneus − despesas − perdas/uso interno + ganhos de estoque. A linha acumula esse resultado desde o início do recorte. A margem divide o resultado pelas receitas; sem receitas não existe base para a margem. A lista mostra o efeito contábil registrado, enquanto os indicadores descontam a receita com custo pendente. Taxas e impostos entram quando lançados; não se inventam despesas ausentes.

Comparação com o painel financeiro anterior: a consulta mensal existente agrega pendências de custo de todos os períodos. Este relatório considera somente as reconhecidas no recorte. Por isso, custos pendentes fora do intervalo podem gerar diferença entre os dois resultados. A consulta mensal anterior não foi alterada nesta entrega.

Saldo final = saldo anterior + entradas − saídas. O saldo anterior considera todo o histórico registrado antes do recorte e respeita a origem. Representa o caixa registrado no sistema, não uma conciliação bancária. Movimento do caixa não é lucro.

A agenda e a aba Títulos sempre mostram **a posição atual**, mesmo ao consultar um resultado de outro mês. Reutilizam a consulta do Financeiro: saldos após baixas, parcelas de compras e agrupamentos já existentes. Comissões agrupadas e Marketing sem vencimento não recebem datas fictícias. A previsão considera apenas títulos abertos com vencimento entre hoje e o fim do horizonte; vencidos e sem data ficam destacados fora da projeção. Não reconstrói uma agenda histórica nem garante pagamentos futuros.

## Consulta e acesso

Exige a permissão **Financeiro**, inclusive CSV/PDF. Usuário que possui somente Financeiro também acessa a central de relatórios. As outras análises continuam exigindo suas permissões próprias.

APIs: `GET /admin/api/relatorios/financeiro`, `/exportar` e `/imprimir`. Ambiente definido no servidor, consultas com escopo de ambiente, transação `REPEATABLE READ READ ONLY`, limite de 15 segundos por comando e respostas sem cache. Sem gravações operacionais ou de auditoria pelo relatório. Nomes, referências e campos de pagamento necessários ao detalhe são retornados; não retorna telefones, endereços, anexos ou metadata integral.

Usa as configurações já existentes `MATRIZ_CENTRAL_LEDGER` e `MATRIZ_CENTRAL_LEDGER_READ`, e a mesma verificação de integração do Financeiro. Leitura desativada ou integração vermelha retorna 409; pendências amarelas ou custo pendente deixam o resultado marcado como parcial. Erro de consulta não aparece como valor zerado.

Limites explícitos: 20.000 transações do período e 10.000 títulos antes dos filtros em memória; exceder retorna 422, sem truncamento silencioso. PDF até 1.000 linhas da aba; CSV inclui a coleção completa consultada. Fórmulas em campos textuais do CSV são neutralizadas.

## Validação

- Build e TypeScript passaram; `git diff --check` sem erros.
- Suíte geral: 1.827 de 1.828 testes passaram na execução com quatro processos. O teste restante de PDF de Compras excedeu o tempo e passou isoladamente; também foi repetida a suíte cujo processo demorou para encerrar (seis testes passaram nessa repetição). A primeira rodada com concorrência irrestrita teve diversos timeouts.
- Nove testes unitários financeiros: cálculos, filtros, custo pendente, projeção, permissões, erros, exportação e proteção de dados. Reexecutados após o ajuste final de despesas/perdas e CSV.
- Quatro testes de integração com PostgreSQL 17 descartável e migrations reais: competência/caixa, pagamento parcial, despesas, ganho/perda de estoque, saldo anterior, verdade mensal, ambientes isolados, ausência de gravações e estorno em outro mês sem reescrever o histórico.
- `scripts/prova-relatorios-financeiro-ui.cjs --full`: quatro abas, linha, seleção, filtros, paginação, concorrência, visão salva, CSV/PDF completos, previsão, erro/vazio, celular e acesso com somente Financeiro. Nenhum dado fictício inserido em produção.
- Provas de navegador de Vendas, Compras, Estoque e Logística passaram. Telas e PDFs renderizados para conferência visual; evidências em `artifacts/relatorios-financeiro/`.

As checagens gerais mantêm as pendências anteriores documentadas em `RELATORIOS_LOGISTICA_2026-09-10.md`: nove propriedades e nove rotas antigas ausentes dos baselines, nove arquivos antigos acima dos limites e `row is not defined` em gráficos SVG antigos de Compras. Somente as **38 propriedades e nove rotas** desta implementação foram incorporadas aos baselines; nenhuma nova colisão ou violação de tamanho.
