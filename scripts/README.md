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

### Transferências entre lotes e estoque identificado

A migration `0281_tire_stock_transfers.sql` deve ser aplicada antes de liberar as novas ações. O banco precisa estar na mesma revisão do código. As rotas novas retornam `transfer_migration_required` antes da atualização; consultas e formação antiga de lotes continuam funcionando. A migration tem timeout de lock de 5 segundos e é transacional: em conflito, reaplicar fora do pico, sem contornar os bloqueios.

No painel web: Estoque → Lotes → Desmembrar lote / Formar lote / Registrar perda. Primeiro conferir saldos e custos; só a confirmação escreve. Histórico de transferências permite consultar o lote, as variantes, a compra e a viagem vinculada; o estorno exige que lote e variantes não tenham alterações posteriores nem reservas. Perdas têm lançamento financeiro próprio; transferência interna não cria compra, caixa, receita ou despesa. Gastos da viagem não são incorporados novamente ao estoque. Variantes com histórico de transferência não podem ser apagadas fisicamente; correções de saldo, marca e condição preservam a origem. Saldos e movimentos antigos não recebem origens inventadas.

Validação local: `npx vitest run tests/unit/admin/tire-stock-transfers.test.ts tests/unit/admin/tire-transfer-routes.test.ts`; integração: `npx vitest run --config vitest.integration.config.ts tests/integration/tire-stock-transfers.integration.test.ts tests/integration/tire-transfer-compatibility.integration.test.ts`. A prova de interface `node scripts/prova-transferencias-estoque-ui.cjs` usa dados fictícios locais e Playwright (variável `PLAYWRIGHT_MODULE` quando fora do node_modules), com Edge instalado; screenshots em `.codex-tmp/transfer-proof`. Não usa credenciais nem consultas de produção.

### Clientes na Nova venda da Matriz

No painel web, Vendas → Nova venda permite buscar cliente de balcão ou contato do Chatwoot por nome/telefone, selecionar por fonte + UUID, cadastrar novo ou vender sem identificação. A seleção não altera o cadastro. Telefone já cadastrado em balcão/Chatwoot impede criação explícita duplicada; nomes iguais não são unidos. Cadastros do parceiro e do atacado seguem seus fluxos próprios. A ficha de balcão/Chatwoot oferece Nova venda para este cliente. O último endereço só é reutilizado após ação do operador. Não há migration nem alteração em massa de cadastros antigos.

Telefone e CEP têm máscaras, nomes têm espaços extras removidos, e endereço pode ser preenchido em campos separados ou como texto livre. O CEP não consulta serviço externo. Os campos separados são validados e compostos pelo servidor na mesma coluna de endereço já usada nas entregas. Venda sem identificação mantém um registro comercial sem nome/telefone porque o contrato de orders exige uma parte. A busca é exclusiva do proprietário e não permite cache dos dados pessoais.

Provas: `npx vitest run tests/unit/admin/sale-customer-fields.test.ts tests/unit/admin/sale-customer-routes.test.ts`; `npx vitest run --config vitest.integration.config.ts tests/integration/sale-customers.integration.test.ts`; `node scripts/prova-clientes-venda-ui.cjs` (Playwright/Edge, dados fictícios locais, variável PLAYWRIGHT_MODULE se necessário). Screenshots em .codex-tmp/sale-customer-proof.
