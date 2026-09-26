# Meta Ads da 2W Pneus: anúncio → conversa → venda

## Contas autorizadas

- Página Facebook **2W Pneus**: `1434857906367394` (a página antiga `386020731963435` não é usada para novos referrals).
- Instagram **@2wp.pneus**: `17841465774227389`.
- App Meta: `1474949829779264`.
- A conta de anúncios continua sendo configurada por `META_ADS_ACCOUNT_ID`; ligar uma página nova não troca automaticamente a conta de anúncios nem o dataset CAPI.

## O que a integração mede

O webhook da Meta precisa entregar o ID do anúncio e da mensagem. O Farejador casa essa mensagem com a conversa do Chatwoot; uma venda realizada vinculada à mesma conversa recebe a atribuição do último anúncio elegível em até sete dias. O painel de Marketing lê a campanha desse anúncio e mostra vendas, receita e margem quando o custo dos pneus é conhecido.

O retorno à Meta é um evento `Purchase` pela CAPI **somente para venda realizada**. Conversa sem venda ou pedido cancelado antes do envio não gera `Purchase`. A Meta não recebe um evento fictício de “não comprou”. Se o cancelamento acontecer depois de um `Purchase` já aceito pela Meta, esse envio anterior não pode ser desfeito pelo Farejador; o painel interno revoga a atribuição.

## Configuração em produção

1. No app Meta, manter `Page: messages`, `messaging_referrals`, `messaging_postbacks` e `feed`, e `Instagram: messages` e `comments` apontando para `/webhooks/meta/messaging`. Inscrever **a página nova** no app; configurar o webhook no app sem inscrever a página não entrega eventos da página.
2. No Coolify, atualizar `META_COMMENTS_PAGE_ID=1434857906367394`, `META_COMMENTS_INSTAGRAM_ID=17841465774227389` e o token **da página nova** em `META_COMMENTS_PAGE_ACCESS_TOKEN`. O token de anúncios e o token de CAPI são separados.
3. Para referrals diretos, configurar `META_MESSAGING_WEBHOOK_ENABLED=true`, `META_APP_SECRET` e `META_MESSAGING_WEBHOOK_VERIFY_TOKEN`. Confirmar o primeiro referral em Marketing > Integrações antes de atribuir vendas.
4. Conferir `META_ADS_ACCOUNT_ID` e `META_ADS_ACCESS_TOKEN`. Classificar as campanhas da 2W como Matriz e as demais como Externas. Só então ligar `MARKETING_SCOPE_ENFORCEMENT_ENABLED=true` e validar o financeiro.
5. Para retorno de vendas, configurar `META_CAPI_DATASET_ID`, `META_CAPI_ACCESS_TOKEN` e `META_CAPI_PAGE_ID=1434857906367394`. Validar uma compra elegível no **Test Events** com `META_CAPI_TEST_EVENT_CODE`. Depois de conferir o resultado, retirar o código de teste e habilitar `MARKETING_ATTRIBUTION=true`, `MARKETING_CAPI_ENABLED=true`, `MARKETING_CAPI_MESSENGER_ENABLED=true` e `MARKETING_CAPI_INSTAGRAM_ENABLED=true`. Manter o WhatsApp conforme sua configuração própria.

Nenhum token deve entrar no Git ou em uma URL compartilhada. Uma campanha de mensagens real é necessária para provar a cadeia completa; vender sem referral continua como venda normal, porém sem atribuição à campanha.
