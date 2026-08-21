# Auditoria ponta a ponta — Equipe e Colaboradores

**Data:** 21/08/2026
**Escopo:** Equipe do parceiro, Colaboradores da Matriz, autenticação, permissões,
vínculos de trabalho, remuneração, comissão, folha, Vendas, Estoque, Logística e
Financeiro.
**Estado deste documento:** correções concluídas em código; migrations `0192` e
`0193` aplicadas e reconciliadas no banco de produção; release rastreada pela PR
`#66`; deploy ainda não iniciado.

## O que foi cruzado

| Relação | Prova procurada |
|---|---|
| Tela → API → banco | O mesmo nome, função, acesso, salário e comissão chegam ao registro correto |
| Funcionário → sessão | Desativação corta sessões; reativação não apaga o período anterior |
| Permissão → rota | Sem linha individual de acesso, o funcionário não herda poder da loja |
| Vendas → comissão | Só fato realizado conta; regra válida na data da venda fica congelada e arredondada em centavos |
| Logística → desempenho | Entrega/viagem conta apenas para quem estava empregado na data do evento |
| Folha → Financeiro | Salário, benefício, comissão, acréscimo e desconto fecham no mesmo valor da despesa e do ledger |
| Matriz ↔ parceiro | Uma pessoa com mais de um vínculo não perde a conta global ao sair de apenas uma unidade |
| Histórico → relatórios | Demissão e recontratação preservam períodos imutáveis e não reescrevem competências antigas |

## Defeitos encontrados e corrigidos

### Segurança e identidade

- A ausência da permissão individual do funcionário podia cair no acesso padrão da
  unidade. Agora a resolução é **fail closed**: todas as telas ficam bloqueadas.
- Todo funcionário passa a nascer com uma linha individual explícita, inicialmente
  sem acesso, e a migration preenche com `false` os vínculos antigos sem linha.
- “Avisos/Bate-papo” passou a fazer parte das nove permissões ponta a ponta; antes a
  tela podia descartar esse valor ao salvar.
- A função operacional (`vendedor`, `estoque`, `entregador` ou `colaborador`) passou
  a ser um dado explícito. Ela não é mais adivinhada pelas telas permitidas.
- Nome, função, nove permissões, remuneração e comissão agora são salvos em **uma
  transação**. Se qualquer parte falhar, nenhuma parte fica gravada pela metade.
- Criação, primeiro acesso e redefinição exigem senha nova com pelo menos 12
  caracteres. O login aceita as senhas antigas de seis caracteres para não bloquear
  usuários existentes; a senha precisa ficar forte na próxima redefinição.
- Consultas auxiliares de permissão também falham fechadas quando o banco erra.
- Busca de cliente e arquivamento agora exigem a permissão compatível com o tipo do
  registro, sem abrir acesso lateral por uma rota genérica.

### Admissão, demissão e recontratação

- Matriz e parceiro ganharam períodos de vínculo imutáveis, com início e fim.
- A primeira migration faz backfill do vínculo atual. Ao desativar, fecha o período;
  ao reativar, abre outro, sem apagar o anterior.
- Revogação do parceiro, sessões e conta da pessoa são tratadas na mesma transação.
- A conta global só é revogada quando não existe outro vínculo ativo, inclusive na
  Matriz. Sair de uma loja não derruba o acesso válido em outra frente.
- Folha, comissão, entregas e viagens conferem se o colaborador estava empregado no
  dia do fato, não apenas se ele está ativo hoje.

### Remuneração, comissão e folha

- Consultas mostram a configuração válida hoje; uma mudança futura pode ser
  agendada sem alterar antecipadamente o salário/comissão atual. O editor ainda
  consegue enxergar a configuração futura mais recente.
- Folhas semanal e mensal do parceiro respeitam os períodos de vínculo.
- Comissão da Matriz é arredondada **por evento** em centavos. Duas vendas de
  R$ 0,05 a 10%, por exemplo, geram R$ 0,01 cada, e não R$ 0,01 no total.
- Detalhes de comissão do parceiro passaram a incluir ajustes e estornos, com tipo
  explícito e total conciliado ao fechamento.
- A Matriz não fecha folha do mês atual nem de mês futuro. A trava existe no painel,
  na API e no banco, usando o calendário de São Paulo.
- Acréscimos e descontos são alocados aos itens da folha com trilha própria.
- Um desconto nunca cria pagamento negativo: aplica até o bruto disponível e leva
  o saldo restante para a competência seguinte.
