# Comentário → privado → atendimento → pedido

Implementação aditiva da migration `0243_organic_attribution_audio.sql`. Nenhum evento bruto, mensagem original, saldo de estoque ou lançamento financeiro é reescrito. As novas flags começam desligadas.

Migration aplicada em produção em 27/09/2026, com ensaio por rollback, commit pelo executor oficial e checksum registrado no ledger. As nove tabelas novas foram verificadas com RLS; políticas, triggers existentes e contagens operacionais permaneceram preservados. A ativação dos canais e o teste real na Meta continuam pendentes.

## Comportamento

- Só 2W Pneus no Facebook (`1434857906367394`) e @2wp.pneus no Instagram (`17841465774227389`). Não usa a página antiga.
- Comentário comercial novo: consulta produtos/preço/estoque da 2W e envia uma resposta privada contextual, terminando **“De onde você está falando, meu amigo?”**. Só anuncia o envio publicamente depois do aceite da Meta.
- Preço de uma oferta única vem do resultado da consulta, não do texto inventado pelo modelo. Preços citados em variantes precisam corresponder a uma opção disponível consultada. O atendimento recebe a oferta e precisa consultar disponibilidade e obter aceite de qualquer diferença de loja/preço/frete.
- Endereço/horário isolado, elogio, emoji e reclamação não iniciam abordagem comercial. A política pública de moderação existente permanece.
- Uma tentativa durável por comentário; resultado incerto não é reenviado. Não aborda novamente a mesma pessoa em 24 horas. Nesta primeira versão, uma conversa anterior identificada na Meta também impede nova abordagem automática.
- Quando a pessoa responde, usa identidade nativa da plataforma e/ou o mesmo ID de mensagem no Chatwoot. Nunca atribui por nome ou telefone. Se o evento da Meta chegar depois, consulta a identidade nativa da conversa no Chatwoot antes de continuar. Falha de identificação necessária adia o atendimento e aparece na fila de falhas se persistir.
- O mesmo atendente continua com o pneu, a oferta e a pergunta de localização. Mensagem privada automática não vira intervenção humana. Atendimento assumido por pessoa continua pausando o bot.
- Áudio é transcrito no worker, em `analytics`, com versão/confiança. Falha pede texto ou atendente. Transcrição incerta exige confirmação escrita antes de criar, editar ou cancelar pedido. Download HTTPS limitado a 16 MB e aos hosts autorizados, inclusive redirecionamentos.
- Sem estoque: permite registrar interesse para acompanhamento da equipe, somente com autorização explícita por texto e WhatsApp informado pelo próprio cliente. Não promete prazo nem envia aviso automático de reposição. Revogação e novo consentimento são preservados em registros separados.

## Indicadores

- A origem começa a ser registrada na primeira abordagem; mensagens anteriores à ativação não são retomadas.
- Resposta elegível até 7 dias da abordagem; pedido até 7 dias da primeira resposta vinculada. Duas origens possíveis sem referência explícita ficam sem atribuição. Pedido anterior à conversa não recebe origem nova.
- Uma venda é contada uma vez por relatório. Pedido aceito ainda aguardando retirada/entrega não é venda concluída; cancelamento sai dos totais e reembolso reduz o valor. Venda feita por humano também exige o vínculo real à mesma conversa.
- **Tempo até confirmar o pedido:** primeira resposta privada até a criação do pedido aceito; não espera entrega. O gráfico identifica pedidos, separadamente das vendas concluídas.
- Resumo, comparação, vendas e métricas usam dados registrados. Não reconstrói vendas antigas por suposição e não significa atribuição causal de publicidade paga.
- Insights da Meta são o acumulado consultado da publicação, separado da janela de 7/30 dias do funil; podem incluir impulsionamento. Alcance, visualizações, curtidas/reações, comentários, compartilhamentos, salvamentos, interações, reposts e tempos de vídeo aparecem conforme formato, permissão e disponibilidade da API. Métrica indisponível aparece como “—”, nunca zero inventado.

## Publicação e ativação

