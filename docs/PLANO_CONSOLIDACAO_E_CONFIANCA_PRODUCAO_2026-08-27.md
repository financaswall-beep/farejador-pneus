# Plano de consolidação e confiança para produção — Farejador

**Data:** 27 de agosto de 2026
**Escopo:** Matriz, Bot/Chatwoot, operação, rede de parceiros, banco, integrações, segurança, deploy e continuidade
**Objetivo:** transformar o sistema atual em uma plataforma previsível, recuperável e comprovadamente segura para dados reais, sem reescrita total e sem quebrar os fluxos financeiros já auditados.

---

## 1. Veredito executivo

O Farejador não é um conjunto de bancos ou servidores independentes. Hoje ele é um **monólito modular**, executado por um único processo principal, com **um banco Supabase** e conexões diferentes conforme o nível de privilégio.

O núcleo transacional está mais sólido do que a organização do repositório sugere:

- build e TypeScript aprovados;
- 1.471 testes unitários aprovados;
- 60 arquivos e 292 testes de integração com banco Docker aprovados;
- 215 migrations presentes no repositório e com checksums válidos;
- livro financeiro central balanceado;
- nenhuma divergência causal encontrada entre venda, recebimento, estoque, custo e ledger na amostra atual;
- rotas administrativas e do parceiro separadas;
- papel restrito do parceiro sem privilégios sensíveis;
- RLS presente nas tabelas expostas ao parceiro;
- objetos das migrations 0201 a 0214 encontrados no banco.

O sistema, entretanto, ainda **não deve receber aprovação irrestrita para produção**. Os bloqueadores atuais são operacionais e arquiteturais:

1. segredos foram expostos e precisam ser rotacionados;
2. o banco e o ledger canônico de migrations estão sincronizados até a versão 0214;
3. o ingresso externo originado pelo Chatwoot ainda precisa de prova pós-deploy;
4. o modo sombra do Agent V2 ainda precisa gerar e avaliar respostas com a chave válida do Coolify;
5. o canário de envio do bot ainda não foi executado;
6. existem três interfaces concorrentes e o painel antigo do parceiro ainda está ativo;
7. existe uma unidade de teste ativa no ambiente `prod`;
8. não há prova recente de restauração integral de backup.

### Decisão recomendada

- **Matriz:** pode entrar em canário controlado depois dos Portões 0 a 3 deste plano.
- **Bot:** permanece desligado até o Portão 4.
- **Parceiros:** não bloqueiam o início controlado da Matriz; devem continuar fora da comercialização até o Portão 6.
- **Abertura geral:** somente após backup restaurado, E2E autenticado, monitoramento e canário reconciliado.

---

## 2. O que significa “sistema pronto”

O sistema será considerado pronto quando atender simultaneamente aos seguintes critérios:

1. **Repetível:** um banco vazio pode ser instalado até a última migration automaticamente.
2. **Rastreável:** é possível identificar exatamente quais migrations e qual commit estão em produção.
3. **Íntegro:** vendas, compras, estoque, financeiro e comissões fecham matematicamente.
4. **Isolado:** parceiros e colaboradores não conseguem acessar dados fora de seu escopo.
5. **Recuperável:** um backup pode ser restaurado em outro banco e a aplicação volta a operar.
6. **Observável:** falhas de banco, Chatwoot, Meta, workers e filas geram alertas.
7. **Resiliente:** duplicidade, concorrência, retry e reinício não duplicam efeitos financeiros.
8. **Operável:** existe procedimento claro para deploy, rollback e incidente.
9. **Compreensível:** interfaces oficiais e módulos ativos estão documentados.
10. **Seguro:** nenhum segredo exposto permanece válido.

Ter muitas telas funcionando não substitui esses dez critérios.

---

## 3. Arquitetura atual comprovada

```text
Chatwoot / Meta
      │
      ▼
raw.* ──► core.* ──► analytics.*
  │                        │
  │                        ▼
  └─ auditoria/replay   Bot e sinais

/admin/painel ─┐
/operacao      ├──► Fastify/TypeScript ──► commerce.*
/parceiro/... ┘                         ├─► finance.*
                                       ├─► network.*
                                       ├─► marketing.*
                                       ├─► agent.*
                                       └─► ops.*
```

### Fontes canônicas por domínio

| Domínio | Fonte oficial |
|---|---|
| Webhooks brutos e replay | `raw.*` |
| Conversas e mensagens normalizadas | `core.*` |
| Interpretações e sinais derivados | `analytics.*` e `analytics_marts.*` |
| Produtos, compras, estoque, vendas e entregas | `commerce.*` |
| Caixa, contas, despesas, comissões e ledger | `finance.*` |
| Unidades, sessões, colaboradores e permissões | `network.*` |
| Meta Ads, atribuição e CAPI | `marketing.*` |
| Jobs e ações do agente | `agent.*` e `ops.*` |

### Superfícies de interface existentes

| Interface | Situação | Destino recomendado |
|---|---|---|
| `/admin/painel` | Painel moderno da Matriz e início do parceiro moderno | Interface oficial de gestão web |
| `/operacao` | Operação diária compartilhada e responsiva | Interface oficial de operação/mobile |
| `/parceiro/:slug/` | Painel antigo do parceiro ainda servido no desktop | Congelar, provar paridade e aposentar |

Não deve existir uma quarta interface. Regras de negócio devem permanecer no servidor, nunca duplicadas nas telas.

### Como está hoje e como deve ficar

| Área | Como está hoje | Como deve ficar | Quando agir |
|---|---|---|---|
| Backend | Um monólito modular Fastify/TypeScript | Continuar como monólito modular | Manter; não reescrever |
| Banco | Um Supabase, com conexão administrativa e conexão restrita do parceiro | Continuar no mesmo banco, preservando roles e RLS | Manter e monitorar |
| Motores financeiros | Centralizados no servidor e no ledger | Continuar como única fonte de cálculo | Não alterar durante reorganização visual |
| JavaScript do painel | Já dividido em módulos-fábrica; 116 de 118 arquivos em até 300 linhas | Preservar a estrutura e reduzir apenas os dois herdados quando houver oportunidade | Depois dos bloqueadores de produção |
| HTML do painel | Todas as telas estão em um `index.html` de 10.103 linhas e cerca de 1,2 MB | Templates-fonte separados e montados no build, gerando o mesmo HTML estático | Pós-canário; não bloqueia a Matriz |
| Painel da Matriz | `/admin/painel`, moderno e funcional | Interface oficial de gestão web | Validar no E2E e manter |
| Operação diária | `/operacao`, compartilhada e responsiva | Interface oficial de operação/mobile | Validar no E2E e manter |
| Painel antigo do parceiro | `/parceiro/:slug/` ainda servido no desktop | Congelado e posteriormente aposentado após paridade | Depois da Matriz e antes de comercializar parceiros |
| Migrations | DDL até 0212 presente, marcador oficial ainda em 0200 | Ledger com arquivo, checksum, data e commit; boot exige versão correta | Agora; bloqueador de confiança |
| Variáveis de ambiente | Muitas flags independentes e algumas obsoletas | Contrato de dependências, perfis documentados e descontinuação gradual | Agora; antes do próximo canário |
| Bot | Worker e outbox desligados; banco novo sem ingestão comprovada | Webhook comprovado, sombra, canário e ativação gradual | Depois de estabilizar a Matriz |
| Scripts | 129 versionados e 90 locais sem classificação única | Operacionais, auditorias, laboratório, históricos e destrutivos separados | Depois do canário |

### O que fazer agora e o que adiar

**Fazer agora, antes de confiar dados reais:**

1. rotacionar segredos;
2. corrigir dependências das flags;
3. criar o ledger confiável de migrations;
4. executar integração com banco limpo;
5. restaurar um backup;
6. executar E2E e reconciliação da Matriz;
7. colocar a Matriz em canário monitorado.

**Adiar até a Matriz estar operando:**

- separar templates HTML;
- reduzir os dois JavaScripts herdados de Compras;
- limpar scripts, mocks e previews;
- aposentar o painel antigo do parceiro;
- fazer alterações estéticas amplas.

Essa ordem protege o que gera receita primeiro. O tamanho do HTML é dívida de manutenção, não evidência de erro financeiro e não deve atrasar o canário da Matriz.

