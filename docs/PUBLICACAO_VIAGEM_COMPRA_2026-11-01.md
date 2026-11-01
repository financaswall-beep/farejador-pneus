# Viagem de compra — preparação da publicação (2026-11-01)

O Wallace autorizou publicar os códigos para fazer o deploy posteriormente. Esta autorização é posterior à entrega local para revisão; não foi recebido um parecer do Claude nesta conversa. O relatório de revisão anterior registra o estado histórico antes desta liberação.

Implementação: `31b65093611b12d5328eed381e479a4f7b8573f5`. Provas e preview: `a4a70fea`.

## Migration 0280

`0280_wholesale_purchase_groups.sql` aplicada e registrada em `ops.applied_migrations` no projeto operacional `beisgivepyfhgcujsqan`. Schema compartilhado pelas linhas `environment=test` e `environment=prod`; não há um lançamento financeiro da viagem nem uma variável de ambiente nova.

Checksum SHA256: `44791dcd0599325f317097b754c2821ab51efd84617acbb21fd855c50e4e176c`.

Sequência executada antes do push:

1. Consulta somente leitura: versão 279, nenhuma das três tabelas de viagens presente.
2. Ensaio em transação com rollback: versão 280, três tabelas presentes, permissões e travas conferidas, hashes das linhas do financeiro, estoque, compras, itens, lotes e despesas idênticos.
3. Aplicação definitiva em transação: SQL versionado e registro no ledger no mesmo commit; comparação das fontes novamente idêntica.
4. Nova conexão somente leitura confirmou versão 280, checksum correto, três tabelas com RLS, quatro FKs compostas com environment, nenhum grant de tabela ou coluna aos perfis de parceiros e todos os 11 gatilhos esperados.

Os 11 gatilhos são três de imutabilidade do ambiente, dois de vínculos, cinco de exclusividade com módulos donos de despesas e um de mudança de OC. Eles validam relações; não atualizam valores dos registros de origem.

As saídas detalhadas da aplicação estão nos artefatos privados locais `.codex-tmp/release-purchase-groups-0280-{check,rehearse,commit,verify}.json`, sem credenciais. As provas funcionais permanecem em [REVISAO_VIAGEM_COMPRA_PARA_CLAUDE_2026-11-01.md](REVISAO_VIAGEM_COMPRA_PARA_CLAUDE_2026-11-01.md): 15/15 duas vezes, 3.727 testes unitários verdes, TypeScript/tamanho/paridade/rotas/migrations aprovados e preview real por cliques.

## Deploy

O primeiro CI do PR 146 revelou um cenário antigo de aprovação de nota de julho sem confirmação retroativa. Com novembro, a competência passou do limite de três meses. A correção fica só nos dados de teste: confirmação explícita nos três cenários fixos de julho das provas do livro central e da consistência logística (Etapa 10). A política de produção não foi alterada.

Revalidação local dos dois arquivos em PostgreSQL descartável: **19/19 testes passaram**. O restante da publicação aguarda o novo CI completo.

A rodada local dos arquivos ainda não alcançados pelo primeiro CI passou em 70/71 arquivos e revelou outro cenário sensível à virada do mês: `operation-chat` cria mensagens de ontem, mas no banco descartável novo não havia a partição do mês anterior. O setup desse teste agora prepara explicitamente essa partição, como já faz a prova de localização. Nenhuma migration ou regra de produção foi alterada por essa correção de teste.

Após preparar a partição do cenário, **9/9 testes de operation-chat passaram** no PostgreSQL descartável. O novo CI deve validar o conjunto completo antes do merge.

O deploy é manual no Coolify e fica com o Wallace. O código novo deve chegar ao `main` após o CI da publicação; não executar o deploy enquanto a publicação e suas verificações não forem confirmadas. A migration 0280 já está pronta no banco para receber esse código. Não há variável nova.
