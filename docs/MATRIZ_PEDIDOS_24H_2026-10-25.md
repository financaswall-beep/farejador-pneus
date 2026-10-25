# Pedidos da Matriz fora do expediente

Decisão do proprietário em 25/10/2026: aceitar pedidos 24 horas, com retirada ou entrega após a abertura da Matriz. Horários e filtros dos parceiros permanecem.

## Comportamento

- A Matriz pode cotar, reservar estoque e criar pedido enquanto fechada, desde que haja uma próxima abertura cadastrada. Horário desconhecido continua bloqueando.
- Preço vigente, estoque, dados obrigatórios, cobertura, formas de pagamento e modos habilitados continuam validados no código. Fechamento não significa pagamento recebido.
- `fulfillment_not_before` guarda a abertura física calculada na criação, em UTC; o atendimento informa o horário de São Paulo. Abertura não é promessa de entrega naquele minuto.
- Entregas mantêm a janela e o prazo configurados. Fora do expediente, o agendamento não fica antes da abertura nem antes do próximo dia de entrega permitido.
- O prazo de expiração da retirada começa no maior valor entre criação e abertura guardada. Retries mantêm o pedido, o horário e a mesma reserva.
- O banco bloqueia chegada, instalação, retirada e despacho antecipados. Cancelamento continua liberado e devolve a reserva normalmente. A tela de retiradas mostra a abertura e explica o bloqueio.
- Na escolha automática, uma Matriz fechada não toma o lugar de um parceiro aberto com estoque. A Matriz pode atender depois da abertura quando não há um parceiro aberto apto. Fotos atuais da equipe continuam sujeitas ao expediente; fotos de referência cadastradas funcionam 24h.

## Publicação

O prompt principal, blocos opcionais, nudge de foto e orientação da galeria foram revisados para respostas curtas de balcão. Foto individual vai sem legenda técnica; a resposta textual pode ser apenas “Olha a foto aí, amigo.” Não há recitação de fila, catálogo, ressalvas ou preço não solicitado. Valores continuam conferidos e apresentados para aceitar o total antes de fechar. A confirmação do pedido ficou compacta, preservando número, abertura real e mapa. Alterações de tom não removem dados do histórico nem as travas de compra.

Aplicar `0278_matriz_bot_orders_24h.sql` antes do deploy. A migration é aditiva, mantém os horários existentes e os pedidos antigos com janela nula. Não há nova variável. O processo novo exige a coluna no readiness.

## Teste iniciado em produção

Conversa fictícia Chatwoot **847**, caixa API de testes 41, sem ponte externa. Foto nova entregue na mensagem **23921**, com 2W legível. Sete chamadas do 6.1 até o bloqueio de horário antigo: estimativa **US$ 0,0801605**, 17.375 tokens de prefixo gravados uma vez, 104.250 tokens de cache lidos. Não é uma comparação controlada de economia.

O pedido não foi criado pelo código antigo. Após deploy, continuar a mesma conversa, confirmar a compra e verificar reserva, horário, resposta e cancelamento de limpeza. Não registrar pagamento, retirada ou entrega real de teste.

O evento automático `farejador.conversa.atualizada` entrou na fila com silêncio até 7h de Brasília. Enfileirado não significa recebido/analisado pela Milly. O teste manual de envio imediato não foi executado: a chave local estava protegida por permissão de arquivo; nenhuma configuração de silêncio ou assinatura foi alterada.