---

## 4. Evidências coletadas

| Bateria | Resultado atual | Observação |
|---|---|---|
| TypeScript | Aprovado | Compilação sem erro |
| Build de produção | Aprovado | CSS e JavaScript gerados |
| Testes unitários | 1.457 aprovados | 294 arquivos de teste |
| Manifesto de migrations | Aprovado | 213 arquivos, gap 0071 documentado |
| Provas de painel e rotas | Aprovado | Rotas da Matriz, parceiro e operação conferidas |
| Roteamento de vendas | Aprovado | Parceiro converge para o motor protegido; Matriz usa seu motor próprio |
| Grants do parceiro | Aprovado | 73 grants esperados e encontrados; nenhum sensível |
| RLS do parceiro | Aprovado | Tabelas expostas protegidas |
| Livro central | Aprovado | 22 transações balanceadas |
| Integridade financeira | Aprovado | Sem duplicidade, antecipação ou divergência encontrada |
| Migrations 0001–0214 | Aprovado | Ledger canônico com 215 arquivos e checksums aplicado |
| Integração com banco descartável | Aprovado | 60 arquivos e 292 testes de integração cobertos |
| E2E autenticado real da Matriz | Aprovado com ressalva de publicação | Compra, recebimento parcial, vendas, recebimento, cancelamento, estorno, permissões e revogação comprovados; falta publicar dois reparos e repetir o smoke |
| Backup e restauração | Pendente | Bloqueador de abertura geral |
| Webhook real Chatwoot | Pendente | Banco novo ainda sem eventos normalizados |
| Bot canário | Pendente | Bot atualmente desligado |

---

## 5. Registro de riscos

### P0 — resolver antes de qualquer dado real

#### R-001 — Segredos expostos

**Risco:** acesso indevido a banco, Chatwoot, Meta, Google, notificações e administração.
**Ação:** rotacionar todas as credenciais que apareceram em conversas, telas, arquivos temporários ou logs.
**Aceite:** segredos antigos revogados e teste positivo usando somente os novos.
**Responsável:** proprietário das contas; o código não deve receber os valores.

#### R-002 — Histórico de migrations incompleto

**Risco:** aplicação iniciar sobre banco incompatível ou rollback ser feito sem conhecer o estado real.
**Estado em 27/08/2026:** resolvido pela `0213_migration_ledger.sql` e avançado pela
`0214_purchase_adjustment_reconciliation_health.sql`. O banco informa versão 214,
possui 215 arquivos distintos com checksum e registra as migrations novas como
aplicadas pelo executor. Datas históricas desconhecidas permanecem nulas, sem
inventar evidência. A tabela é privada e bloqueia `UPDATE`/`DELETE`.
**Aceite:** atendido; o runtime novo exige o ledger e o executor atualiza marcador e
checksum na mesma transação da migration.

#### R-003 — Restauração não comprovada

**Risco:** possuir backup que não pode ser recuperado.
**Ação:** restaurar uma cópia em projeto/banco isolado e executar smoke.
**Aceite:** login, leitura, venda de teste e reconciliação funcionando no banco restaurado.

### P1 — resolver antes do canário da Matriz

#### R-004 — Integração em banco limpo

**Estado em 27/08/2026:** resolvido. As 214 migrations foram reexecutadas por meio
do executor real em PostgreSQL 17 vazio; o ledger terminou com 214 arquivos e a
suíte completa cobriu 60 arquivos/292 testes de integração.
**Aceite:** atendido para instalação limpa; a restauração do backup continua sendo
um controle separado no R-003.

#### R-005 — Combinação inválida da IA de comprovantes

**Risco:** upload de comprovante falhar mesmo com o servidor saudável.
**Ação imediata:** manter a IA de comprovantes desligada enquanto não houver chave e fluxo de aprovação válidos.
**Ação definitiva:** validar dependências das flags no boot.
**Aceite:** configuração inválida impede o servidor de iniciar com mensagem clara.

#### R-006 — Unidade de teste ativa em `prod`

**Risco:** dados de canário serem confundidos com dados comerciais ou entrarem no roteamento.
**Ação:** desativar, transformar em unidade formal de canário ou recriar em `environment='test'`.
**Aceite:** nenhuma unidade de demonstração participa da operação comercial.

### P2 — resolver antes de ativar Bot e parceiros

#### R-007 — Ingestão do Chatwoot não comprovada no banco novo

**Risco:** Bot e análises operarem sem dados ou sobre conexão errada.
**Ação:** enviar webhook assinado real e acompanhar `raw → core`.
**Aceite:** um evento aparece primeiro em `raw.raw_events` e depois nas entidades corretas de `core.*`, sem duplicidade.

#### R-008 — Bot desligado e sem canário

**Risco:** reativação direta responder incorretamente para todos.
**Ação:** ativar worker em sombra, restringir o canário de forma realmente utilizada pelo runtime, depois habilitar outbox.
**Aceite:** conversas controladas respondidas corretamente e sem envio duplicado.

#### R-009 — Três interfaces concorrentes

**Risco:** correção visual ou funcional chegar em uma interface e não nas outras.
**Ação:** declarar duas superfícies oficiais e congelar a antiga.
**Aceite:** checklist fechado de paridade e redirecionamento seguro do painel antigo.

### P3 — manutenção e escala

#### R-010 — Templates HTML ainda concentrados em um arquivo

**Situação comprovada:** a lógica JavaScript do painel **já foi modularizada**. `app.js` possui 298 linhas e guarda principalmente o estado; `app.montagem.js` possui 126 linhas e compõe as fábricas registradas em `window.PAINEL_MODULES`. O fiscal vigia 588 arquivos TypeScript/JavaScript com teto universal de 300 linhas. Dos 118 JavaScripts de `painel/public`, 116 estão em até 300 linhas e os dois restantes são dívidas herdadas congeladas (`app.compras.js` e `app.compras.acoes.js`).
**Dívida restante:** `painel/public/index.html` possui 10.103 linhas e aproximadamente 1,2 MB porque ainda contém o markup de todas as abas da Matriz e do parceiro. HTML e CSS foram deliberadamente excluídos do fiscal de 300 linhas.
**Risco:** regressões de layout, conflitos de identificadores e revisão difícil de alterações visuais; não é evidência de que os motores financeiros estejam misturados.
**Ação:** separar somente os templates HTML por aba e montá-los no build, preservando o HTML final estático, o estado Alpine, os módulos JavaScript, as APIs e as regras do servidor.
**Aceite:** cada template-fonte tem escopo claro; o `index.html` final gerado mantém paridade estrutural e funcional; nenhuma rota ou regra financeira é alterada.
**Prioridade:** pós-canário. Não é bloqueador para iniciar a Matriz.

#### R-011 — Scripts e documentação sem classificação

**Risco:** executar por engano um script destrutivo ou desatualizado.
**Ação:** inventariar, classificar e arquivar. Scripts destrutivos exigem confirmação, ambiente e alvo explícitos.
**Aceite:** nenhum script operacional fica solto sem cabeçalho de segurança.

#### R-012 — Pressão de conexões

**Risco:** processo administrativo, pool do parceiro, workers e listeners excederem o limite do Supabase durante crescimento.
**Ação:** medir conexões em carga e documentar teto.
**Aceite:** p95/p99 estáveis e uso máximo abaixo do limite contratado.

---

## 6. Plano de execução por portões

## Portão 0 — Congelamento e segurança

**Objetivo:** impedir que a arrumação crie mais dívida ou mantenha credenciais comprometidas.

1. Congelar novas funcionalidades até finalizar os Portões 1 a 3.
2. Criar backup antes de qualquer migration nova.
3. Rotacionar credenciais expostas.
4. Confirmar que `.env*`, dumps e logs continuam fora do Git e da imagem Docker.
5. Registrar o SHA atualmente implantado.
6. Manter Bot e IA de comprovantes desligados durante a consolidação.
7. Definir formalmente se a unidade canário permanece em `prod`.

**Saída obrigatória:** inventário de credenciais rotacionadas, backup identificado e SHA registrado.

### Registro de execução do Portão 0 — 27/08/2026

**Estado:** EM ANDAMENTO. A parte técnica de inventário, backup e identificação do
deploy foi executada. O portão permanece aberto por causa da rotação de credenciais
e da decisão formal sobre a unidade canário.

