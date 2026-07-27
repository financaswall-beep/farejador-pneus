# Limpeza seletiva dos dados de teste — 2026-07-27

## Escopo confirmado

Limpeza executada no banco de produção após confirmação explícita do dono.

Foram apagados:

- financeiro central e financeiro dos parceiros;
- despesas, comissões, folha e lançamentos do ledger;
- conversas normalizadas, mensagens, analytics e estado do atendente;
- clientes e identidades de clientes;
- pedidos, compras e movimentações históricas do estoque do atacado;
- viagens e comprovantes de logística;
- dados transacionais de Marketing;
- colaboradores da Matriz, exceto contas `owner` ativas;
- chaves de idempotência das operações de teste.

Foram preservados:

- `raw.raw_events` e `raw.delivery_seen`;
- parceiros, unidades, acessos, permissões e sessões dos parceiros;
- pneus, produtos, preços e saldos de estoque;
- fornecedores, categorias, políticas, geografia e catálogo de veículos;
- contas `owner` ativas e suas sessões;
- eventos de auditoria;
- tabelas, funções, triggers, views e materialized views;
- Chatwoot, que não foi alterado.

## Backup anterior à limpeza

- Arquivo: `C:\Users\Casa1\AppData\Local\Farejador\backups\farejador-prod-precleanup-20260727-161047.dump`
- Tamanho: 3.443.226 bytes
- SHA-256: `FF6ACEE2BC44053C598C4DB8C89247393D897DF8C2EEC3437882FB7B0C6E40C8`
- Verificação: `pg_restore --list` concluído com sucesso
- Itens restauráveis no TOC: 2.115

## Resultado da transação

- Linhas transacionais removidas: 1.330
- Colaboradores removidos: 4
- Identidades sem vínculo com parceiros removidas: 4
- Sessões de colaboradores não proprietários removidas: 4
- Reservas de estoque liberadas: 0, pois já estavam zeradas
- Transação: `COMMIT`

O primeiro dry-run identificou uma condição SQL incorreta para `panel_role IS NULL`
e fez rollback integral. A condição foi corrigida e um novo dry-run passou antes
do commit.

## Validação pós-limpeza

Camadas transacionais zeradas:

- `analytics.*`: 0 linhas
- `ops.*`: 0 linhas
- `agent.*`: 0 linhas
- `finance.*`: 0 linhas
- `marketing.*`: 0 linhas
- `core.*`: somente as 51 unidades preservadas

Cadastros e estoque preservados:

- parceiros: 49
- unidades de parceiros: 49
- cobertura de unidades: 49
- produtos: 71
- preços: 71
- pneus: 70
- estoque da Matriz: 70 linhas
- estoque dos parceiros: 61 linhas
- estoque do atacado: 3 linhas
- fornecedores do atacado: 2

Controles preservados:

- conta `owner` pronta para login em produção: 1
- contas `owner` prontas no total: 2, sendo uma `prod` e uma `test`
- `raw.raw_events`: 171 linhas
- `raw.delivery_seen`: 171 linhas
- `audit.events`: 323 linhas

Estrutura preservada:

- tabelas: 110
- funções: 99
- triggers: 226
- views: 24
- materialized views: 2

Uma segunda simulação pós-commit encontrou zero linhas adicionais para remover,
confirmando que o processo ativo não recriou os dados durante a validação.

## Ferramentas

- Inventário somente leitura: `scripts/planejar-limpeza-prod-readonly.cjs`
- Limpeza protegida e repetível: `scripts/limpar-dados-teste-seletivo-prod.cjs`

O script de limpeza executa dry-run por padrão. O commit exige simultaneamente
`ALLOW_PRODUCTION_CLEANUP=1`, `COMMIT=1` e o argumento
`--confirm=APAGAR_DADOS_TESTE`.
