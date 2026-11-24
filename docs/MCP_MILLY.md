# Milly no Farejador

A Milly usa o MCP da Matriz para consultar o sistema e operar financeiro, fornecedores, compras, estoque, catálogo, publicações e vencimentos conforme as permissões do proprietário. O Farejador registra pagamentos e recebimentos informados pelo dono. A transferência de dinheiro acontece no banco.

## Ativar e desativar

1. Após o deploy, entre na Matriz com o usuário proprietário e abra [Permissões da Milly](https://farejador.smarttecsolutions.com.br/admin/dot/connections).
2. Na conexão ativa, selecione **Confirmar operações por voz ou texto**. Essa escolha vale para todas as operações que exigem confirmação, inclusive quando iniciadas pelo acompanhamento automático. Ative as permissões desejadas de financeiro, vencimentos, publicador, estoque, catálogo e cancelamentos de retiradas. Cada conexão do celular ou computador tem sua própria configuração.
3. Atualize as ferramentas do conector no cliente da Milly. Um teste de leitura é dizer “Mostre as minhas contas a receber e o saldo de cada parcela”. Para conferir a permissão de escrita, peça à Milly para registrar uma operação real que você já queira lançar.
4. Para retirar o acesso de escrita, use **Desativar lançamentos financeiros**. A alteração de vencimento tem controle próprio. **Desconectar Dot** revoga a conexão inteira. O histórico dos lançamentos continua disponível no Financeiro.

A ferramenta aparece no catálogo mesmo quando a conexão está em modo de consulta. O servidor verifica a permissão específica da conexão a cada gravação. A autorização da operação vem do pedido do dono. Se o pedido identifica a operação, o valor, a conta ou parcela e a data, a Milly pode executá-lo na conversa. Se houver duas cobranças compatíveis, ela pergunta qual delas é a certa.

## Pedidos por voz e efeito financeiro

Os valores e nomes a seguir são exemplos fictícios.

| O que dizer | Ferramentas e resultado |
|---|---|
| “Paguei R$ 180 de diesel por Pix hoje na conta da empresa. Foi na viagem de compra. Estou sem comprovante.” | `consultar_viagens_de_compra` identifica a viagem. `lancar_despesa_matriz` lança a despesa paga e a saída de caixa. Para “vou pagar sexta”, registra uma despesa pendente com vencimento. |
| “Achei a foto daquele diesel de R$ 180. Anexa lá.” | A Milly localiza a despesa pelo valor e pela data. `anexar_comprovante_despesa` confere esses dados e vincula um comprovante existente ou uma imagem JPEG, PNG ou WebP de até 1 MiB ao lançamento. A situação do pagamento continua a mesma. No cliente compatível, envie a foto na conversa junto com o pedido. |
| “Vendi dois pneus daquele lote por R$ 1.200. Entraram R$ 300 no Pix e combinei duas parcelas de R$ 450.” | `consultar_lotes_para_venda` identifica lote, saldo físico e custo. `registrar_venda_lote` registra uma venda com estoque, entrada e cronograma de vencimentos. Para itens por medida, marca e condição, use `registrar_venda_atacado`. Na venda a parceiro, valem as regras de aceite da Matriz. Confira comprador, quantidade, datas e se a venda já existe. |
| “Fiz uma montagem de R$ 120 para a Oficina Azul. Eles vão pagar dia 15.” | `criar_cobranca_servico` reconhece o serviço na competência e abre uma conta a receber identificada pelo cliente. O caixa só recebe o valor quando a baixa é registrada. |
| “Recebi R$ 300 no Pix da parcela de R$ 965. Entrou na conta da empresa.” | `consultar_titulos_financeiros` localiza o saldo. `registrar_baixa_financeira` informa os R$ 300 recebidos e o saldo de R$ 665 da parcela. Para um pagamento a fornecedor, a Milly aplica o valor à parcela da compra identificada pelo dono. Despesas operacionais e de folha lançadas pelo painel têm baixa integral. Comissões, mensalidades da Rede e marketing têm fluxos próprios no painel. |
| “O fornecedor devolveu R$ 150 daquele crédito” ou “devolvi R$ 80 ao cliente.” | Localize o título de devolução e use `registrar_baixa_financeira` com o lado correto, o valor, a conta, o meio e a data. A origem do crédito é a devolução já registrada no sistema. |
| “Essa baixa entrou na parcela errada. Desfaz e registra na parcela certa.” | `consultar_extrato_matriz` localiza o pagamento. `estornar_baixa_financeira` registra a correção pelo UUID da transação, valor, data e motivo. Com a parcela correta identificada, o campo `destino` reaplica o valor na mesma transação. Se o destino falhar, as duas etapas são desfeitas. Se você pedir só o estorno, a parcela de origem fica reaberta. |
| “Renegociei os R$ 900 que restam. Agora são três parcelas de R$ 300.” | `renegociar_parcelas_venda` recebe a obrigação, o saldo esperado e as novas datas, a partir de hoje. Preserva a entrada, os recebimentos anteriores e o histórico do acordo parcelado. Para apenas mudar uma data, use o fluxo de vencimento abaixo. |
| “Coloquei R$ 2.000 meus na empresa” ou “recebi R$ 200 de aluguel hoje.” | `registrar_entrada_avulsa` separa aporte de receita recebida. `estornar_entrada_avulsa` corrige uma dessas entradas pelo UUID, motivo e data. |
| “Agenda R$ 4.500 de aluguel todo dia 5 pelos próximos três meses.” | `agendar_despesas_mensais` cria três títulos a pagar. Cada um tem valor, vencimento e competência do próprio mês. O caixa só muda com a baixa. O dia 31 é ajustado ao último dia nos meses mais curtos. |
| “Vincula aquele pedágio à viagem e me diz quanto saiu cada pneu.” | `vincular_gasto_a_viagem` vincula ou desvincula a despesa identificada. `consultar_viagens_de_compra` mostra as compras, gastos e média da viagem conforme o painel, incluindo o frete incorporado à compra uma vez. A média é provisória enquanto houver compras em trânsito. Se houver também despesa de frete e o painel indicar possível duplicidade, confira o lançamento antes de usar o custo. |
| “Compara esse extrato da conta da empresa com o Farejador.” | `conferir_extrato_bancario` compara as linhas fornecidas pelo dono por conta, dia, direção e valor. Duplicidades e contas não identificadas ficam para revisão. A comparação é de leitura. |
| “Se eu comprar 100 pneus por R$ 2.000, pagar R$ 500 de frete e aproveitar 80, quanto sai cada pneu?” | `simular_compra_de_lote` calcula R$ 25 por coletado e R$ 31,25 por aproveitável nesse exemplo. Informe gastos extras, desembolso até a data e horizonte para estimar o caixa. O preço de venda opcional estima o resultado caso venda todos os aproveitáveis. |

### Publicar e agendar na 2W

Em **Permissões da Milly**, habilite **Permitir preparar, publicar e agendar posts** na conexão usada para marketing. Atualize o catálogo do conector após o deploy. A permissão é independente do financeiro. O publicador usa a biblioteca, as contas Meta e as configurações de envio da Central de Publicações.

- **Preparar**. Envie uma foto ou um vídeo como anexo ou escolha mídias prontas em `consultar_publicador`. A Milly chama `importar_midia_publicacao` para cada anexo, escreve a legenda e salva o rascunho com `preparar_publicacao`. Carrosséis usam até dez fotos no feed. Para vídeo, escolha Reel ou Story.
- **Legenda de pneus**. Informe medida e condição. Em carrosséis com produtos diferentes, indique o pneu de cada foto. A legenda dos feeds e Reels leva a referência para o bot de comentários. “Quero o da foto 2” identifica a medida correspondente. Se houver dúvida o atendente pede a foto ou medida. Preço e estoque passam pela consulta comercial do bot.
- **Publicar ou agendar**. Peça “publique este Reel no Instagram agora” ou “agende o carrossel para sexta, às 18h de Brasília”. A ferramenta `publicar_ou_agendar_post` exige o UUID, a versão do rascunho e o horário com fuso ou `null` para agora. Um evento de acompanhamento pode gerar uma sugestão. A publicação requer um pedido do dono.
- **Alterar e acompanhar**. `reagendar_publicacao` e `cancelar_publicacao` atuam antes de o envio começar. `consultar_publicador` traz o estado e o link de cada destino quando disponível. Em caso de falha em uma das redes, consulte o mesmo post antes de decidir como prosseguir.

### Fornecedores e compras

A permissão **Permitir lançamentos financeiros por voz ou texto** também habilita a gestão de fornecedores e o registro de compras.

| Pedido do dono | Ação da Milly |
|---|---|
| “Cadastre a Borracharia do João” | Consulte os fornecedores por nome em `consultar_financeiro_fornecedores`. Use `cadastrar_fornecedor` para criar a ficha. |
| “Mude o telefone do João” | Identifique a ficha ativa e use `editar_fornecedor` com o UUID e os campos solicitados. Para apagar um campo opcional, envie `null`. |
| “Exclua esse fornecedor” | `arquivar_fornecedor` retira a ficha dos cadastros ativos. Compras, saldos e créditos continuam consultáveis. |
| “Comprei quatro pneus do João por R$ 80 cada” | Use `registrar_compra_fornecedor` com os itens, medida, marca, condição e custo unitário. Informe data, situação do pagamento e se os pneus chegaram. |
| “Comprei um lote fechado de 30 pneus por R$ 1.200” | Use `registrar_compra_lote_fornecedor` com quantidade e preço total. Informe o vencimento se for a prazo e a data de recebimento se já chegou. |

Consulte as compras existentes e reutilize o UUID do pedido em tentativas repetidas. Compra recebida dá entrada no galpão. Compra a prazo gera contas a pagar. Para abater dinheiro já adiantado, registre a compra a prazo e use `usar_adiantamento_fornecedor` na parcela autorizada.

### Alterar um vencimento

`consultar_parcelas_para_revisao` localiza o comprador, a venda e a parcela em aberto. `preparar_alteracao_vencimento` confere a data atual e devolve a proposta. Quando `confirmacao=conversa`, a autorização explícita do dono permite usar `confirmar_alteracao_vencimento` imediatamente. Quando `confirmacao=painel`, a proposta traz o link do painel. `consultar_proposta_vencimento` informa a situação. A página de detalhes permite restaurar a data de uma proposta confirmada conforme o estado atual da parcela.

### Parâmetros que mudam o resultado

- **Venda.** A entrada em `payment_plan.received` e as parcelas de `payment_plan.installments` devem somar o valor líquido. Informe a conta da entrada em `payment_plan.cash_account` quando identificada pelo dono. O padrão do painel é Caixa principal. Para conferir uma venda existente, consulte `consultar_atacado_matriz` na visão vendas e leia `sale_plan`. Se a gravação encontrar os mesmos comprador, dia, lotes, quantidades e valor, retorna a venda e o acordo para conferência. Use `vendas_distintas_de` apenas se o dono identificar uma segunda venda real.
- **Baixa.** Use `obligation_id` retornado na agenda. Para venda parcelada, informe também `sale_installment.order_id` e `number`. Para compra parcelada informe `parcela_compra`. A resposta contém `remaining_balance` da obrigação e, quando aplicável, `installment_remaining_balance` da parcela.
- **Correção.** Identifique no extrato a baixa original, o valor e a parcela. Use o ID da transação de caixa em `pagamento_id`. Se o dono indicar uma parcela de destino, `destino` estorna e reaplica o valor na mesma operação. Para a entrada inicial de venda parcelada, pergunte em que dia o valor reaberto vence e informe `vencimento_entrada_estornada`. O valor vai para uma parcela própria. O movimento original, o estorno e a eventual nova baixa permanecem no histórico. Pagamentos antigos de fornecedor sem número de parcela conservam a apropriação cronológica.
- **Comprovante.** Localize a despesa por valor e data. Na presença de duas compatíveis, identifique qual o dono quis dizer. Envie `expense_id`, `valor_esperado`, `data_esperada` (dia de `occurred_at` em São Paulo) e exatamente um de `arquivo`, `receipt_id` ou `imagem_base64`. Anexar mantém a situação de pagamento. Se o link da foto expirar, reenvie o arquivo. [Referência oficial de parâmetros de arquivo](https://developers.openai.com/plugins/reference#define-file-inputs)
- **Conferência bancária.** Informe `de`, `ate`, `conta` e até 200 movimentos com `dia`, `direcao` (entrada/saida), `valor` e referência opcional. Período máximo de 31 dias de diferença entre as datas. Divida o período se o caixa tiver mais de 500 linhas.
- **Simulação.** Informe o valor de compra excluindo frete. O custo inclui compra, frete e gastos extras. O caixa projetado parte do registrado e considera entradas e saídas abertas com vencimento desde hoje até o horizonte informado. O cálculo depende da quantidade aproveitável estimada e dos pagamentos realmente ocorrerem.

## Compras compartilhadas

Em `consultar_compras_matriz`, a visão `compras` identifica as compras com `shared_purchase`. Para conferi-las, use `visao: "divisao"` e informe o UUID da compra em `referencia`. A consulta distingue o custo integral do lote, a parte da loja no custo (`store_cost`), o pagamento da loja ao fornecedor (`supplier_cash`), os recebimentos das vendas vinculadas ao lote e os reembolsos. A contribuição restante representa o acordo de custo com o participante. A compra pode ainda ter parcelas abertas com o fornecedor.

Ao responder quanto a loja gastou em uma compra compartilhada, informe o custo integral, a parte da loja e o valor efetivamente pago no período. Para movimentos e saldos por mês, use `consultar_extrato_matriz` na base de caixa. Para custo por pneu, use o custo integral e a quantidade do lote. O proprietário registra ou corrige a divisão em **Compras → Histórico → Dividir compra**, no painel ou no aplicativo.

## Consultas disponíveis no MCP

### Confirmação por conversa em todas as áreas

Com `operation_confirmation=conversa`, consultas, rascunhos e pendências internas conservam sua autonomia. Financeiro, compras, fornecedores, estoque, catálogo, publicações e cancelamentos de retiradas devolvem uma proposta antes de executar. Vencimentos mantêm o fluxo específico existente, seguindo o mesmo canal escolhido.

1. A Milly apresenta a operação, registro, valores, quantidades e demais dados relevantes.
2. O dono responde diretamente na conversa, por exemplo “autorizo”. Se houver mais de uma proposta, a Milly identifica qual foi autorizada.
3. `confirmar_operacao_milly` recebe o ID e o fingerprint da proposta. Depois a Milly repete a operação original com os mesmos dados e a mesma chave de idempotência.
4. A conclusão só é informada após retorno da ferramenta. `consultar_proposta_milly` distingue pendente, autorizada, executada, recusada e expirada. `recusar_operacao_milly` registra a recusa.

A proposta vale por 15 minutos. Mudança nos dados exige nova proposta e nova decisão. Repetir a mesma chamada não duplica a execução. Recusar, expirar, revogar a permissão ou trocar o canal bloqueia a aprovação anterior. Revisões permanecem registradas para não recriar automaticamente pedidos recusados/expirados. Eventos, comentários, clientes, anexos e respostas das ferramentas nunca são autorização do dono.

O servidor recebe a declaração de autorização do cliente autenticado. Não escuta nem reconhece a voz e não oferece biometria ou prova independente de quem falou. As instruções ao modelo não substituem esse limite de confiança. A configuração altera a aprovação do Farejador; não elimina confirmações próprias do ChatGPT. [Permissões de aplicativos no ChatGPT](https://help.openai.com/en/articles/20001495-managing-app-permissions-in-chatgpt).

### Cancelamento de retirada da Matriz

Em **Permissões da Milly**, habilite **Permitir cancelamentos de retiradas com confirmação** na conexão desejada. A ferramenta `consultar_retirada_para_cancelar` recebe o número interno ou UUID de uma retirada aberta com reserva na Matriz. `cancelar_retirada_matriz` usa a revisão da ficha consultada e o motivo informado. A Milly apresenta cliente, pedido, itens e valor antes da confirmação específica. Depois de autorizada, a operação usa o cancelamento da Matriz e libera a reserva em uma única transação. Uma mudança no pedido exige nova consulta e aprovação. Em uma conexão sem modo de confirmação definido, o cancelamento exige confirmação pela Matriz.

### Retiradas concluídas e compras recebidas por voz

`consultar_permissoes_milly` informa as permissões efetivas e o modo de confirmação da conexão atual. Para as duas operações abaixo, o dono habilita a permissão específica em uma conexão configurada para confirmação pela conversa.

- `consultar_retirada_para_concluir` localiza a retirada da Matriz. `concluir_retirada_matriz` conclui a retirada e baixa o estoque reservado de acordo com as regras do painel.
- `consultar_compra_para_receber` localiza a compra já registrada. `confirmar_recebimento_compra` registra a chegada dos itens na compra original e atualiza o estoque.

A Milly lê a ficha, apresenta a proposta e espera o dono autorizá-la por voz na mesma conversa. `confirmar_operacao_milly` recebe `canal_autorizacao=voz` para essas propostas. O Farejador usa a declaração do cliente autenticado. A revisão dos dados e a chave de idempotência protegem a execução. As duas permissões começam desligadas na migration `0301_milly_pickup_purchase_voice.sql`.

### Estoque e catálogo

| Área | Operações |
|---|---|
| Saldo físico | Entrada, definição de saldo/custo/mínimo, baixa por perda/quebra/uso interno, contagem física e remoção de variante |
| Organização | Correção de marca, transferência de condição, separação de lote, simulação/confirmação/estorno de transferências |
| Produto | Cadastro manual ou a partir do estoque, ficha técnica, preço de varejo e de atacado |
| Aplicações | Busca de veículos, compatibilidade, remoção de aplicação e registro/revisão de descobertas |
| Mídias | Consulta, foto, vídeo, foto principal, exibição e configuração de pasta já autorizada do Drive |

As operações reutilizam os serviços e schemas do painel, dentro da mesma transação da autorização/idempotência. Reservas, custos, histórico e regras de transferência continuam sendo verificados. Consulte a variante e use medida, marca e condição devolvidas pelo estoque. Fotos e vídeos usam o processamento existente e dependem das funcionalidades e credenciais de mídia habilitadas.

Novas leituras específicas incluem `consultar_conferencia_estoque`, `consultar_custos_estoque`, `consultar_origens_separacao`, `consultar_produtos_transferencia`, `consultar_transferencias_estoque`, `consultar_ficha_catalogo`, `buscar_veiculos_catalogo`, `consultar_aplicacoes_medida` e `consultar_midias_catalogo`.

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

Para implantar esta versão, aplique as migrations anteriores e `0293_dot_conversation_operations.sql` antes de publicar backend e painel do mesmo commit. Atualize a lista de ferramentas no cliente. Conexões existentes conservam `legacy`; estoque e catálogo começam desabilitados. Ative o modo conversa e as permissões desejadas nas conexões do proprietário após a implantação. A migração não concede acesso sozinha. O financeiro depende do ledger central e de sua leitura habilitados. Despesas e atacado respeitam as funcionalidades habilitadas da instalação.

Os detalhes das consultas, escopos, filtros e configuração dos eventos estão nos guias técnicos. [Consultas da Matriz](DOT_CONSULTAS_MATRIZ.md) · [Eventos e acompanhamento](DOT_EVENTOS_MILLY.md)

### Pilhas, conjuntos e pesquisa de preço

Para conferir ou mudar pneus de pilha por voz ou texto, a Milly consulta `consultar_pilhas_galpao` por medida e marca e recupera os grupos pelo `stock_id`. Na ficha do catálogo, **Modelo / desenho** corresponde a `tread_pattern`. Na conferência física, `conferir_grupo_galpao` registra em `model` o Modelo / desenho identificado pela equipe. A pilha informa onde estão as unidades. Marcar `matched_set` indica que a equipe conferiu essas unidades juntas como par ou conjunto. A ação `mover_pneus_entre_pilhas` usa o grupo, a revisão atual, a origem, o destino e a quantidade livre. As duas operações seguem a permissão e o modo de confirmação de Estoque da conexão.

As ferramentas `consultar_referencia_online` e `salvar_referencia_online` trabalham com a pesquisa unitária de um pneu novo. A gravação usa a permissão de Catálogo. O operador registra o valor, o **Modelo / desenho pesquisado**, a data e as fontes e decide se o atendimento pode citar a comparação até a data informada.

Quando uma venda avulsa puder desfazer conjuntos diferentes conforme a peça retirada, ela fica com a origem física a conferir. A Milly localiza a venda pelo número em `consultar_origens_pendentes` e registra a resposta do dono em `confirmar_origem_retirada`, com a permissão de Estoque. Se a pilha tiver um avulso e um par, a Milly pergunta qual deles foi usado. A confirmação acerta as posições e preserva o saldo já contabilizado. Enquanto houver dúvida, o atendimento pausa as ofertas dos conjuntos envolvidos.

Na implantação, aplique as migrations `0302_matriz_stock_groups.sql`, `0303_catalog_market_references.sql` e `0304_matriz_stock_origins.sql`, nessa ordem, antes de iniciar a nova versão. Para habilitar a oferta de conjuntos de carro, o atendimento precisa de `MATRIZ_CAR_GROUP_OFFERS`, `WHOLESALE_UNIFIED_STOCK` e `WHOLESALE_MATRIZ_DECREMENT`. O uso da pesquisa online em objeções de preço é controlado por `MATRIZ_MARKET_REFERENCE_OBJECTIONS`. As duas opções do atendimento começam desligadas.