#### Estado implantado

- Branch local: `main`.
- `HEAD`, `origin/main` local e commit informado pelo endpoint de saúde:
  `ca61f2254d46c74ff299d66fd69e5e6ec48dc18e`.
- `/healthz`: HTTP 200 em 27/08/2026, com banco, schema mínimo, conexão restrita do
  parceiro e continuidade operacional respondendo `ok`.
- Estado geral: `degraded`, sem bloqueio crítico, com avisos de jobs de partição e
  retenção não observados e ingestão Chatwoot sem evento recente.
- Bot e IA de comprovantes devem permanecer desligados durante os Portões 0 a 3.

#### Proteção de arquivos e imagem

- `.env`, `.env.*`, dumps, logs e arquivos de backup estão ignorados pelo Git.
- `.env.novo` foi confirmado como ignorado.
- A imagem final local contém somente runtime, dependências, painel, parceiro e
  segmentos; não contém `.env`, Git, documentação, testes, scripts, dumps nem `tmp`.
- O `.dockerignore` foi endurecido localmente para impedir que materiais de
  laboratório e recuperação entrem no contexto do build. A alteração ainda precisa
  passar pela revisão e publicação normal do repositório.
- A árvore atual não contém segredo de produção detectável nos arquivos rastreados.
  Entretanto, dois tokens da Meta com formato real foram encontrados no histórico
  do Git em documentos antigos. Eles devem ser tratados como comprometidos mesmo
  não aparecendo mais no `HEAD`.

#### Backup atual

- Backup criado depois da `0212`:
  `.codex-tmp/backups/farejador-prod-portao0-post-0212-20260827-084807.dump`.
- Tamanho: 1,84 MB; catálogo interno: 3.089 entradas.
- SHA-256: `4039b2940ec8337f3598d76ff54bc7a6899c7a73cbcb2745f00f6433a32054fe`.
- Restauração estrutural em container temporário: 256 tabelas restauradas e marco
  funcional da `0212` presente.
- Ressalva: a imagem PostgreSQL comum não possui `pg_cron`; por isso a restauração
  terminou com avisos dessa extensão. A prova final ainda deve ser repetida em um
  PostgreSQL compatível com Supabase.
- Cinco backups antigos não vazios tiveram o catálogo validado. Três arquivos de
  backup com 0 byte são inválidos e não contam como recuperação.

#### Migrations e unidade canário

- Repositório: 214 migrations com manifesto e checksums aprovados; última `0213`;
  lacuna histórica `0071` documentada.
- Banco atual: marcos funcionais de `0201` a `0212` presentes.
- Banco atual: `ops.application_schema_state=213`; `ops.applied_migrations` possui
  214 arquivos distintos (201 inferidos historicamente, 12 verificados por objetos
  e a `0213` registrada pelo executor). O ledger é imutável e não tem acesso público.
- Existe uma unidade em `prod`; ela está identificada como canário e com painel
  moderno habilitado. Antes de dados comerciais, decidir se ela será removida,
  recriada em `test` ou formalizada como canário com exclusão dos consolidados.

#### Credenciais a rotacionar sem registrar valores

| Grupo | Estado em 27/08/2026 |
|---|---|
| OpenAI | rotação informada pelo proprietário; validar a credencial ativa sem expô-la |
| Meta App, webhook, Ads e CAPI | rotação obrigatória; há exposição na conversa e ocorrência histórica no Git |
| Banco administrativo e conexão restrita do parceiro | rotação obrigatória |
| Chatwoot API e HMAC | rotação obrigatória |
| Token administrativo do Farejador | rotação obrigatória |
| Chave privada Web Push | rotacionar ou remover junto da funcionalidade obsoleta |
| Google Maps | restringir por API/origem e rotacionar se a chave atual não estiver restrita |
| Credenciais de proprietário já compartilhadas | redefinir antes do uso comercial |

**Condição para fechar o Portão 0:** comprovar a rotação dos grupos acima, confirmar
novamente `/healthz`, decidir o destino da unidade canário e registrar o novo estado
sem armazenar valores secretos no repositório.

## Portão 1 — Contrato de configuração

**Objetivo:** transformar dezenas de flags independentes em uma configuração validável.

### 1.1 Manifesto das funcionalidades

Criar um documento/objeto de configuração com:

- nome da funcionalidade;
- variáveis exigidas;
- módulos e rotas afetados;
- dependências;
- incompatibilidades;
- comportamento quando desligada;
- dono operacional.

### 1.2 Regras mínimas de dependência

- Bot worker ligado exige chave de IA e credenciais do Chatwoot.
- Outbox ligada exige Chatwoot completo.
- IA de comprovantes ligada exige chave de IA.
- Aprovação automática exige logística, despesas e IA configuradas.
- Meta Sync exige Meta habilitado e token válido.
- CAPI exige atribuição e dataset/token do canal correspondente.
- Portal do parceiro exige conexão restrita válida.

### 1.3 Variáveis obsoletas

Marcar para descontinuação:

- `PUSH_NOTIFICATIONS`;
- `VAPID_PUBLIC_KEY`;
- `VAPID_PRIVATE_KEY`;
- `WHOLESALE_STOCK_DECREMENT`;
- `MATRIZ_ENTREGADOR_PORTAL`.

`AGENT_V2_CONVERSATION_IDS` **não deve ser removida**. Ela é o contrato pretendido
para restringir o bot a conversas de canário. A variável já é lida pela configuração,
mas o runtime ainda não a aplica antes de enfileirar o atendimento. Até essa ligação
ser implementada e testada, usar `*` pode liberar o bot para todas as conversas.

Processo seguro:

1. uma release emitindo aviso;
2. comprovação de ausência de uso;
3. remoção do Coolify;
4. remoção do schema de ambiente em release posterior.

**Saída obrigatória:** servidor rejeita combinações inválidas antes de abrir a porta HTTP.

## Portão 2 — Ledger de migrations e instalação reproduzível

**Objetivo:** eliminar a maior fragilidade operacional encontrada.

### 2.1 Tabela canônica sugerida

Criar `ops.applied_migrations` com, no mínimo:

- `migration_order`;
- `migration_file`;
- `checksum_sha256`;
- `applied_at`;
- `applied_by`;
- `source_commit_sha`;
- `execution_id`;
- `success`.

### 2.2 Backfill seguro

Não basta inserir 0212 no marcador. Para cada migration histórica:

1. conferir objetos, colunas, constraints, funções e grants;
2. confrontar o checksum com `manifest.sha256`;
3. registrar como `verified_existing`, sem reexecutar DDL;
4. guardar relatório da verificação.

### 2.3 Gate de inicialização

O servidor deve exigir:

- versão mínima igual à exigida pelo commit;
- checksum conhecido;
- objetos críticos presentes;
- ausência de migration parcialmente aplicada.

### 2.4 Estratégia futura

Usar migrations expansivas e compatíveis:

1. adicionar estrutura nova;
2. publicar código que entende os dois formatos;
3. migrar dados;
4. somente depois remover o formato antigo.

**Saída obrigatória:** banco limpo instala 0001–última e banco atual possui histórico verificável.

### 2.5 Execução concluída em 27/08/2026

- Migration `0213_migration_ledger.sql` criada e aplicada no banco atual somente
  após backup, dry-run transacional e replay em PostgreSQL 17 descartável.
- `ops.applied_migrations` registra ordem, sufixo, arquivo, SHA-256, data quando
  comprovável, responsável pelo registro e nível de verificação.
- O histórico 0001–0200 foi marcado honestamente como inferência histórica;
  0201–0212, como objetos existentes verificados; 0213, como execução confirmada.
- O executor avulso e o replay agora gravam o ledger e avançam o marcador dentro
  da mesma transação. Falha ou rollback não produz linha de sucesso.
- O gate de boot exige versão mínima 214, checksum exato da 0214, 215 registros e
  os objetos críticos já exigidos pelo sistema.
- `/healthz` pós-migration respondeu HTTP 200, banco/schema/role restrita e
  continuidade aprovados, exibindo o schema exigido pelo release.
- Provas: build aprovado; 1.457/1.457 testes unitários; 60 arquivos e 292 testes de
  integração cobertos; replay real das 214 migrations aprovado.