1. Aplicar **0243** pelo procedimento de migrations do projeto, incluindo o ledger/checksum. Publicar o código com novas flags desligadas é compatível com a versão anterior do banco; não ligar as flags antes da migration.
2. Manter os tokens/IDs atuais da página nova. Configurar inicialmente:

   ```ini
   ORGANIC_ATTRIBUTION_ENABLED=true
   ORGANIC_INSTAGRAM_PRIVATE_ENABLED=true
   ORGANIC_FACEBOOK_PRIVATE_ENABLED=false
   BOT_AUDIO_ENABLED=true
   OPENAI_MODEL=gpt-6-sol
   BOT_AUDIO_MODEL=gpt-transcribe
   BOT_AUDIO_ALLOWED_HOSTS=
   ```

   O host configurado do Chatwoot já é permitido para áudio. Se os anexos redirecionarem para storage/CDN, acrescentar apenas os hosts HTTPS exatos observados (separados por vírgula), sem curingas. A chave OpenAI existente é usada para transcrever. Uso de tokens é registrado; custo permanece desconhecido até haver precificação de áudio, sem usar tarifa de texto.

   Publicar primeiro o código que aceita `gpt-transcribe`: versões anteriores rejeitam esse valor na inicialização. O modelo de atendimento também atende comentários e leitura de comprovantes. Esta atualização de modelos não requer nova migration; a 0243 continua sendo necessária para o fluxo orgânico e áudio.

   GPT-6 Sol usa raciocínio médio na Responses API, mantendo os itens de raciocínio criptografados entre ferramentas somente em memória. A estimativa de custo reconhece GPT-6 Sol e GPT-5.6 Sol no serviço padrão. GPT-Transcribe recebe `languages[]=pt`, contexto genérico da loja e vocabulário sem medidas/valores sugeridos. Não enviamos `logprobs` nem `language` a ele.

   A API de GPT-Transcribe não fornece nota de certeza: o registro mantém `confidence_level=low` como dado não validado e `extractor_version=audio-v2`. No histórico, isso aparece como **certeza não informada**, permitindo conversar normalmente; mudanças de pedido ainda exigem resumo e confirmação escrita. Não inventamos uma porcentagem de confiança. O custo de áudio fica sem estimativa na tabela atual, que exige medição em tokens; não convertemos segundos em tokens fictícios.

3. Confirmar dependências já existentes: `META_COMMENTS_ENABLED`, `META_COMMENTS_PUBLISH_ENABLED`, `META_MESSAGING_WEBHOOK_ENABLED`, `BOT_OUTBOX` e `AGENT_V2_WORKER_ENABLED` ativos; `AGENT_V2_CONVERSATION_IDS=*`; conta/credenciais de produção do Chatwoot e OpenAI. Manter os secrets fora do Git. A verificação exige permissões de mensagens da Meta, além das de comentários.
4. Em **Marketing → Conteúdo orgânico → Atendimento → Mensagens privadas e interessados em reposição**, escolher a caixa correta. Enviar um Direct de teste. “Verificar recebimento” exige o mesmo ID nativo recebido pela Meta e pelo Chatwoot nos últimos 30 dias, na conta/inbox escolhida.
5. Ativar Instagram pelo botão. A ativação só permite comentários feitos a partir desse instante. Para o primeiro teste, usar um perfil de teste sem conversa anterior com a loja, pois a proteção de atendimento existente impede uma nova abordagem nesses casos.
6. Validar o ciclo abaixo. Só então liberar a flag do Facebook, fazer redeploy, comprovar recebimento no Messenger e ativá-lo separadamente no painel.

Desligar o canal no painel interrompe novas abordagens; conversas já iniciadas continuam no atendimento. Para suspender a nova integração por completo, desligar as três flags `ORGANIC_*` e `BOT_AUDIO_ENABLED` e publicar novamente. Não apagar as tabelas nem os registros de auditoria.

## Testes

Automatizados em testes unitários e PostgreSQL 17 descartável: preço consultado, fechamento solicitado, deduplicação, envio incerto, conversa existente, isolamento de ambientes, identidade nativa, continuidade de contexto, áudio/falha/confirmação, consentimento, pedido anterior, cancelamento, reembolso e tempos de confirmação separados da entrega.

Validação real após deploy (não substituída por mocks):

1. Comentar uma medida disponível → conferir consulta real, DM e resposta pública.
2. Responder “Sou de Jardim Primavera, Caxias” → bot retoma o produto e resolve localização; áudio também deve entrar no histórico.
3. Pedir foto e assumir como humano → bot para; retomar permite continuar.
4. Confirmar pedido → tempo de confirmação aparece, venda ainda não concluída. Concluir no fluxo operacional → venda/valor aparecem na publicação. Cancelar → sai dos totais, com histórico preservado.
5. Repetir comentário, testar item sem estoque com/sem autorização e conferir métricas indisponíveis.

Não criar conversões pagas fictícias, não publicar comentários de teste automaticamente e não prometer êxito na Meta antes dessa validação real.

## Correção do envio privado pelo Facebook Login — 27/09/2026

O cliente usa token de Página e `graph.facebook.com`. A resposta privada a comentário do Instagram deve usar `POST /<PAGE_ID>/messages` com `recipient.comment_id`, mantendo o ID do Instagram na validação de propriedade, nos registros de origem e na atribuição. O diagnóstico exige `pages_messaging` para esse envio e `instagram_manage_messages` para consultar conversas existentes.

No teste isolado autorizado com o mesmo token e comentário, `/17841465774227389/messages` retornou erro 3 (`Application does not have the capability to make this API call`). A chamada por `/1434857906367394/messages` foi aceita e retornou `message_id` e `recipient_id`. O reteste e seu resultado foram registrados em `audit.events`, e o registro original em `ops.organic_outreach` foi conciliado como enviado para impedir duplicação. Nenhum evento bruto ou mensagem foi fabricado. Essa evidência confirma o envio inicial com a configuração atual; a resposta do destinatário e a continuidade do atendimento ainda precisam de validação real.

Referência: https://developers.facebook.com/documentation/business-messaging/instagram-messaging/features/private-replies
