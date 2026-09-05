# Bot: migração para Responses API

Correção do erro 400 de `gpt-5.6-sol` ao combinar ferramentas e reasoning em
`/v1/chat/completions`. O Agent V2 passa a usar `/v1/responses`, com reasoning
`medium` na família GPT-5. O modelo configurado em `OPENAI_MODEL` é preservado.
Sem alteração de prompt, schema de banco, ferramentas comerciais ou fluxo Chatwoot.

## Configuração e publicação

- Não há migration nova. A migration 0216 de pausa humana continua sendo pré-requisito já existente.
- Manter `OPENAI_MODEL=gpt-5.6-sol` e a chave somente nos segredos do Coolify.
- Nenhuma variável nova é obrigatória. `AGENT_V2_MAX_OUTPUT_TOKENS` tem default
  `8192`: teto de reasoning + saída por chamada, substituindo o limite antigo de
  1000 tokens. Não é tamanho desejado da mensagem. Pode aumentar consumo máximo;
  acompanhar tokens e latência no canário antes de ajustar.
- `OPENAI_TIMEOUT_MS=30000` permanece. Se houver timeout real, investigar latência
  e avaliar outro limite; não confundir timeout com o erro 400 corrigido aqui.
- As flags de worker, outbox e escopo de conversas não são ativadas por esta mudança.
- Publicar o commit aprovado pelo fluxo habitual do Coolify e conferir readiness/SHA.
  Esta nota não significa que push ou deploy já ocorreram.
- O Compose de exemplo do repositório não enumera todas as variáveis atuais do bot.
  Se for usado, conferir o repasse das variáveis ao container; não substituir a
  configuração de produção pelo exemplo.

## Verificação após deploy

1. Enviar uma mensagem NOVA em uma conversa autorizada e em modo automático.
   Começar por saudação e consulta de estoque, sem efetuar compra de teste em produção.
2. Conferir geração, fila, aceite e eco de entrega separadamente. A API da OpenAI
   responder não prova que o WhatsApp entregou a mensagem.
3. Conferir o histórico das ferramentas, ausência do erro 400 e tempo de resposta.
4. Uma resposta humana no Chatwoot deve pausar apenas aquela conversa,
   sem enviar aviso de pausa ao cliente. A outra conversa autorizada segue normalmente.
5. Falhas antigas em `permanent_failure` não são reprocessadas por esta alteração.
   Revisar individualmente antes de qualquer replay: pode haver atendimento humano
   ou uma mensagem mais recente. Não liberar a fila antiga em massa.

## Contrato e privacidade

`store: false`; histórico manual e outputs completos mantidos apenas em memória
entre ferramentas do mesmo job, incluindo reasoning criptografado e `phase`.
O banco mantém o formato anterior de `agent.turns.actions`, sem reasoning.
Isso não equivale a prometer ausência de toda retenção no provedor; políticas
de logs de segurança/cache são independentes. Cache implícito permanece ativo,
sem o parâmetro legado `prompt_cache_retention`.

Respostas incompletas, vazias, recusadas ou malformadas não são enviadas ao cliente.
O lote de chamadas é validado antes de executar ferramentas. A fila registra falha
para revisão; não repete automaticamente esses erros de validação.
O transporte mantém no máximo um retry por timeout/5xx, sem executar ferramentas
durante a repetição HTTP. Erros HTTP não registram o corpo da requisição/resposta.

Os testes automatizados interceptam a OpenAI com fixtures; a integração usa um
PostgreSQL descartável em Docker e não inicia workers de envio. Eles não validam
chave, acesso ao modelo, latência real ou entrega no WhatsApp em produção.

Referências oficiais: [migração para Responses](https://developers.openai.com/api/docs/guides/migrate-to-responses),
[guia GPT-5.6](https://developers.openai.com/api/docs/guides/upgrading-to-gpt-5p6-sol).