**Decisão de modelagem:** `success` não é armazenado no ledger porque somente uma
transação confirmada pode inserir uma linha; falhas ficam nos logs do executor.
Commit e execution ID históricos não foram inventados. Para rastreabilidade, o
checksum do arquivo é a identidade técnica imutável.

## Portão 3 — Provas da Matriz

**Objetivo:** liberar a operação que gera caixa sem esperar a conclusão comercial dos parceiros.

### 3.1 Testes automatizados obrigatórios

- build e análise estática;
- unitários;
- integração Docker com banco vazio;
- invariantes de raw events;
- integração de compras;
- integração de venda varejo e atacado;
- estoque e custo médio;
- financeiro e ledger;
- concorrência/idempotência;
- permissões da Matriz;
- instalação e rollback de migration.

### 3.2 E2E autenticado da Matriz

Executar com um usuário real de teste:

1. login;
2. cadastrar fornecedor;
3. cadastrar produto ou selecionar catálogo;
4. registrar compra à vista;
5. registrar compra a prazo;
6. receber parcialmente e depois concluir;
7. conferir estoque e custo médio;
8. realizar venda;
9. confirmar caixa/contas/ledger;
10. cancelar operação controlada;
11. conferir estorno e retorno de estoque;
12. validar permissões de colaborador.

### 3.3 Reconciliação matemática

Para cada cenário:

```text
Estoque final = estoque inicial + entradas - saídas ± ajustes
Contas a pagar = compras a prazo - pagamentos - cancelamentos
Caixa = recebimentos reais - pagamentos reais
Resultado por competência = receitas reconhecidas - custos reconhecidos - despesas
Débitos do ledger = créditos do ledger
```

**Saída obrigatória:** evidências salvas com IDs das transações e valores reconciliados.

### 3.4 Registro de execução do Portão 3 — 27/08/2026

**Estado:** COMPLETO E APROVADO NA VERSÃO IMPLANTADA. Foram encontrados e
corrigidos dois defeitos reais. O primeiro impedia de forma intermitente a baixa
de uma compra a prazo; o segundo deixava o modal da venda mostrar um estoque
antigo até o navegador ser atualizado. Ambos possuem testes de regressão e foram
comprovados no smoke pós-deploy do commit
`bcfa2aaa9b40cd5979f95f8e00c8c53143860aa4`.

#### Cenários transacionais executados no banco de produção controlado

- Linha de base da variante: `90/90-18 · Metzeler · meia-vida`, 2 pneus a custo
  médio de R$ 15,00.
- Compra à vista e recebida: 2 pneus a R$ 12,50. Estoque passou de 2 para 4 e o
  custo médio para R$ 13,75.
- Compra a prazo: 3 pneus a R$ 14,00, sem entrada antecipada no estoque.
- Recebimento parcial: 1 aceito e 2 recusados. Obrigação e compra foram reduzidas
  de R$ 42,00 para R$ 14,00; estoque passou de 4 para 5; custo médio foi para
  R$ 13,80.
- Venda à vista: 1 pneu por R$ 99,00. Estoque passou de 5 para 4; caixa e receita
  foram reconhecidos e o custo de R$ 13,80 foi baixado.
- Venda fiada: 1 pneu por R$ 99,00. Criou conta a receber e não alterou o caixa.
  Ao confirmar o recebimento, o valor entrou no caixa e zerou a conta a receber.
- Cancelamento depois do recebimento: restaurou 1 pneu ao estoque, reverteu receita
  e custo e criou obrigação de devolver R$ 99,00 ao cliente. O caixa só diminuiu
  quando a devolução foi marcada como paga.
- Fechamento do estoque-alvo: 4 pneus a custo médio de R$ 13,80. A conta fecha por
  `2 + 2 + 1 - 1 - 1 + 1 = 4`.
- Fechamento global da amostra: 19 variantes, 37 pneus, nenhuma reserva e valor de
  estoque de R$ 462,20. O ledger possui 34 transações, R$ 1.448,30 em débitos e o
  mesmo valor em créditos, sem transação desbalanceada.

#### Permissões e sessões

- Login administrativo de proprietário: HTTP 200.
- Login da mesma identidade em `/operacao`: HTTP 200, escopo `matrix`, módulos de
  operação resolvidos pelo servidor e estoque com 19 variantes.
- Usuário temporário de vendedor com somente Vendas: Vendas retornou HTTP 200,
  Estoque retornou HTTP 403 e o painel administrativo retornou HTTP 401.
- Depois da revogação: a sessão existente e um novo login retornaram HTTP 401.
  O usuário restrito de prova foi removido da operação ao fim do teste.
- A conta temporária de proprietário usada para orquestrar o E2E também foi
  revogada; novos logins no painel e no `/operacao` retornaram HTTP 401.

#### Reconciliação final

- Estágios financeiros 3 e 5: verdes, zero erro.
- Estágio 4: amarelo somente por 6 campanhas de marketing ainda sem classificação;
  zero divergência monetária.
- Sinais globais: zero fonte duplicada, zero órfã, zero transação desbalanceada e
  zero data de caixa ausente.
- Agenda financeira: R$ 0,00 a receber e R$ 36,00 a pagar, dos quais R$ 14,00 são
  a compra parcial deste E2E e R$ 22,00 pertencem a uma compra de teste anterior.

#### Reparos produzidos

1. A baixa agora seleciona explicitamente `accounts_payable` na obrigação de
   compra, em vez de poder escolher a partida de `inventory_in_transit` da mesma
   transação. O cenário parcial foi reproduzido em PostgreSQL e passou nos 6 testes
   de integração do módulo.
2. A venda de balcão consulta novamente `/admin/api/dashboard/produtos` antes de
   abrir. Se a atualização falhar, a tela não permite iniciar a venda sobre saldo
   antigo. Há regressão unitária para sucesso e falha.
3. A data de vencimento serializada à meia-noite UTC agora é mostrada como dia
   civil, sem recuar um dia no navegador brasileiro.
4. A `0214` tornou a saúde de Compras consciente dos ajustes de quantidade, sem
   mascarar diferença real. Foi aplicada após dry-run e validada no banco atual.

#### Smoke pós-deploy — 28/08/2026

- Coolify publicou o commit
  `bcfa2aaa9b40cd5979f95f8e00c8c53143860aa4` e concluiu o rolling update.
- `/livez`: HTTP 200, com o mesmo SHA do deploy.
- `/readyz`: HTTP 200; banco, schema, banco restrito do parceiro e continuidade
  operacional aprovados. Schema confirmado na versão `0214`.
- `/operational-healthz`: HTTP 200, sem alerta crítico. O estado degradado decorre
  somente de jobs periódicos ainda não observados e da ingestão do Chatwoot
  propositalmente inativa nesta fase.
- Login do proprietário e carregamento de todos os módulos autorizados: aprovados.
- Venda aberta sem atualizar o navegador: a variante E2E mostrou os 4 pneus atuais
  do galpão, comprovando a atualização do estoque no modal.
- A obrigação E2E de R$ 14,00, com vencimento civil exibido corretamente em
  `30/09/2026`, foi paga por PIX no Caixa principal. O contas a pagar caiu de
  R$ 36,00 para R$ 22,00 e o caixa caiu exatamente R$ 14,00. As duas obrigações
  anteriores de R$ 11,00 permaneceram intactas.
- Livro financeiro: 35 transações, zero fonte duplicada, zero órfã, zero transação
  desbalanceada e zero data de caixa ausente.
- Auditoria canônica somente leitura: `PASS`; integridade raw, normalizada, RLS,
  privilégio mínimo e isolamento de sessões aprovados.
- Reconciliação financeira: etapas 3 e 5 verdes; etapa 4 sem erro monetário e
  amarela somente pelas 6 campanhas de marketing ainda sem classificação.
- Painel financeiro: 9 de 9 origens reconciliadas e todas com diferença de R$ 0,00.

**Veredito do Portão 3:** APROVADO. Não resta bloqueador de Matriz neste portão.
As campanhas não classificadas são uma pendência operacional do Portão 4 e não
alteram caixa, competência, estoque ou contas a pagar.

## Portão 4 — Chatwoot e Bot

