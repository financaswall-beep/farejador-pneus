# Scripts operacionais

Esta pasta contém ferramentas rastreadas e revisadas. Um arquivo local que
apareça aqui como não rastreado ainda não é uma ferramenta oficial.

## Regras de segurança

- nunca presuma `prod` quando `FAREJADOR_ENV` estiver ausente;
- leitura e dry-run devem ser o padrão;
- gravação exige `COMMIT=1` ou `--commit`;
- gravação em produção exige uma autorização específica para a operação;
- migrations devem vir diretamente de `db/migrations/` e passar pelo manifesto;
- scripts de teste devem recusar qualquer ambiente diferente de `test`.

## Migration individual

Dry-run:

```bash
FAREJADOR_ENV=prod node --env-file=.env scripts/apply-migration-file.cjs db/migrations/NNNN_nome.sql
```

Commit em produção:

```bash
FAREJADOR_ENV=prod ALLOW_PROD_MIGRATION=NNNN_nome.sql node --env-file=.env scripts/apply-migration-file.cjs db/migrations/NNNN_nome.sql --commit
```

## Token do parceiro

Listar é somente leitura. Gerar ou revogar exige `COMMIT=1`; em produção também
exige `ALLOW_PROD_PARTNER_TOKEN=<slug>`.

## Senha do parceiro

O reset é dry-run por padrão. Para gravar em produção, exige `COMMIT=1` e
`ALLOW_PROD_PARTNER_PASSWORD_RESET=<slug>:<usuario>`. A nova senha pode ser
informada por `PARTNER_NEW_PASSWORD` para não aparecer na linha de comando.

## Smoke 0094

`smoke-0094.cjs` recusa execução sem `FAREJADOR_ENV=test` e executa toda a prova
dentro de uma transação revertida ao final.

## Auditorias somente leitura

As auditorias rastreadas exigem `FAREJADOR_ENV=prod|test`, `DATABASE_URL` e abrem
uma transação `READ ONLY` quando consultam dados. Nenhuma delas presume produção.

- `auditar-logistica-prod-readonly.cjs`: consistência ponta a ponta da logística;
- `checar-cobertura-rede.cjs`: unidades, cobertura e resolução de bairros;
- `checar-raio-prod.cjs`: gate específico dos raios ativos em produção;
- `descrever-analytics.cjs`: estrutura atual do schema `analytics`.

`testar-geocode.cjs` chama Google Geocoding e Distance Matrix e pode consumir
cota. Além do ambiente explícito, exige
`ALLOW_EXTERNAL_GEOCODE_PROBE=google-maps`.
