# Plano de consolidação e confiança para produção — Farejador

**Data:** 27 de agosto de 2026
**Escopo:** Matriz, Bot/Chatwoot, operação, rede de parceiros, banco, integrações, segurança, deploy e continuidade
**Objetivo:** transformar o sistema atual em uma plataforma previsível, recuperável e comprovadamente segura para dados reais, sem reescrita total e sem quebrar os fluxos financeiros já auditados.

---

## 1. Veredito executivo

O Farejador não é um conjunto de bancos ou servidores independentes. Hoje ele é um **monólito modular**, executado por um único processo principal, com **um banco Supabase** e conexões diferentes conforme o nível de privilégio.

O núcleo transacional está mais sólido do que a organização do repositório sugere:

- build e TypeScript aprovados;
- 1.457 testes unitários aprovados;
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
3. a suíte de integração com banco limpo ainda não foi executada;
4. a configuração da IA de comprovantes permite uma combinação inválida;
5. o banco novo ainda não comprovou a ingestão real do Chatwoot;
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

**Estado:** APROVADO ANTES DO DEPLOY, COM SMOKE PÓS-DEPLOY OBRIGATÓRIO. Foram
encontrados e corrigidos dois defeitos reais. O primeiro impedia de forma
intermitente a baixa de uma compra a prazo; o segundo deixava o modal da venda
mostrar um estoque antigo até o navegador ser atualizado. Ambos possuem testes de
regressão, mas o código ainda precisa ser publicado para a comprovação final.

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

#### Gate restante deste portão

Publicar o commit com os reparos acima e repetir: baixa dos R$ 14,00 da compra E2E,
abertura da venda sem recarregar a página, `/livez`, `/healthz`, login, permissões e
reconciliação. Até esse smoke, o Portão 3 está aprovado no código, mas não encerrado
na versão implantada.

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
| `BOT_OUTBOX` | a fila durável de saída do bot fica desligada | não é uma trava geral de mensagens; fluxos auxiliares habilitados podem enviar diretamente |
| `MATRIZ_RECEIPT_AI` | comprovantes não são interpretados pela IA | conferência e aprovação humana permanecem disponíveis |

Alertas obrigatórios:

- `OPENAI_API_KEY` ausente é aceitável somente enquanto nenhuma função que exige IA estiver ligada.
- `OPENAI_API_KEY=` com valor vazio derruba a aplicação na inicialização; remover a linha vazia ou gravar um segredo válido.
- `BOT_OUTBOX=false` não garante silêncio total. `PHOTO_REQUESTS`, `SATISFACTION_SURVEY` e outros fluxos habilitados devem ser auditados porque podem usar envio direto.
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

## Portão 5 — Operação e recuperação

**Objetivo:** conseguir detectar e recuperar falhas.

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

## Portão 6 — Consolidação das interfaces

**Objetivo:** reduzir manutenção sem mexer no coração financeiro.

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
| Matriz | Próxima de canário, ainda bloqueada pelos Portões 0–3 |
| Bot | Desligado; exige Portão 4 |
| Parceiros | Backend protegido; consolidação visual incompleta |
| Operação mobile | Ativa, deve permanecer como superfície oficial |
| Deploy | Funcional, mas precisa de smoke e schema gate mais rigorosos |
| Recuperação | Não comprovada |
| Organização do projeto | Necessita consolidação gradual |

**Conclusão:** não reescrever o Farejador. Preservar os motores aprovados, consertar rastreabilidade e configuração primeiro, comprovar recuperação e só depois reduzir interfaces e legado. Esse caminho oferece confiança real sem colocar em risco os dias de auditoria já investidos.