- Folha de saldo zero é fechada e marcada como paga sem criar uma despesa fictícia.
- Pendências causais antigas também bloqueiam o fechamento seguinte até revisão.
- Benefícios e entradas monetárias passaram a exigir precisão real de centavos.

### Regressão cruzada encontrada durante a prova

Uma venda de atacado à vista sem horário explícito podia gerar `paid_at` no Node e
`sold_at` alguns milissegundos depois no PostgreSQL. O banco corretamente recusava
“pagamento anterior à venda”. Venda e pagamento agora compartilham o mesmo instante.
Esse acerto preserva as guardas anteriores de Vendas e Financeiro.

## Migrations aplicadas em produção

- `0192_team_employment_and_payroll_integrity.sql`: períodos de vínculo, função
  explícita, permissões fechadas, precisão monetária, trava de competência e
  alocação/carry de ajustes da folha.
- `0193_partner_staff_employment_rollovers.sql`: salários semanais, folha mensal e
  comissão do parceiro passam a respeitar os períodos de emprego.

As duas migrations carregaram com sucesso em PostgreSQL limpo junto das 192 anteriores.
Em produção, foi feito backup completo antes da mudança e a aplicação ocorreu em uma
única transação: primeiro um ensaio com `ROLLBACK`, depois o `COMMIT` controlado.

- Backup: `farejador-pre-0192-0193-20260821-071111.dump`;
- SHA-256 do backup:
  `3bf4380e42df1ab8bc8e228fae49a5d9d09042394ec584f71ca21a71eb13e8c3`;
- backfill reconciliado: 16 períodos da Matriz, 12 períodos do parceiro e 12 linhas
  explícitas de permissão;
- inconsistências pós-migration: **zero** em todos os 13 controles específicos de
  vínculo, cargo, permissão, folha, alocação e privilégio.

O histórico `supabase_migrations.schema_migrations` já era incompleto e foi preservado:
nenhuma versão antiga foi inventada apenas para aparentar alinhamento. A comprovação desta
etapa é material, pelos objetos instalados, backfills e invariantes consultados no banco.

## Provas executadas

| Bateria | Resultado |
|---|---|
| Unitários completos | **1.238/1.238**, 247 arquivos |
| Integração direcionada de Equipe, folha, login e matemática | **22/22** |
| Integridade do atacado após correção do relógio | **12/12** |
| TypeScript e build | aprovados |
| Migrations | **194 verificadas**, última `0193`; gap histórico `0071` já documentado |
| Painéis e contratos | 586 propriedades do parceiro, 1.061 da Matriz, 91 chamadas e 236 rotas aprovadas |
| Fiscal de arquitetura | aprovado; arquivos novos abaixo de 300 linhas e legado não cresceu |
| Integração completa final | **254/254**, 46 arquivos; comando oficial aprovado em lotes de 12/12/12/10 |
| Reconciliação específica de Equipe em produção | **13/13 controles aprovados**, transação somente leitura |
| Auditoria geral de produção | **PASS**; ingestão, normalização, ledger, reconciliação e RLS aprovados |

## Sugestões registradas, não implementadas

Estas ideias não são correções e não foram adicionadas sem decisão do dono:

- modelos prontos de permissão por função, mantendo a edição individual;
- aprovação do dono para desconto acima de um limite por vendedor;
- autenticação em dois fatores para proprietários;
- exportação contábil da folha e comprovante individual;
- metas, escala, ponto e alertas de vencimento documental;
- painel de auditoria de acessos e sessões por funcionário.

## Veredito desta etapa

**APROVADO EM CÓDIGO, BANCO DESCARTÁVEL, BANCO DE PRODUÇÃO, INTEGRAÇÃO,
MATEMÁTICA, SEGURANÇA E REGRESSÃO CRUZADA.** Os defeitos confirmados estão corrigidos,
cobertos por migrations e testes, e as migrations `0192` e `0193` já estão aplicadas e
reconciliadas. O código desta entrega é rastreado pela PR `#66`. Restam o deploy manual e
o smoke autenticado. Este veredito não declara o runtime novo já implantado.

O comando `npm run test:integration` também foi estabilizado: ele renova o processo do
Vitest a cada 12 arquivos, sequencialmente. Isso evita o encerramento tardio do worker por
acúmulo de recursos sem mudar testes, banco ou rigor da bateria.
