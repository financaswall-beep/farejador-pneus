# Handoff para Claude — Painel único web

> **Atualização de 24/08/2026:** a expansão local para Vendas, Compras, Estoque,
> Logística, Financeiro, Colaboradores e Catálogo está documentada em
> `SESSAO_2026-08-24_PAINEL_PARCEIRO_SUITE_HANDOFF.md`. Esta página abaixo
> preserva o estado histórico do primeiro canário (Resumo + Retiradas).

**Data:** 23/08/2026
**Estado:** 10 de 10 PRs incorporados; migration `0203` aplicada; deploy pendente.

## 1. Resumo executivo

A obra do painel único web foi concluída conforme o plano de dez PRs. O painel
da Matriz continua sendo o casco visual comum, mas as sessões, permissões,
rotas e conexões de banco permanecem separadas por perfil. O `/operacao` móvel
foi preservado e não foi reescrito.

O primeiro canário do parceiro contém **Resumo** e **Retiradas**. Ele nasce
desligado por unidade e só o dono da Matriz pode ativá-lo. Desligar a chave faz
o parceiro retornar ao painel anterior na próxima validação da sessão, sem
rollback de deploy ou de migration.

## 2. Os dez PRs

| Plano | GitHub | Entrega | Merge SHA |
|---:|---:|---|---|
| 1 | #88 | Prova de roteamento de vendas por escopo | `46e2edf` |
| 2 | #89 | Gate de arquitetura dos pools do parceiro | `5c8f7dc` |
| 3 | #90 | Gate de guardas, pools e escopo das rotas da Matriz | `d5a6a03` |
| 4 | #91 | Detector de colisões do compositor do painel | `8a65569` |
| 5 | #92 | Contrato de grants, hash e lista proibida | `ea23767` |
| 6 | #93 | Broker de login e contexto rico | `6e9c7be` |
| 7 | #94 | Casco, menu e boot derivados do perfil | `0e22c4b` |
| 8 | #95 | Resumo moderno do parceiro, somente leitura | `bd56f52` |
| 9 | #96 | Retiradas do parceiro com escrita transacional existente | `68e631e` |
| 10 | #97 | Canário por unidade, rollback e telemetria técnica | `f555c02` |

## 3. Contrato de segurança preservado

- Matriz administrativa recebe sessão `ms_`.
- Parceiro recebe sessão `ps_`.
- Operação móvel recebe sessão `cs_`.
- `panel_role` não foi afrouxado para permitir parceiro na sessão da Matriz.
- O frontend do parceiro chama `/parceiro/:slug/api/*`, que usa pool restrito,
  contexto da unidade e RLS.
- O caminho `/api/caixa/*` permanece exclusivo da Matriz/operação autorizada.
- O papel `farejador_partner_app` passou conscientemente de 70 para 71 grants:
  o único acréscimo é `INSERT` na telemetria técnica do canário.
- O parceiro não recebe `SELECT` nessa telemetria.
- Eventos não possuem cliente, pedido, telefone, valor nem JSON livre.
- Alterar a chave do canário é owner-only e gera trilha em `audit.events`.

## 4. Migration 0203

Arquivo: `db/migrations/0203_partner_modern_panel_canary.sql`.

Foi aplicada em 23/08/2026 no banco novo do Supabase em `sa-east-1`, usando a
conexão local `.env.novo`. A conexão `.env.pooler`, localizada nos Estados
Unidos e já identificada como outro banco, não foi usada nem alterada.

Pré-estado confirmado:

- 256 tabelas de aplicação;
- catálogo da `0202` presente;
- zero unidades parceiras;
- flag e tabela da `0203` ausentes.

Pós-estado confirmado depois do `COMMIT`:

- `network.partner_units.modern_panel_enabled` presente, `NOT NULL` e `false`
  por padrão;