**Objetivo:** reativar automação sem colocar todos os clientes em risco.

### 4.1 Ingestão

1. Enviar um webhook real assinado.
2. Confirmar persistência raw-first.
3. Confirmar deduplicação pela entrega.
4. Confirmar normalização assíncrona.
5. Reenviar o mesmo evento e provar ausência de duplicidade.
6. Verificar que dados `test` nunca entram em `prod`.

### 4.2 Sombra

1. Ativar o worker sem envio externo.
2. Comparar respostas propostas com o atendimento humano.
3. Medir erros de estoque, unidade, preço e compatibilidade.
4. Corrigir antes de ativar o outbox.

### 4.3 Canário

1. Restringir a poucas conversas/unidade por mecanismo efetivamente lido pelo runtime.
2. Ativar outbox apenas no canário.
3. Monitorar duplicidade, latência e respostas incorretas.
4. Expandir progressivamente.

**Saída obrigatória:** webhook, normalização, decisão e envio comprovados ponta a ponta.

### 4.4 Adendo operacional — bot temporariamente desligado

Configuração segura de manutenção enquanto o canário não estiver implementado:

```env
AGENT_V2_WORKER_ENABLED=false
BOT_OUTBOX=false
MATRIZ_RECEIPT_AI=false
```

Efeito prático:

| Variável | Com `false` | O que continua funcionando |
|---|---|---|
| `AGENT_V2_WORKER_ENABLED` | o bot principal não gera nem responde conversas | Chatwoot humano, recebimento do webhook, raw-first e normalização estrutural |
| `BOT_OUTBOX` | nenhum envio automático do bot sai para o Chatwoot após a publicação do hardening do Portão 4 | respostas propostas podem ser gravadas em sombra; mensagens humanas continuam funcionando |
| `MATRIZ_RECEIPT_AI` | comprovantes não são interpretados pela IA | conferência e aprovação humana permanecem disponíveis |

Alertas obrigatórios:

- `OPENAI_API_KEY` ausente é aceitável somente enquanto nenhuma função que exige IA estiver ligada.
- `OPENAI_API_KEY=` com valor vazio derruba a aplicação na inicialização; remover a linha vazia ou gravar um segredo válido.
- Antes do hardening deste portão, `PHOTO_REQUESTS` e `SATISFACTION_SURVEY` podiam contornar a outbox. O código foi corrigido; a garantia de silêncio total só vale depois do deploy desse commit.
- Não religar o bot com `AGENT_V2_CONVERSATION_IDS=*` como primeiro teste.

Procedimento obrigatório para reativação:

1. Fazer o dispatcher aplicar de fato `AGENT_V2_CONVERSATION_IDS` antes de enfileirar qualquer conversa.
2. Fazer a inicialização exigir chave válida quando `AGENT_V2_WORKER_ENABLED=true` **ou** `MATRIZ_RECEIPT_AI=true`.
3. Normalizar segredo vazio como ausente e emitir erro claro, sem ciclo de reinicialização ambíguo.
4. Criar testes para lista vazia, conversa permitida, conversa não permitida e curinga `*`.
5. Começar com uma única conversa de teste identificada, nunca com `*`.
6. Ligar `AGENT_V2_WORKER_ENABLED=true` mantendo o envio externo bloqueado e validar em sombra.
7. Ligar `BOT_OUTBOX=true` somente para o canário e comprovar idempotência, retry e ausência de resposta duplicada.
8. Expandir a lista gradualmente; usar `*` somente após aprovação formal do canário.

**Regra de parada:** se houver resposta para conversa fora da lista, duplicidade, erro de estoque/preço/unidade ou falha de entrega, voltar imediatamente às três flags `false` e investigar antes de nova tentativa.

### 4.5 Registro de execução do Portão 4 — 28/08/2026

#### Prova técnica de ingestão no banco novo

Foi executado um webhook HTTP assinado contra a rota real do Fastify, usando
`environment=test` e o banco novo. O ensaio não escreveu em `prod`.

| Prova | Resultado |
|---|---|
| HMAC inválido | rejeitado com HTTP 401 |
| contato, conversa e mensagem assinados | aceitos com HTTP 200 |
| raw-first | evento observado como `pending` antes da normalização |
| normalização | 1 contato, 1 conversa e 1 mensagem criados |
| repetição da mesma entrega | HTTP 200 sem nova linha |
| deduplicação | 1 `raw_event` e 1 claim para a entrega repetida |
| isolamento | `prod` permaneceu em 1.103 eventos antes e depois |
| automação desligada | 0 jobs do agente e 0 mensagens de saída |

**Veredito técnico de 4.1:** o encanamento aplicação → raw → core está
aprovado. Ainda falta a prova de origem externa Chatwoot → domínio público →
aplicação. A consulta local à API do Chatwoot recebeu 401 porque a credencial
local não é a credencial trancada do Coolify; nenhum segredo foi copiado ou
exposto para contornar isso.

#### Hardening implementado

1. `AGENT_V2_CONVERSATION_IDS` passou a ser aplicado no dispatcher, no
   reconciliador, no worker, na criação de mensagens auxiliares e na retirada
   da outbox.
2. Lista vazia fecha todas as conversas; `*` abre todas somente quando usado
   sozinho e de forma explícita.
3. Produção rejeita IDs numéricos do Chatwoot no canário e exige UUIDs internos
   de `core.conversations`.
4. `BOT_OUTBOX=false` grava apenas a proposta em `agent.turns`, com
   `shadow:no_external_send`, sem chamar o Chatwoot.
5. Envio direto de texto e anexo foi bloqueado também nas funções de baixo
   nível; fotos e pesquisas não contornam mais a outbox.
6. Chave OpenAI vazia é normalizada como ausente. A aplicação exige chave
   quando Agent V2 ou leitura de comprovante por IA estiverem ligados.
7. O modo sombra não exige credenciais de envio do Chatwoot; o modo de envio
   exige.

Validações locais após o hardening:

- build/TypeScript: aprovado;
- 297 arquivos e 1.471 testes unitários: aprovados;
- 60 arquivos e 292 testes de integração Docker: aprovados;
- testes focados do Portão 4: 58 aprovados;
- migration: não necessária; o contrato atual do banco já comporta sombra,
  escopo e outbox.

#### Resultado do primeiro ensaio em sombra

O ensaio foi restrito a uma única conversa de `environment=test`, com
`BOT_OUTBOX=false`. O job foi selecionado somente dentro do UUID permitido e
nenhuma saída foi criada. A geração parou de forma segura com
`OPENAI_API_KEY not set`, pois a estação local não possui a chave que está
trancada no Coolify.

Isso é um **bloqueio operacional**, não um vazamento nem envio indevido:

- mensagens externas: 0;
- outbox criada: 0;
- jobs processados fora do escopo: 0;
- dados de produção alterados pelo ensaio: 0.

#### Sequência restante para fechar o Portão 4

1. Publicar o hardening mantendo as três flags `false`.
2. Fazer smoke da Matriz e confirmar que o processo permanece saudável.
3. Confirmar no Coolify uma `OPENAI_API_KEY` válida, sem copiá-la para logs ou
   arquivos locais.
4. Enviar uma mensagem controlada por um contato autorizado ao Chatwoot e
   confirmar incremento de `raw.raw_events` no domínio público.
5. Obter o UUID interno dessa conversa em `core.conversations`; não usar o ID
   numérico do Chatwoot.
6. Configurar somente esse UUID em `AGENT_V2_CONVERSATION_IDS`, ligar
   `AGENT_V2_WORKER_ENABLED=true` e manter `BOT_OUTBOX=false`.
7. Avaliar em sombra respostas sobre medida, estoque, unidade, preço e
   compatibilidade. Reprovar qualquer invenção ou troca de unidade.
8. Somente depois ligar `BOT_OUTBOX=true` para a mesma conversa, comprovar uma
   entrega, o eco do Chatwoot, idempotência e ausência de duplicidade.
9. Manter o canário restrito antes de qualquer expansão. `*` continua proibido
   até aprovação formal.

**Veredito atual do Portão 4:** EM ANDAMENTO. O código de segurança e a prova
técnica de ingestão estão aprovados; o ingresso externo, a qualidade do LLM em
sombra e o envio canário pós-deploy ainda faltam. O bot permanece desligado.

