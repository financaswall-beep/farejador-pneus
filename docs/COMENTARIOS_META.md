# Comentários automáticos — Facebook e Instagram

Em **Marketing → Comentários**, acompanhe o recebimento, as respostas e as exclusões.
Não há fila de aprovação: com publicação ativada, a IA responde comentários positivos/neutros
e apaga os negativos, conforme a política solicitada pelo dono. O texto analisado, motivo,
modelo e confirmação da plataforma ficam registrados. Dúvidas como “não sei a medida”
não devem ser confundidas com reclamações. A decisão é interpretativa e pode errar.

## Contas autorizadas

Escopo fixado no código e confirmado em consulta somente leitura ao Chatwoot em 23/09/2026:

| Rede | Conta autorizada | ID Meta | Caixa Chatwoot |
| --- | --- | --- | --- |
| Facebook | 2W Pneus | `386020731963435` | 34 — Facebook - 2W Pneus |
| Instagram | @2wp.pneus | `17841465774227389` | 40 — 2wp.pneus |

A caixa 34 também registra um Instagram diferente (`17841445872943671`), que **não está autorizado**.
Não copiar esse vínculo para o escopo nem importar automaticamente outras páginas do token.
Se as variáveis de ID indicarem outra conta, análise e publicação ficam bloqueadas.
Sem essas variáveis, são usados exclusivamente os dois IDs fixados acima.
Os eventos são filtrados por plataforma e ID e o dono do post é conferido antes de qualquer ação.
Antes de responder ou apagar, o token também precisa representar a página autorizada;
para Instagram, seu vínculo precisa corresponder exatamente a @2wp.pneus.
Essa restrição não ativa publicação nem altera caixas, tokens ou vínculos do Chatwoot.

Antes de ativar Instagram, validar na Meta o acesso ao ID da caixa 40. O vínculo diferente
da caixa 34 não comprova que o token Facebook consiga moderar @2wp.pneus. Se o acesso não
for confirmado, manter a publicação desativada; não substituir pelo Instagram de outra conta.

## Ativação

1. Aplicar `0242_meta_comments.sql` pelo aplicador oficial, validar manifesto e fazer deploy.
2. Configurar as variáveis abaixo no servidor. Nunca inserir tokens no frontend/repositório.
3. Usar o aplicativo Meta com **Facebook Login**, a página Facebook e o Instagram profissional
   vinculado a ela. O token de anúncios/CAPI não é automaticamente um token da página.
4. No aplicativo, assinar `feed` para a página e `comments` para Instagram, vinculando os ativos
   ao aplicativo. Usar o callback existente `/webhooks/meta/messaging` (agora também aceita
   comentários) ou seu alias `/webhooks/meta/comments`. Não substituir o callback do aplicativo
   do Chatwoot. Se forem aplicativos diferentes, configurar o aplicativo próprio do Farejador.
5. Verificar a conexão pelo painel e validar com comentários controlados em posts próprios.
6. Ligar `META_COMMENTS_PUBLISH_ENABLED=true`. O modo é automático, sem aprovação por comentário.

```dotenv
META_COMMENTS_ENABLED=true
META_COMMENTS_PUBLISH_ENABLED=false
META_COMMENTS_APP_ID=ID_DO_APLICATIVO
META_COMMENTS_PAGE_ID=386020731963435
META_COMMENTS_INSTAGRAM_ID=17841465774227389
META_COMMENTS_PAGE_ACCESS_TOKEN=TOKEN_DA_PAGINA
META_APP_SECRET=SEGREDO_DO_MESMO_APLICATIVO
META_MESSAGING_WEBHOOK_VERIFY_TOKEN=TOKEN_DE_VERIFICACAO_DO_CALLBACK
# Reutiliza OPENAI_API_KEY, OPENAI_MODEL e META_GRAPH_API_VERSION existentes.
```

Permissões a conferir para Facebook Login: Facebook `pages_read_engagement`,
`pages_read_user_content`, `pages_manage_engagement`; Instagram `instagram_basic`,
`instagram_manage_comments`, `pages_read_engagement`. A assinatura dos ativos também pode
exigir `pages_manage_metadata`. Acesso avançado/revisão depende dos ativos e do aplicativo.
O diagnóstico consulta a página, vínculo Instagram, validade/app do token e permissões;
não publica nem apaga nada e não comprova a assinatura do webhook.

## Funcionamento e limites

- HMAC da Meta validado no corpo bruto; captura durável antes do 200. Normalização e IA em segundo plano.
- Apenas IDs de contas configurados; comentários próprios não disparam respostas em ciclo.
- A IA só recebe o texto público e a legenda da publicação. Não recebe contatos, conversas privadas
  nem ferramentas para criar pedidos. Preço, estoque e entrega não são prometidos sem consulta:
  perguntas comerciais são encaminhadas ao atendimento privado, aproveitando a medida informada.
- A publicação pertence à conta configurada e o comentário é relido antes de responder/apagar.
- Eventos duplicados não duplicam ações; edição invalida a decisão pendente. Remoção cancela a fila.
- Resposta da página observada pelo webhook suspende a automação daquele comentário.
- Timeout/5xx depois de uma escrita fica **sem confirmação**, sem reenvio automático que poderia duplicar.
  A exclusão só é contabilizada após `success=true`. Conferir casos sem confirmação na plataforma.
- Começa com novos eventos recebidos; não varre nem apaga comentários históricos.
- Com flag desligada ou migration ausente, a funcionalidade não interfere nas outras telas.
- `FAREJADOR_ENV=test` nunca publica pelo worker. Testes automatizados usam transportes simulados.
- A pausa no painel interrompe novas análises/publicações; uma chamada já em andamento pode terminar.
- TikTok e Instagram Login direto (`graph.instagram.com`) não fazem parte desta entrega.
- As exclusões são definitivas na rede social; o histórico interno não restaura o comentário.

Referências: [Instagram da Meta](https://www.postman.com/meta/instagram/folder/9cgqucg/instagram-api-with-facebook-login),
[moderação Instagram](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login/comment-moderation/),
[comentários Facebook](https://developers.facebook.com/docs/graph-api/reference/comment/),
[saídas estruturadas OpenAI](https://developers.openai.com/api/docs/guides/structured-outputs).

## Publicação de 23/09/2026

- Migration `0242_meta_comments.sql` aplicada em produção pelo executor oficial, após ensaio com rollback.
- Histórico confirmado em `ops.applied_migrations`; versão da estrutura avançou de 241 para 242.
- Verificados: cinco tabelas com RLS, seis gatilhos e nenhum grant para público, anon, authenticated ou parceiros.
- Validação local: 43 testes unitários, 11 testes de integração em PostgreSQL local isolado e build aprovado.
- A aplicação da migration não ativa as respostas. Tokens, permissões, webhooks e flags de publicação continuam dependendo da configuração da Meta no servidor.
