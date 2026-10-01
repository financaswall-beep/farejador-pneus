# Google Ads — métricas, Financeiro e vendas

A integração usa a conta anunciante 9097818084 (2w pneus), projeto Cloud
flowise-486105 e conta de serviço com acesso Padrão. Google Ads API e Data Manager
API estão habilitadas. Ação criada: 7812245491, Farejador - Venda confirmada 2W,
tipo UPLOAD_CLICKS, categoria PURCHASE, principal e janela de sete dias.

## Variáveis do Coolify

| Variável | Valor desta instalação |
| --- | --- |
| GOOGLE_ADS_ENABLED | true |
| GOOGLE_ADS_CUSTOMER_ID | 9097818084 |
| GOOGLE_ADS_SCOPE | account |
| GOOGLE_ADS_API_VERSION | v25 |
| GOOGLE_ADS_FINANCE_SINCE | 2026-10-01 |
| GOOGLE_ADS_WHATSAPP_NUMBER | 5521972509411 |
| GOOGLE_ADS_CONVERSION_ACTION_ID | 7812245491 |
| GOOGLE_ADS_CONVERSIONS_ENABLED | true |
| GOOGLE_ADS_SERVICE_ACCOUNT_JSON | JSON completo da chave nas variáveis protegidas |

Deixar WEBSITE_URL vazio até o site estar pronto. LOGIN_CUSTOMER_ID é opcional
para acesso por MCC; no acesso direto fica vazio. CAMPAIGN_IDS é obrigatório
apenas com SCOPE=campaigns. Usar account somente para conta exclusiva da 2W.
Nomes/prefixos não autorizam escopo financeiro. O JSON substitui CLIENT_ID,
CLIENT_SECRET e REFRESH_TOKEN; OAuth continua disponível como alternativa de
leitura. Envios Data Manager nesta implementação exigem JSON. Não usar chave
Maps ou developer-token. Nunca guardar credenciais no Git, logs ou screenshots.

## Migration e Financeiro

Aplicar 0250_google_ads_pipeline.sql e 0251_google_ads_access.sql antes do deploy.
As tabelas Google usam RLS e recusam acesso público, autenticado e de parceiros.
O worker coleta trinta dias
a cada hora; todas as tabelas e vínculos filtram environment e conta. Somente
custos diários de campanhas autorizadas, a partir da data financeira explícita,
entram no mesmo livro central do Financeiro web/app. Exige o adaptador existente
MATRIZ_CENTRAL_LEDGER=true. Recoletas lançam apenas a diferença, inclusive
correções negativas. Custos dos anúncios não são somados novamente aos totais
das campanhas. Coleta incompleta falha antes da transação. Isso não registra
pagamento/saída de caixa. Campanhas antigas nesta conta não geram despesa da 2W
antes de 01/10/2026.

O painel exibe campanhas, anúncios, comparações e investimento, impressões,
cliques, CTR, CPC, CPM e conversões Google. Conversões da plataforma não são
apresentadas como vendas realizadas. Resultados Farejador usam as regras de
realização e custo existentes. Custo ausente não vira zero/lucro. Consolidado
soma mídia e vendas dos canais disponíveis; custo por conversa Meta considera
apenas investimento e conversas Meta. Performance Max pode não ter ad_group_ad:
os totais permanecem disponíveis na campanha, sem inventar peças individuais.

## Rastreio de WhatsApp e chat web

Para novos anúncios de pesquisa, usar URL final:

https://farejador.smarttecsolutions.com.br/marketing/google/contato?campaignid={campaignid}&adgroupid={adgroupid}&creative={creative}

Habilitar marcação automática no Google Ads. O Google acrescenta gclid ou outro
identificador. Sem consentimento, o atendimento abre normalmente sem medição.
Com consentimento explícito e IDs conhecidos, o servidor acrescenta referência
opaca à mensagem do WhatsApp. Se o cliente remover a referência, esse caminho
não atribui a venda. Notas privadas e mensagens da equipe não comprovam clique.

Quando o site estiver pronto, configurar GOOGLE_ADS_WEBSITE_URL e carregar
/admin/painel/assets/google-chatwoot.js após o SDK Chatwoot. Transmite somente
farejador_google_click_ref como atributo da conversa. O vínculo precisa chegar
antes da venda. Performance Max e formatos sem grupo/anúncio exigem rastreio
específico; não prometer atribuição individual quando esses IDs não existem.

Google e Meta compartilham lock e exclusão por pedido. A referência mais recente
elegível recebe a nova venda em janela de sete dias. Atribuições já realizadas
não são transferidas por referência tardia. Cancelados/entregas não concluídas
ficam fora. Correções preservam histórico via superseded_by.

## Envio de vendas e limites

Novos integradores usam Data Manager, não UploadClickConversions. O worker
valida o destino antes de retirar vendas da fila. Meta nova ainda indisponível
mantém pedidos pendentes sem consumir tentativas. Interface mostra validação
e fila. Envia valor real BRL, horário, clique, consentimento e transactionId
estável por pedido; não envia nomes, telefones, emails, IP ou mensagens.

requestId significa recebido; consulta SUCCESS do mesmo destino confirma
processamento. Não garante crédito no relatório Google: seus diagnósticos podem
apontar clique não elegível. Timeout/5xx após POST exige revisão, sem reenvio
automático. Cancelamento posterior ao envio confirmado requer ajuste/revisão
no Google; não há retração automática de conversão já enviada.

## Validação

1. Configurar variáveis, aplicar migration, fazer push e deploy.
2. Conteúdo pago → Google Ads → Recoletar; conferir conta, fuso e escopo.
3. Comparar dados com Google Ads no mesmo período. Falha da API não mostra soma parcial.
4. Rastreio e envios mostra data financeira, validação e fila. Falha do banco não vira lucro zero.
5. Configurar URL nos novos anúncios; comprovar clique real, mensagem com referência
   e venda realizada antes de afirmar que o fluxo completo passou em produção.

## Referências oficiais

- [Conta de serviço](https://developers.google.com/google-ads/api/docs/oauth/service-accounts)
- [Acesso Cloud](https://developers.google.com/google-ads/api/docs/api-policy/developer-token)
- [Conversões offline](https://developers.google.com/google-ads/api/docs/conversions/upload-offline)
- [Data Manager](https://developers.google.com/data-manager/api/devguides/quickstart/set-up-access)
- [Eventos](https://developers.google.com/data-manager/api/devguides/events/google-ads/offline/send-events)
- [Status](https://developers.google.com/data-manager/api/reference/rest/v1/requestStatus/retrieve)