### 4.6 Decisão de continuidade — 28/08/2026

O proprietário decidiu adiar a reativação do Bot para priorizar a entrada da
Matriz em produção controlada. Portanto, os passos abaixo **não foram
executados** e não devem ser tratados como aprovados:

- não foi configurado um UUID interno canário em
  `AGENT_V2_CONVERSATION_IDS`;
- `AGENT_V2_WORKER_ENABLED` não foi ligado para o ensaio em sombra;
- respostas do LLM não foram avaliadas em uma conversa real;
- `BOT_OUTBOX` não foi ligado e nenhum envio canário foi autorizado;
- `MATRIZ_RECEIPT_AI` permanece fora do ensaio do Bot e não foi reativada.

Estado operacional decidido para esta pausa:

```ini
AGENT_V2_WORKER_ENABLED=false
BOT_OUTBOX=false
MATRIZ_RECEIPT_AI=false
```

Essa pausa não bloqueia Vendas, Compras, Estoque, Financeiro nem as demais
funções determinísticas da Matriz. A ingestão raw-first, a normalização e os
gatilhos analíticos continuam independentes do envio automático do Bot. O
Portão 4 permanece **EM ANDAMENTO / ADIADO**, e deverá ser retomado no item 3 da
sequência restante antes de qualquer resposta automática a clientes.

## Portão 5 — Operação e recuperação

**Objetivo:** conseguir detectar e recuperar falhas.

**Estado:** ADIADO POR DECISÃO DO PROPRIETÁRIO. Não aprovado.

Em linguagem operacional, este portão deve provar quatro coisas:

1. perceber rapidamente quando aplicação, banco, fila ou integração pararem;
2. avisar o responsável sem depender de alguém descobrir o problema por acaso;
3. possuir backup recente, identificado e protegido;
4. restaurar esse backup em ambiente separado e demonstrar que login, banco e
   operações essenciais voltam a funcionar.

### 5.1 Monitoramento mínimo

Alertar sobre:

- aplicação fora do ar;
- banco indisponível;
- uso de conexões próximo ao limite;
- partições futuras ausentes;
- raw events parados ou falhando;
- dead letters abertas;
- jobs presos;
- outbox presa;
- Chatwoot rejeitando chamadas;
- Meta Sync/CAPI falhando;
- uso de disco e memória;
- divergência do ledger;
- versão do banco diferente da versão exigida.

### 5.2 SLO inicial sugerido

| Item | Meta inicial |
|---|---|
| Disponibilidade da Matriz | 99,5% mensal |
| `/livez` | responde em até 1 segundo |
| `/healthz` | responde em até 3 segundos |
| Webhook | 2xx rápido após raw-first |
| Normalização | p95 abaixo de 5 minutos |
| Venda/compra | p95 abaixo de 2 segundos, exceto integrações externas |
| Dead letters não tratadas | zero por mais de 24 horas |
| Divergência do ledger | zero |

### 5.3 Backup e restauração

1. Criar backup identificado por data e commit.
2. Restaurar em ambiente isolado.
3. Executar o schema gate.
4. Fazer login e smoke.
5. Registrar duração e passos.

**Saída obrigatória:** relatório de restauração aprovado.

### 5.4 Decisão de continuidade — 28/08/2026

O proprietário decidiu não executar o Portão 5 neste momento e seguir para a
consolidação das interfaces. A decisão não equivale à aprovação das provas de
monitoramento, backup ou restauração.

Riscos conscientemente aceitos durante o adiamento:

- indisponibilidades podem continuar sendo percebidas manualmente;
- não existe, neste portão, comprovação registrada de alerta automático;
- possuir backup não foi tratado como prova de que ele restaura corretamente;
- o tempo necessário para recuperar a aplicação ainda não foi medido.

O Portão 5 permanece documentado para retomada futura e não impede alterações
de interface que preservem os motores transacionais já auditados.

## Portão 6 — Consolidação das interfaces

**Objetivo:** reduzir manutenção sem mexer no coração financeiro.

**Estado:** APROVADO em 01/09/2026.

### Progresso registrado até 2026-09-01

| Tela | Escopo | Estado | Evidência | Proteção da Matriz |
|---|---|---|---|---|
| Resumo | Parceiro | Concluída | `30add3b` até `ff00090` | Bloco próprio `isPartnerPanel()`; Resumo da Matriz permanece separado |
| Vendas | Parceiro | Concluída | `0c7cafb` | Blocos e módulos distintos para parceiro e Matriz |
| Retiradas | Parceiro e Matriz | Concluída | `ada6383` | Layout compartilhado, mas APIs, escopo de dados e motores transacionais continuam separados |
| Compras | Parceiro | Concluída e validada em produção | deploy de 2026-08-28 + smoke autenticado de 2026-08-28 | Tela própria `isPartnerPanel()`; Compras da Matriz permanece no bloco `isMatrixPanel()` |
| Estoque | Parceiro | Concluída e validada em produção | deploy incluído no SHA `4a5dc4c` + smoke autenticado de 2026-09-01 | Tela própria `isPartnerPanel()`; galpão da Matriz e seus custos permanecem no bloco `isMatrixPanel()` |
| Logística | Parceiro | Concluída e validada em produção | `4a5dc4c` + smoke autenticado de 2026-09-01 | Tela própria `isPartnerPanel()`; rotas e comprovantes da Matriz permanecem no bloco `isMatrixPanel()` |

As telas concluídas preservam os motores existentes. O redesenho não cria uma
segunda regra de estoque, caixa ou financeiro no navegador. Em Retiradas, o
parceiro continua usando as rotas `/parceiro/:slug/api/retiradas`, enquanto a
Matriz continua usando `/admin/api/retiradas`.

Em Compras, fornecedores locais e remessas criadas pela Matriz aparecem na
mesma fila da unidade, com a origem identificada. O parceiro não pode cancelar
nem alterar a quantidade de uma remessa da Matriz. A conferência física reutiliza
`/parceiro/:slug/api/operacao/compras/:purchaseId/receber`, o mesmo motor do app
Operação; portanto, o estoque só aumenta depois da confirmação. A leitura aceita
a permissão Compras ou Financeiro. O cadastro exige a permissão Compras e o
cancelamento continua exclusivo do proprietário, pois reverte estoque e efeitos
financeiros. Build, paridade do painel e 1.477 testes
unitários foram aprovados; não há migration nova. O teste de integração isolado
ficou pendente porque o Docker local não estava acessível à suíte nesta sessão.

Em Estoque, a interface do parceiro passou a mostrar somente o trabalho da loja:
saldo físico, reservado, disponível, mínimo, localização, situação, contagem e
histórico. A busca visível aceita medida ou marca; compatibilidade por moto e
identidade técnica continuam no Catálogo. O botão `Dar entrada` abre Compras,
preservando a regra de que o saldo só muda após a conferência física. Nenhum
detalhe técnico do bot é exibido ao borracheiro.

As ações simples `Novo pneu`, `Dar entrada`, `Corrigir saldo` e `Alterar preço`
seguem as permissões efetivas dos módulos Estoque e Compras, em vez de depender
somente do nome técnico `owner`. Isso permite que o operador autorizado da loja
faça o trabalho diário sem receber poderes de proprietário. O servidor continua
validando a permissão, isolando a unidade, preservando reservas e gravando o
histórico; configurações, gestão de acessos e cancelamentos sensíveis permanecem
exclusivos do proprietário.

Em Logística, a interface do parceiro passou a reunir fila, filtros, histórico,
detalhe do pedido e ações em uma composição simples de duas colunas. A entrega
continua nascendo de Vendas — não existe entrega solta — e Retiradas permanece
na aba própria. O operador escolhe o entregador, marca a saída, informa a forma
de pagamento na entrega, registra uma tentativa sem sucesso e confirma o retorno
físico separadamente. Somente a confirmação real da entrega movimenta estoque,
caixa e financeiro; a falha mantém a reserva protegida até o pneu voltar à loja.
Busca, WhatsApp, comprovante, paginação e ordem simples lembrada no aparelho foram
preservados. O resumo agora separa corretamente `Preparando` de `Retornos`.

