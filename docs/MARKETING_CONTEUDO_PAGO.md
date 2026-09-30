# Conteúdo pago — implantação

A aba reúne o resumo, campanhas, comparação de anúncios e saúde da fila CAPI.
Jornadas, detalhes de campanha, anúncios e integrações continuam disponíveis.
Google Ads e TikTok aparecem desabilitados nesta primeira tela.

## Ordem de implantação

1. Aplicar `0249_meta_ad_identity_scope.sql` antes de publicar o código.
2. Publicar a aplicação. Não é necessária uma variável nova.
3. Em Marketing → Integrações, executar a coleta Meta e conferir seu resultado.
4. Conferir o aviso de identificação automática no Conteúdo pago e a conciliação no Financeiro.

O token de anúncios existente precisa conseguir ler anúncios, seus criativos e insights
da conta configurada. A coleta não altera campanhas nem orçamentos na Meta.
Não houve teste desta coleta nova com um token de produção durante a implementação.

## Escopo e valores

São aceitos os IDs atuais de Facebook/Instagram em `src/shared/meta-business-accounts.ts`.
Nome de campanha, prefixo “2W” e perfis antigos não autorizam um anúncio.
Identidade ausente ou conflitante fica pendente e fora da soma automática.
A classificação manual anterior continua preservada, mas deixa de controlar a
conta depois de uma coleta completa de identidades. A interface informa esse estado.

A leitura de cada campanha própria soma seus anúncios próprios por dia; alcance
nunca é somado, porque a mesma pessoa pode ter visto vários anúncios. Campanhas
externas antigas permanecem disponíveis no filtro de histórico. Novas métricas
são solicitadas à Meta somente para os anúncios autorizados.

O Financeiro usa a mesma leitura. Uma mudança de propriedade pode gerar correções
no histórico já contabilizado, por lançamentos de diferença, sem apagar lançamentos.
Falha ou paginação incompleta da API não substitui o snapshot vigente.

O motor de atribuição, a janela de conversão e a deduplicação de Purchase continuam
existindo. A nova verificação de anúncio vale na entrada da fila e antes do envio;
uma trava compartilhada impede a troca de identidade durante o envio.
Os contadores CAPI exibidos são acumulados da fila, não apenas do período do gráfico.