- zero unidades habilitadas;
- `ops.partner_panel_canary_events` presente com RLS;
- policy de `INSERT` isolada pela unidade;
- dois índices técnicos presentes;
- parceiro com `INSERT`, sem `SELECT`;
- `PUBLIC` sem grants;
- nenhuma coluna proibida de PII ou valor.

O executor seguro e reproduzível ficou em
`scripts/aplicar-0203-prod.cjs`. Ele exige autorização explícita, região
`sa-east-1`, catálogo anterior presente, banco sem unidades no primeiro uso,
manifesto íntegro, transação, advisory lock e verificação pós-commit.
Com as mesmas variáveis de proteção, `--verify` refaz somente a conferência do
estado instalado, sem escrever no banco.

## 5. Testes e veredicto

O CI final do PR #97 passou em 6m55s:

- fiscal de tamanho;
- checksums de 204 migrations;
- arquitetura dos pools;
- guardas e escopo das rotas;
- detector de colisões;
- TypeScript;
- 1.340 testes unitários;
- 58 arquivos e 286 cenários de integração PostgreSQL;
- build de produção.

Houve uma primeira execução vermelha porque o teste aceitava apenas a mensagem
de RLS. O banco bloqueou a tentativa entre unidades ainda antes, pelo trigger
`env_match`. A expectativa foi corrigida para aceitar os dois mecanismos de
bloqueio; nenhuma regra de produção foi relaxada.

## 6. O que mudou funcionalmente

- O dono vê, na ficha da unidade, a chave “Painel moderno — canário”.
- O painel mostra eventos, erros e latência p95 das últimas 24 horas.
- Resumo reutiliza as rotas financeiras e operacionais do parceiro; o navegador
  não recalcula dinheiro.
- Retiradas reutiliza confirmação, cancelamento, reserva, estoque e caixa já
  auditados; não existe segundo motor transacional.
- Desligar o canário redireciona para o painel legado no próximo `/api/me`.

## 7. O que não mudou

- `/operacao` móvel continua ativo.
- Cálculos de venda, estoque, custo, comissão e financeiro não foram alterados.
- Nenhuma unidade foi cadastrada ou habilitada automaticamente.
- Nenhum deploy foi iniciado por esta execução.

## 8. Próximo passo operacional

1. Publicar o SHA final da `main` no Coolify.
2. Confirmar build e rolling update completos.
3. Executar smoke de login da Matriz e do parceiro.
4. Cadastrar a primeira unidade controlada, se ainda não existir.
5. Conferir permissões dessa unidade.
6. Habilitar o canário somente nela.
7. Testar Resumo e Retiradas e observar a telemetria por 24 horas.
8. Se houver problema, desligar a chave; não reverter banco nem deploy.

## 8.1 Smoke real após o primeiro deploy

O smoke autenticado em `farejador.smarttecsolutions.com.br` confirmou login do
owner e carregamento de Resumo, Bot, Vendas, Compras, Estoque, Financeiro, Rede
e Catálogo sem alertas visíveis. No Catálogo, clicar em `2 moto(s)` abriu o
drawer e mostrou corretamente CG 150 Fan e CG 150 Titan, com anos, posição e
origem.

O console revelou um defeito menor de inicialização: o Alpine avaliava campos
ocultos de pesquisa antes de `discoveryForm` e `discoveries` existirem no estado
inicial. O fluxo visível funcionava porque o clique reconstruía o objeto
completo. A correção inicializa esses campos desde o boot e troca a versão do
`app.js` para invalidar cache. Não muda API, banco, compatibilidades, Bot,
estoque ou financeiro e não exige migration.

## 9. Veredicto para revisão do Claude

O código e o banco estão prontos para o deploy técnico. A liberação ampla para
parceiros ainda não está autorizada: primeiro deve passar o canário de uma única
unidade. A revisão do Claude deve procurar regressão de autenticação, diferença
entre rotas legadas e modernas, ampliação acidental de grants e qualquer campo
de negócio introduzido na telemetria.
