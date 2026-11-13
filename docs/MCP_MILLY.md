# Milly no Farejador

A Milly usa o MCP da Matriz para consultar o sistema e registrar operações financeiras que o proprietário pede por voz ou texto. O Farejador registra pagamentos e recebimentos informados pelo dono. A transferência de dinheiro acontece no banco.

## Ativar e desativar

1. Após o deploy, entre na Matriz com o usuário proprietário e abra [Permissões da Milly](https://farejador.smarttecsolutions.com.br/admin/dot/connections).
2. Na conexão ativa, selecione **Permitir lançamentos financeiros por voz ou texto**. Para editar uma data pelo fluxo de proposta, selecione também **Permitir confirmação por voz ou texto**.
3. Atualize as ferramentas do conector no cliente da Milly. Um teste de leitura é dizer “Mostre as minhas contas a receber e o saldo de cada parcela”. Para conferir a permissão de escrita, peça à Milly para registrar uma operação real que você já queira lançar.
4. Para retirar o acesso de escrita, use **Desativar lançamentos financeiros**. A alteração de vencimento tem controle próprio. **Desconectar Dot** revoga a conexão inteira. O histórico dos lançamentos continua disponível no Financeiro.

A ferramenta aparece no catálogo mesmo quando a conexão está em modo de consulta. O servidor verifica a permissão específica da conexão a cada gravação. A autorização da operação vem do pedido do dono. Se o pedido identifica a operação, o valor, a conta ou parcela e a data, a Milly pode executá-lo na conversa. Se houver duas cobranças compatíveis, ela pergunta qual delas é a certa.

## Pedidos por voz e efeito financeiro

Os valores e nomes a seguir são exemplos fictícios.

| O que dizer | Ferramentas e resultado |
|---|---|
| “Paguei R$ 180 de diesel por Pix hoje na conta da empresa. Foi na viagem de compra. Estou sem comprovante.” | `consultar_viagens_de_compra` identifica a viagem. `lancar_despesa_matriz` lança a despesa paga e a saída de caixa. Para “vou pagar sexta”, registra uma despesa pendente com vencimento. |
| “Achei a foto daquele diesel de R$ 180. Anexa lá.” | `anexar_comprovante_despesa` confere o UUID da despesa e o valor e vincula um comprovante existente ou imagem JPEG, PNG ou WebP de até 1 MiB. A situação do pagamento continua a mesma. No cliente compatível, envie a foto na conversa junto com o pedido. |
| “Vendi dois pneus daquele lote por R$ 1.200. Entraram R$ 300 no Pix e combinei duas parcelas de R$ 450.” | `consultar_lotes_para_venda` identifica lote, saldo físico e custo. `registrar_venda_lote` registra uma venda com estoque, entrada e cronograma de vencimentos. Para itens por medida, marca e condição, use `registrar_venda_atacado`. Na venda a parceiro, valem as regras de aceite da Matriz. Confira comprador, quantidade, datas e se a venda já existe. |
| “Fiz uma montagem de R$ 120 para a Oficina Azul. Eles vão pagar dia 15.” | `criar_cobranca_servico` reconhece o serviço na competência e abre uma conta a receber identificada pelo cliente. O caixa só recebe o valor quando a baixa é registrada. |
| “Recebi R$ 300 no Pix da parcela de R$ 965. Entrou na conta da empresa.” | `consultar_titulos_financeiros` localiza o saldo. `registrar_baixa_financeira` informa os R$ 300 recebidos e o saldo de R$ 665 da parcela. Em compras parceladas a apropriação segue a parcela aberta mais antiga. Despesas operacionais e de folha lançadas pelo painel têm baixa integral. Comissões, mensalidades da Rede e marketing têm fluxos próprios no painel. |
| “O fornecedor devolveu R$ 150 daquele crédito” ou “devolvi R$ 80 ao cliente.” | Localize o título de devolução e use `registrar_baixa_financeira` com o lado correto, o valor, a conta, o meio e a data. A origem do crédito é a devolução já registrada no sistema. |
| “Essa baixa entrou na parcela errada. Desfaz e registra na parcela certa.” | `consultar_extrato_matriz` localiza o pagamento. `estornar_baixa_financeira` registra a correção pelo UUID da transação, valor, data e motivo. Com a parcela correta identificada, o campo `destino` reaplica o valor na mesma transação. Se o destino falhar, as duas etapas são desfeitas. Se você pedir só o estorno, a parcela de origem fica reaberta. |
| “Renegociei os R$ 900 que restam. Agora são três parcelas de R$ 300.” | `renegociar_parcelas_venda` recebe a obrigação, o saldo esperado e as novas datas, a partir de hoje. Preserva a entrada, os recebimentos anteriores e o histórico do acordo parcelado. Para apenas mudar uma data, use o fluxo de vencimento abaixo. |
| “Coloquei R$ 2.000 meus na empresa” ou “recebi R$ 200 de aluguel hoje.” | `registrar_entrada_avulsa` separa aporte de receita recebida. `estornar_entrada_avulsa` corrige uma dessas entradas pelo UUID, motivo e data. |
| “Agenda R$ 4.500 de aluguel todo dia 5 pelos próximos três meses.” | `agendar_despesas_mensais` cria três títulos a pagar. Cada um tem valor, vencimento e competência do próprio mês. O caixa só muda com a baixa. O dia 31 é ajustado ao último dia nos meses mais curtos. |
| “Vincula aquele pedágio à viagem e me diz quanto saiu cada pneu.” | `vincular_gasto_a_viagem` vincula ou desvincula a despesa identificada. `consultar_viagens_de_compra` mostra as compras, gastos e média da viagem conforme o painel, incluindo o frete incorporado à compra uma vez. A média é provisória enquanto houver compras em trânsito. Se houver também despesa de frete e o painel indicar possível duplicidade, confira o lançamento antes de usar o custo. |
| “Compara esse extrato da conta da empresa com o Farejador.” | `conferir_extrato_bancario` compara as linhas fornecidas pelo dono por conta, dia, direção e valor. Duplicidades e contas não identificadas ficam para revisão. A comparação é de leitura. |
| “Se eu comprar 100 pneus por R$ 2.000, pagar R$ 500 de frete e aproveitar 80, quanto sai cada pneu?” | `simular_compra_de_lote` calcula R$ 25 por coletado e R$ 31,25 por aproveitável nesse exemplo. Informe gastos extras, desembolso até a data e horizonte para estimar o caixa. O preço de venda opcional estima o resultado caso venda todos os aproveitáveis. |

### Alterar um vencimento

`consultar_parcelas_para_revisao` localiza o comprador, a venda e a parcela em aberto. `preparar_alteracao_vencimento` confere a data atual e devolve a proposta. Quando `confirmacao=conversa`, a autorização explícita do dono permite usar `confirmar_alteracao_vencimento` imediatamente. Quando `confirmacao=painel`, a proposta traz o link do painel. `consultar_proposta_vencimento` informa a situação. A página de detalhes permite restaurar a data de uma proposta confirmada conforme o estado atual da parcela.

### Parâmetros que mudam o resultado

- **Venda.** `payment_plan.received` é o valor já recebido. `payment_plan.installments` contém datas ISO e valores em reais. A entrada somada às parcelas precisa fechar o total líquido da venda. Uma consulta ou simulação de preço não autoriza dar saída no estoque.
- **Baixa.** Use `obligation_id` retornado na agenda. Para venda parcelada, informe também `sale_installment.order_id` e `number`. Para compra parcelada informe `parcela_compra`. A resposta contém `remaining_balance` da obrigação e, quando aplicável, `installment_remaining_balance` da parcela.
- **Correção.** `pagamento_id` corresponde à transação financeira em `payment_ids` ou ao ID no extrato do caixa. A baixa central deve ser identificada individualmente. Entrada recebida na criação da venda, baixa de folha e cancelamento da venda têm regras próprias.
- **Comprovante.** Informe `expense_id`, `valor_esperado` e exatamente um de `arquivo` (anexo da conversa), `receipt_id` ou `imagem_base64`. O MCP declara o parâmetro de arquivo para clientes compatíveis com ChatGPT. Se o link expirar, reenvie o arquivo. [Referência oficial de parâmetros de arquivo](https://developers.openai.com/plugins/reference#define-file-inputs)
- **Conferência bancária.** Informe `de`, `ate`, `conta` e até 200 movimentos com `dia`, `direcao` (entrada/saida), `valor` e referência opcional. Período máximo de 31 dias de diferença entre as datas. Divida o período se o caixa tiver mais de 500 linhas.
- **Simulação.** Informe o valor de compra excluindo frete. O custo inclui compra, frete e gastos extras. O caixa projetado parte do registrado e considera entradas e saídas abertas com vencimento desde hoje até o horizonte informado. O cálculo depende da quantidade aproveitável estimada e dos pagamentos realmente ocorrerem.

## Consultas disponíveis no MCP

| Área | Ferramentas |
|---|---|
| Visão da Matriz e relatórios | `consultar_resumo_matriz`, `consultar_vendas_matriz`, `consultar_relatorios_matriz`, `consultar_relatorio_painel` |
| Vendas e clientes | `consultar_varejo_matriz`, `consultar_atacado_matriz`, `consultar_clientes_matriz` |
| Estoque, compras e viagens | `consultar_estoque_matriz`, `consultar_reposicao_matriz`, `consultar_movimentos_estoque_matriz`, `consultar_lotes_matriz`, `consultar_catalogo_matriz`, `consultar_compras_matriz`, `consultar_lotes_para_venda`, `consultar_viagens_de_compra` |
| Caixa, despesas e agenda | `consultar_financeiro_matriz`, `consultar_extrato_matriz`, `consultar_despesas_matriz`, `consultar_titulos_financeiros`, `conferir_extrato_bancario`, `simular_compra_de_lote` |
| Logística | `consultar_entregas_matriz`, `consultar_rotas_matriz`, `consultar_retiradas_matriz` |
| Rede, equipe e atendimento | `consultar_rede_matriz`, `consultar_candidaturas_matriz`, `consultar_equipe_matriz`, `consultar_bot_matriz` |
| Marketing e operação | `consultar_marketing_matriz`, `consultar_criativo_matriz`, `consultar_notificacoes_matriz`, `consultar_saude_matriz` |
| Registros e documentos | `listar_fontes_matriz` informa áreas, campos e filtros. `consultar_registros_matriz` busca registros paginados, inclusive detalhes pessoais autorizados. `consultar_anexo_matriz` lê um arquivo cadastrado pelo ID e tipo. |
| Monitoramento opcional | `consultar_acompanhamento_matriz` mostra assinaturas e estado do acompanhamento quando habilitado. Os eventos cobrem conversas, entregas, procura e disponibilidade de estoque, inconsistências no atendimento, financeiro, marketing e saúde do sistema. |

Algumas consultas resumidas de vendas usam centavos. Os comandos financeiros deste manual usam reais com até duas casas decimais. Respeite a unidade indicada na resposta. Para relatório financeiro, use a competência solicitada e o estado de conciliação retornado.

## Integração e operação

O endpoint é `/admin/dot/mcp`. O cliente usa OAuth com PKCE, um callback registrado e token da conexão do proprietário. O escopo de compatibilidade é `farejador.read`. As permissões adicionais ficam na concessão daquela conexão. Tokens expiram e podem ser revogados. Um agente compatível com esse OAuth precisa de configuração de cliente/callback e autorização do proprietário.

O catálogo vivo está em `tools/list`. Cada ferramenta informa descrição, campos obrigatórios, tipos e limites. Chame-a com `tools/call`. Para toda escrita financeira nova, gere um UUID em `idempotency_key` por pedido e conserve-o em todas as tentativas do mesmo pedido. Se os parâmetros mudarem, identifique a nova intenção. O agente só deve anunciar sucesso quando a resposta confirmar a gravação. Em caso de conexão interrompida, consulte o lançamento ou repita com a mesma chave.

Para implantar esta versão, aplique a migration `0286_dot_finance_operations.sql`, publique o backend e os arquivos do painel do mesmo commit e atualize a lista de ferramentas no cliente. O financeiro depende do ledger central e de sua leitura habilitados. Despesas e atacado respeitam as funcionalidades habilitadas da instalação.

Os detalhes das consultas, escopos, filtros e configuração dos eventos estão nos guias técnicos. [Consultas da Matriz](DOT_CONSULTAS_MATRIZ.md) · [Eventos e acompanhamento](DOT_EVENTOS_MILLY.md)
