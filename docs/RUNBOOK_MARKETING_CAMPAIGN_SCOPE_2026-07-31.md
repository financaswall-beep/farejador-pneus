# Runbook — escopo financeiro de campanhas Meta

## Pré-requisito obrigatório

- Revogar e gerar novamente os tokens Meta que apareceram nos handoffs.
- Cadastrar os novos tokens somente no gerenciador de segredos do ambiente.
- Manter `MARKETING_SYNC_ENABLED=false`, `MARKETING_SCOPE_ENFORCEMENT_ENABLED=false`
  e `MARKETING_CAPI_ENABLED=false` durante a primeira publicação.

## Publicação A — schema e classificação

1. Publicar a imagem com a migration `0159_marketing_campaign_scope.sql`.
2. Confirmar que a migration consta como aplicada e que o healthcheck está verde.
3. Abrir Marketing > Campanhas como owner.
4. Classificar todas as campanhas com gasto como `Matriz` ou `Externa`, informando o motivo.
5. Conferir `GET /admin/api/integrity/matriz-ledger/stage4`.

Campanha nova sempre nasce `pending`. Enquanto estiver pendente, fica visível no Marketing,
mas não entra no Financeiro nem pode gerar novo envio CAPI quando o enforcement estiver ativo.

## Publicação B — corte financeiro

1. Ativar `MARKETING_SCOPE_ENFORCEMENT_ENABLED=true` e republicar.
2. Executar, como owner, `POST /admin/api/integrity/matriz-ledger/stage4/backfill`
   com `{ "limit": 5000 }`.
3. Repetir o backfill se ainda houver divergências e validar novamente o Stage 4.
4. Só depois do Stage 4 estável, ativar `MARKETING_SYNC_ENABLED=true`.
5. Validar totais do Marketing, Financeiro por competência e auditoria de classificação.

## CAPI

1. Manter `MARKETING_CAPI_ENABLED=false` até todas as campanhas relevantes estarem classificadas.
2. Validar primeiro com `META_CAPI_TEST_EVENT_CODE` no Test Events da Meta.
3. Confirmar que eventos de campanhas `pending` ou `external` aparecem como `suppressed` e
   nunca como `sent`.
4. Remover o código de teste e ativar CAPI produtivo somente após a validação.

## Reversão segura

- Desativar imediatamente `MARKETING_SYNC_ENABLED` e `MARKETING_CAPI_ENABLED`.
- Se necessário, desativar `MARKETING_SCOPE_ENFORCEMENT_ENABLED` para restaurar a leitura
  financeira anterior durante a investigação.
- Não remover a migration e não apagar lançamentos. Corrigir a classificação pelo endpoint/UI;
  a reconciliação cria lançamentos compensatórios e preserva o histórico.