O build e os 1.490 testes unitários passaram. Em 01/09/2026, com o Docker
acessível, as duas suítes de integração direcionadas foram repetidas e os 36 casos
passaram em PostgreSQL descartável. Os 13 testes unitários direcionados de
Logística e entregas também passaram após o deploy.

O Atendente V2 já usava a mesma fonte oficial da tela,
`commerce.partner_stock_levels`, com filtros obrigatórios por `environment`,
`unit_id` e `product_id`. Ele considera apenas estoque rastreado, não excluído e
com `quantity_on_hand - quantity_reserved` suficiente. Portanto, não foi criado
um segundo motor de busca. Os testes foram reforçados para provar o desconto das
reservas, o isolamento da unidade e a recusa quando o disponível não cobre a
quantidade. Build e 1.480 testes unitários foram aprovados; não há migration.
A suíte de integração com Postgres permaneceu pendente porque o Testcontainers
não encontrou um runtime Docker acessível, inclusive fora do sandbox.

#### Regra de preço da Rede e do parceiro

O modelo híbrido principal já está implementado e deve ser preservado:

- pedido originado pelo Bot/Rede usa o preço central vigente em
  `commerce.product_prices`;
- venda direta no balcão da unidade pode usar o preço local ou negociado pelo
  parceiro;
- instalação pode ser configurada por unidade;
- o parceiro pode deixar de receber pedidos da Rede por meio de
  `accepts_network_orders`;
- o frete do parceiro continua seguindo a regra padrão da Rede; ele ainda não é
  livre por unidade.

Essa separação mantém um preço comercial previsível para o cliente que chega
pela Rede sem retirar a autonomia do parceiro nas próprias vendas. O motor atual
não consulta o custo local antes de rotear um pedido e ainda não possui preço
mínimo aceitável nem margem mínima garantida por unidade. Essas duas proteções
ficam registradas como evolução futura, antes da expansão comercial da Rede, e
não bloqueiam a operação inicial da Matriz nem esta consolidação de interface.

O smoke autenticado em produção foi executado com o usuário Wallace na Unidade
Canário Teste, sem realizar mutações. A tela exibiu a remessa da Matriz de
R$ 45,00, um pneu aguardando conferência física, nenhuma conta em aberto e o
detalhamento coerente do item. Vendas, Retiradas, Estoque, Logística, Financeiro
e Catálogo também carregaram com o escopo da mesma unidade.

Foram observados resíduos de console provenientes de blocos ocultos do painel
único: gráficos históricos da Compras da Matriz são inicializados fora do seu
escopo visível; o modal oculto de compatibilidade do Catálogo avalia um resumo
nulo; e dois nomes de ícones não existem no pacote Lucide embarcado. Esses pontos
ficam registrados como saneamento do shell compartilhado e não invalidam a tela
Compras do parceiro, cuja API, dados, layout e ações de leitura foram aprovados.

### Fechamento do Portão 6 — 01/09/2026

O smoke autenticado foi executado em produção com Wallace, na Unidade Canário
Teste, sem realizar mutações. Vendas, Retiradas, Compras, Estoque, Logística,
Financeiro e Catálogo carregaram com o escopo da unidade e sem mensagem visível de
falha. A ausência de Resumo e Colaboradores nesse acesso corresponde às permissões
efetivas do usuário e não a erro de renderização.

Na Logística, os quatro indicadores ficaram na mesma linha em 1.738 px; a lista
ocupou a coluna esquerda e o detalhe a coluna direita. Histórico e filtros foram
exercitados sem gerar erro novo. Em 390 px, a tela empilhou os blocos sem rolagem
horizontal (`scrollWidth = 390`) e preservou os quatro indicadores. O SHA em
produção era `4a5dc4c`; `/livez`, bancos e schema estavam íntegros. Os avisos
operacionais de ingestão Chatwoot e observação do job de partições pertencem a
outros portões e não foram causados pela consolidação visual.

Os 14 erros Alpine capturados na carga já eram os resíduos conhecidos de blocos
ocultos de Compras da Matriz e do modal de compatibilidade do Catálogo. A
navegação completa não acrescentou nenhum erro. A correção desses resíduos segue
para o Portão 7, sem bloquear o parceiro.

**Veredito do Portão 6:** APROVADO. O painel moderno é a superfície web oficial
do parceiro; `/operacao` permanece a superfície móvel oficial. A remoção física
dos assets legados será feita separadamente e de forma comprovada no Portão 7.

### Estado final desejado

- `/admin/painel`: gestão da Matriz e gestão web do parceiro conforme permissões.
- `/operacao`: operação diária responsiva para Matriz e parceiro.
- `/parceiro/:slug/`: removido somente depois da paridade e do período de transição.

### Estratégia

1. Congelar novas funcionalidades no painel antigo.
2. Inventariar cada tela, endpoint, ação e permissão antiga.
3. Classificar como reutilizar, adaptar, criar, descartar ou já atendido por `/operacao`.
4. Migrar apenas a interface; manter os mesmos motores no servidor.
5. Rodar paridade automatizada e E2E por módulo.
6. Redirecionar uma unidade canário.
7. Observar por um ciclo operacional completo.
8. Remover assets antigos em release separada.

### Modularização restante do painel moderno

O JavaScript já usa módulos-fábrica e possui gate de 300 linhas. Portanto, não se deve refazer essa obra nem trocar o compositor Alpine. O trabalho restante é principalmente organizar o **HTML-fonte**:

```text
painel/templates/
├── shell/
│   ├── sidebar.html
│   ├── topbar.html
│   └── modais-globais.html
├── matriz/
│   ├── resumo.html
│   ├── bot.html
│   ├── vendas.html
│   ├── compras.html
│   ├── estoque.html
│   ├── logistica.html
│   ├── financeiro.html
│   ├── rede.html
│   ├── marketing.html
│   ├── colaboradores.html
│   └── catalogo.html
└── parceiro/
    ├── resumo.html
    ├── vendas.html
    ├── retiradas.html
    ├── compras.html
    ├── estoque.html
    ├── logistica.html
    ├── financeiro.html
    ├── colaboradores.html
    └── catalogo.html
```

Um montador determinístico, executado no build, gera o mesmo `painel/public/index.html` estático entregue hoje. O navegador pode continuar carregando os módulos JavaScript na ordem fixa atual; não é necessário introduzir carregamento dinâmico de telas.

Também devem ser mantidas as provas existentes de paridade, colisão Alpine, rotas e tamanho. Cálculo financeiro não pode ser reimplementado no navegador.

**Saída obrigatória:** duas interfaces oficiais, sem terceira implementação ativa.

## Portão 7 — Limpeza controlada do repositório

**Objetivo:** remover dívida sem apagar provas ou ferramentas úteis.

**Estado:** EM ANDAMENTO desde 01/09/2026.

### Registro de início — 01/09/2026

O inventário inicial encontrou 1.653 arquivos rastreados e 129 entradas locais
não rastreadas ou ignoradas. O núcleo oficial permanece identificável: `src/`,
`db/`, `painel/`, `parceiro/`, `tests/`, `segments/` e os arquivos de build.
Nenhuma migration, backup, script ou asset foi removido nesta etapa.

Dos 220 scripts presentes na pasta, 130 são rastreados e 90 são locais. Entre os
rastreados há 55 provas/testes, 21 auditores de leitura, 26 ferramentas de mutação
e 28 utilitários. Somente 17 não possuem referência textual no código, CI ou
documentação; ausência de referência não autoriza remoção, pois ferramentas
operacionais também podem ser executadas manualmente.

O `.dockerignore` local foi validado com um build Docker completo: contexto de
6,97 MB, compilação TypeScript/Tailwind aprovada e imagem final gerada. Sua
versionagem é o primeiro candidato não destrutivo deste portão.

Dois worktrees temporários e limpos foram confirmados dentro de `tmp/`:
`fix-drawer` (131,00 MB) e `deploy-main` (8,16 MB). Ambos os commits continuam
alcançáveis por `main` e por referências remotas. Após confirmação explícita,
ambos foram removidos com `git worktree remove`, liberando 139,16 MB. O build e
os 1.493 testes unitários, distribuídos em 302 arquivos, passaram depois da
limpeza.

Foram localizados 11 arquivos de backup `.dump`/`.tgz`, somando 33,20 MB; três
dumps têm tamanho zero. Nenhum deles será apagado antes da identificação,
checksum e política de retenção.

