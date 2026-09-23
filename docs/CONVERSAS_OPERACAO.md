# Conversas no app da operação

Entrada: `/operacao#conversas`, na aba **Conversas**. A tela usa as conversas normalizadas do Chatwoot da conta e do ambiente configurados. Não cria outra caixa de mensagens nem outro bot.

- Fila com busca por cliente/medida, canais, pendências e encerradas. Pedidos de foto da Matriz aparecem com ação de câmera ou galeria; o alerta permanece até a confirmação de envio.
- Ícones de humano e bot no cabeçalho. Digitar, anexar ou gravar assume o atendimento. O envio grava a pausa e a mensagem na mesma transação; responder não depende do sucesso do clique anterior.
- Histórico começa nas 60 mensagens mais recentes e permite carregar anteriores. Reconexão usa autenticação atual; consultas periódicas cobrem interrupções do stream.
- Texto, imagem, áudio, MP4 e PDF. Áudio tem prévia e envio explícito, limite de dois minutos; anexos até 16 MB. A captura depende da permissão do aparelho/navegador. Imagens são reprocessadas, sem EXIF.
- Ficha do cliente com localização, interesses e compras, preservando rascunhos de texto enquanto alterna conversas. Rascunhos ficam só em memória e são apagados ao sair da sessão.
- Alertas de autorização para Instagram e Facebook: aparecem na fila, no atendimento da caixa afetada e na área Bot do painel web. O link abre a caixa existente no Chatwoot, onde o responsável renova o login. A consulta roda em segundo plano enquanto a tela está aberta, com cache compartilhado de 30 segundos e timeout de quatro segundos; não interfere no carregamento das mensagens.
- A ausência de pedido de reconexão não comprova entrega. Falha na consulta mostra estado indisponível e preserva o último aviso com indicação de que não foi confirmado novamente. Os alertas não reconectam contas nem reenviam mensagens automaticamente. Sem novas variáveis ou migrations para esses avisos.

## Publicação

Aplicar `0241_operation_conversations.sql` antes de liberar a funcionalidade. Nenhuma variável nova; requer `BOT_OUTBOX=true` e a integração Chatwoot existente. Sem migration, só as rotas deste chat retornam aviso de atualização pendente; os demais módulos continuam disponíveis.

O acesso segue vendas e a proteção de identidade já existente: com `MATRIZ_CUSTOMER_IDENTITY=true`, somente proprietário. Parceiros não recebem acesso à caixa inteira da Matriz.

`ops.operator_messages` guarda a chave idempotente, autoria e a mídia temporária. A fila existente envia e reconcilia o eco do provedor. Repetir uma requisição usa a mesma chave. Falha definitiva pode ser tentada novamente; resultado ambíguo não é reenviado automaticamente. “Aceito pelo Chatwoot” não significa “lido pelo cliente”.

O job diário remove a cópia temporária de mídia após sete dias e somente quando existe um anexo confirmado no histórico normalizado. Pendências e falhas não perdem o arquivo. A foto solicitada reutiliza a chave `photo:<id>` para impedir envio duplicado pelo dispatcher.

## Verificação

Testes em Postgres temporário com todas as migrations, provedor simulado e nenhum envio externo; testes de estado assíncrono, reconexão, áudio e regressão do controle/outbox. Revisão visual da interface com dados fictícios. Câmera, microfone físico e entrega real em cada canal precisam de um teste de ponta a ponta após publicação.