Na segunda triagem, os conteúdos restantes foram separados sem remoção:
backups em `.codex-tmp/` e `output/`; resultados JSON de auditoria em `tmp/`;
conceitos visuais e documentos em `output/`; logs locais; e 13 mocks/previews em
`painel/public/`. Esses 13 arquivos não tinham referência rastreada e foram
retirados do runtime sem exclusão: estão preservados em
`output/archive/painel-public-mockups-2026-09-01/`, com índice de tamanho e
SHA-256. Backups, auditorias e os demais conceitos visuais continuam intocados.
As pastas locais `output/` e `.codex-tmp/` foram adicionadas ao `.gitignore`
para evitar commits acidentais, sem apagar seu conteúdo.

### Classificação obrigatória

| Classe | Tratamento |
|---|---|
| Runtime atual | manter e testar |
| Ferramenta operacional | manter com cabeçalho e segurança |
| Auditoria somente leitura | manter e padronizar |
| Migração histórica | imutável |
| Teste/manual de laboratório | mover para área de laboratório |
| Preview/mock | arquivar ou remover após aprovação visual |
| Script destrutivo | retirar do caminho comum e exigir confirmação forte |
| Código sem referência | provar ausência de uso antes de remover |

### Regras

- Não apagar migrations aplicadas.
- Não alterar checksums históricos.
- Não apagar scripts durante a mesma release que muda regra financeira.
- Não misturar limpeza estética, migration e mudança contábil no mesmo PR.
- Preservar documentação de auditoria e incidentes.

### Separação posterior do HTML

Esta atividade só começa depois do canário estável da Matriz:

1. extrair uma única aba-piloto sem alterar seu conteúdo;
2. gerar o `index.html` no build;
3. comparar estrutura, bindings e comportamento com a versão anterior;
4. executar provas de paridade e E2E da aba;
5. repetir uma aba por PR;
6. manter os módulos JavaScript e o compositor Alpine existentes;
7. não combinar o PR com migration ou mudança financeira.

**Saída obrigatória:** repositório navegável e nenhuma ferramenta perigosa sem proteção.

---

## 7. Pipeline obrigatório de cada release

```text
1. Revisão do diff
2. Manifesto de migrations
3. Typecheck
4. Build
5. Testes unitários
6. Testes de integração em banco limpo
7. Provas de rotas, pools e permissões
8. Provas financeiras/estoque
9. Backup identificado
10. Aplicação da migration compatível
11. Deploy do SHA exato
12. Smoke pós-deploy
13. Reconciliação
14. Observação do canário
```

O Coolify mostrar “Rolling update completed” prova apenas que o container subiu. Não prova que vendas, banco ou integrações funcionam.

---

## 8. Smoke pós-deploy obrigatório

### Infraestrutura

- `/livez` retorna 200;
- `/healthz` retorna 200 sem crítico;
- SHA implantado corresponde ao aprovado;
- versão do banco corresponde ao código;
- nenhuma repetição de crash nos logs.

### Matriz

- login do proprietário;
- abertura do painel;
- leitura de compras, estoque e financeiro;
- venda controlada;
- conferência de estoque e ledger;
- revogação de sessão de colaborador.

### Integrações

- Chatwoot assina e entrega webhook;
- Meta Sync executa quando habilitado;
- nenhuma função desligada tenta chamar segredo ausente.

### Parceiro, quando entrar no escopo

- login com sessão `ps_`;
- dados somente da unidade;
- venda pelo `/operacao`;
- estoque e financeiro locais;
- tentativa de acesso cruzado retorna 403/404;
- logout e revogação encerram a sessão.

---

## 9. Rollback seguro

### Aplicação

Rollback para imagem anterior é permitido quando:

- a migration nova foi expansiva e retrocompatível;
- o código anterior entende o schema presente;
- nenhuma coluna antiga foi removida;
- o smoke do rollback é executado.

### Banco

Não fazer “migration para trás” improvisada em produção. Preferir:

1. desativar a nova funcionalidade;
2. voltar a aplicação;
3. preservar colunas/tabelas novas sem uso;
4. criar migration corretiva posterior.

Restauração total de banco é último recurso e exige avaliação de perda de dados ocorrida após o backup.

---

## 10. Responsabilidades

### Pode ser executado tecnicamente no repositório

- validação de dependências das flags;
- ledger e gate de migrations;
- testes automatizados;
- organização dos módulos;
- scripts de auditoria e smoke;
- documentação de deploy/rollback;
- correções de código e banco;
- paridade das interfaces.

### Exige ação do proprietário

- rotacionar segredos nas contas externas;
- controlar DNS e Coolify;
- aprovar backup e restauração;
- decidir o destino da unidade canário;
- executar aceite operacional de negócio;
- escolher quando ativar Bot e parceiros;
- confirmar valores e resultados reais da operação.

### Recomendado contratar externamente antes de grande escala

- pentest independente;
- revisão LGPD e RIPD;
- teste de carga prolongado;
- auditoria contábil/fiscal conforme o modelo real da empresa.

---

## 11. Ordem prática recomendada

### Bloco A — liberar a Matriz com segurança

1. Rotação de segredos.
2. Desligamento coerente das funções de IA ainda sem chave.
3. Ledger de migrations e gate 0212+.
4. Docker, integração e instalador do zero.
5. Backup restaurado.
6. E2E completo da Matriz.
7. Deploy e canário com poucas operações.
8. Reconciliação diária durante o início.

### Bloco B — reativar o Bot

1. Webhook real no banco novo.
2. Ingestão e deduplicação.
3. Worker em sombra.
4. Chave nova e controles de custo.
5. Canário restrito.
6. Outbox e expansão gradual.

### Bloco C — terminar parceiros

1. Completar telas web modernas.
2. Manter `/operacao` como operação mobile.
3. Paridade e isolamento.
4. Canário de uma unidade.
5. Aposentar painel antigo.
6. Somente então comercializar a rede.

### Bloco D — limpeza final

1. Scripts.
2. Mocks e previews.
3. Código sem referência.
4. Variáveis obsoletas.
5. Separação dos templates HTML ainda concentrados; manter a modularização JavaScript existente.

---

## 12. Critério final de autorização

| Área | Critério para aprovação |
|---|---|
| Segurança | todos os segredos expostos revogados |
| Banco | instalação do zero e histórico/checksum rastreável |
| Financeiro | reconciliação sem divergências |
| Estoque | entradas, saídas, reservas e estornos consistentes |
| Aplicação | build, unitários e integração aprovados |
| Navegador | E2E autenticado aprovado |
| Recuperação | backup restaurado e testado |
| Monitoramento | alertas testados |
| Chatwoot | webhook raw-first comprovado |
| Bot | sombra e canário aprovados antes do envio geral |
| Parceiros | isolamento e paridade aprovados por unidade |

### Estados possíveis

- **BLOQUEADO:** existe P0, migration desconhecida, divergência financeira ou restauração impossível.
- **CANÁRIO AUTORIZADO:** P0 resolvidos, integração/E2E aprovados e monitoramento ativo.
- **PRODUÇÃO CONTROLADA:** canário reconciliado sem divergências.
- **PRODUÇÃO GERAL:** restauração, segurança, carga e operação comprovadas.

---

## 13. Veredito atual

| Componente | Situação |
|---|---|
| Núcleo financeiro e transacional | Forte; auditorias atuais aprovadas |
| Banco e objetos recentes | Presentes, mas sem trilha formal suficiente |
| Matriz | Portões 0–3 aprovados; disponível para canário operacional controlado |
| Bot | Desligado; Portão 4 em andamento, sem autorização de envio |
| Parceiros | Backend protegido; Portão 6 aprovado no canário autenticado |
| Operação mobile | Ativa, deve permanecer como superfície oficial |
| Deploy | Funcional, mas precisa de smoke e schema gate mais rigorosos |
| Recuperação | Não comprovada |
| Organização do projeto | Necessita consolidação gradual |

**Conclusão:** não reescrever o Farejador. Preservar os motores aprovados, consertar rastreabilidade e configuração primeiro, comprovar recuperação e só depois reduzir interfaces e legado. Esse caminho oferece confiança real sem colocar em risco os dias de auditoria já investidos.
