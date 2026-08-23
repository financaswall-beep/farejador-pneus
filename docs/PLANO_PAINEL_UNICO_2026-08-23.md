# Plano — Painel único web (matriz + parceiro) · 2026-08-23

> **Documento de implementação, com decisões do dono já tomadas.**
> Base: banca de 3 especialistas (`seguranca`, `parceiro`, `matriz`) + revisão
> crítica do Codex + correções do dono. Tudo com arquivo:linha verificado.
>
> **Não há decisão arquitetural pendente**, exceto a marcada em §11.
> **Nada deve ser implementado antes de §4 (Portões) estar verde.**

---

## 1. Escopo — decidido pelo dono

### 1.1 O que ENTRA
Unificar o **sistema web desktop**: `painel/public` vira o frontend moderno
compartilhado. Matriz vê todos os módulos; parceiro vê **somente sua unidade**
e os módulos permitidos. `parceiro/public` (desktop legado) é aposentado
**somente após paridade e canário**.

O parceiro terá no desktop as versões **escopadas** de Resumo, Vendas, Estoque,
Clientes, Financeiro, Entregas, Equipe e Configurações, mais as exclusivas
**Retiradas** e **Bate-papo**.

### 1.2 O que NÃO entra
**`/operacao` permanece como está.** Continua sendo a interface operacional e
móvel, já unificada entre matriz e parceiros. **Não reescrever** os ~30 módulos
`painel/public/caixa-*.js`.

### 1.3 Estado final
Duas interfaces com **finalidades diferentes**, não duas implementações do
mesmo motor:

```
painel web moderno (desktop)      /operacao (mobile e frente rápida)
├── ms_  matriz administrativa    ├── cs_  funcionário
├── cs_  funcionário da matriz    └── ps_  parceiro
└── ps_  parceiro escopado
```

O servidor é a fonte única das regras. No parceiro, o desktop legado e o
`/operacao` já convergem no mesmo endpoint e motor transacional (§2.1).

---

## 2. ⚠️ Achados que contradizem o desenho — leia antes de propor

### 2.1 🟢 `/operacao` já separa Matriz e parceiro pelo local autenticado

O primeiro texto deste plano concluiu, incorretamente, que a ausência de
`withPartnerContext` em `src/admin/caixa/*.ts` significava que o parceiro móvel
usava o motor administrativo. O diretório pesquisado contém apenas o caminho da
**Matriz**. O navegador compartilhado troca rota e sessão conforme o local:

1. `route-operation-login.ts` emite `cs_` para Matriz e `ps_` por
   `mintPartnerSession` para parceiro, preservando `scope: 'partner'` e `slug`.
2. `caixa-core.js:153-156` faz `operationPath`: parceiro vira
   `/parceiro/:slug/api/:recurso`; Matriz permanece em `/api/caixa/:recurso`.
3. `caixa-checkout.js:201` envia a venda por `operationPath('vendas',
   '/api/caixa/vendas')`.
4. Portanto, parceiro cai em `registerPartnerSale(getPartnerContext(request),
   parsed.data)`, que usa `withPartnerContext` + role restrita + RLS.
5. Somente a Matriz entra em `createCaixaSale`/`registerWalkinOrder`; a sessão é
   `cs_` e `walkin-order.ts` restringe a venda à unidade `main`.

O desktop parceiro legado também chama `/parceiro/:slug/api/vendas`. Logo,
**desktop legado e `/operacao` do parceiro já compartilham o mesmo motor**. Não
existem duas famílias de escrita para a mesma venda do parceiro; existem dois
motores para dois domínios distintos: venda local do parceiro e varejo da
Matriz. Uma prova automática (§4) congela essa separação para impedir regressão.

As baterias existentes ainda comprovam os efeitos: `partner-portal.integration`
verifica baixa/reserva, financeiro, auditoria, idempotência e isolamento; e
`matriz-walkin-atomic.integration` verifica pedido, galpão e ledger da Matriz.

### 2.2 As 159 APIs da matriz não têm noção de "dono da unidade"
O censo executável do PR 3 registra **159 APIs**: 104 com
`requireAdminOwner` e 55 com `requireAdminAuth`, **nenhuma com `unit_id` no
escopo**. E **94 arquivos** de `src/admin/painel/` importam `persistence/db.js`;
**zero** usam `partnerPool`.

O baseline agora inclui método, URL e o guarda exato, além do contrato de
sessão `ms_`, papel e domínio da Matriz. Retirar o guarda ou trocar
`requireAdminOwner` por `requireAdminAuth` reprova o CI mesmo que método e URL
continuem idênticos.

Trocar o pool **não conserta query que nunca teve cláusula de dono**. Este é o
custo real da obra.

### 2.3 O muro de GRANT já tem furo hoje
`src/parceiro/auth.ts:6` importa o pool admin; `auth.ts:260-266` lê a tabela de
autorização por lá. `src/parceiro/queries.ts:3788-3800` **documenta** que toda
a Config da loja roda no pool admin. `src/parceiro/route-coverage.ts:3` importa
`admin/painel/queries-parceiros-rede.js`.

O censo automático do PR 2 encontrou **14 importadores** do pool admin
alcançáveis pelas 15 entradas `src/parceiro/route*.ts`, inclusive dois fora do
módulo parceiro. Eles estão congelados em `scripts/pools-herdados.json`: a
dívida pode diminuir, mas um novo importador reprova o CI e mostra a trilha
completa da rota até `src/persistence/db.ts`.

### 2.4 Colisão silenciosa entre os dois conjuntos de módulos
`painel/public/app.montagem.js:68-70` faz
`Object.defineProperties(out, Object.getOwnPropertyDescriptors(f()))` sobre 56
fábricas. O censo executável do PR 4 encontrou **uma colisão real no compositor
atual**: `comprasResumo:compras->comprasRelatorios`. Ela foi declarada
explicitamente porque o segundo módulo é hoje a fonte consolidada.

Existem nomes repetidos entre os dois painéis (`formatDateTime`, `init`,
`saleForm`, `stockForm`, `clientes`, `compras`, `apiHeaders`, `waLink`,
`deliveryAddr`, `mapsNavUrl`, `toE164Phone`), mas eles **ainda não colidem em
execução**, pois os painéis são montados separadamente. O risco aparece quando
módulos do parceiro entram no compositor único. A partir do PR 4, qualquer
colisão nova ou autorização que ficou obsoleta derruba o CI com origem e
destino, em vez de aceitar silenciosamente o último valor.

---

## 3. Contrato de segurança — obrigatório

### 3.1 Sessão e identidade
- **`panel_role` continua sendo requisito da sessão `ms_`.**
  `authenticateMatrizAdmin` (`src/admin/session.ts:58,79`) **não é afrouxada**.
- Os quatro prefixos seguem separados: `ms_` (`session.ts:9`),
  `ps_` (`src/parceiro/password.ts:20`), `cs_` (`src/admin/caixa/queries.ts:8`),
  `es_` (`src/admin/entregador/queries.ts:29`). Os três últimos gravam na mesma
  tabela `network.matriz_staff_sessions` — o que os separa é o **regex de
  prefixo dentro de cada validador**. Validador novo sem esse check = escalada
  entre portais.
- **Broker de login** decide qual sessão emitir conforme o workplace. Fonte
  única: `listOperationWorkplaces` (`src/admin/caixa/operation-auth.ts:69-150`),
  que já junta matriz e parceiro na mesma pessoa e devolve
  `workplaces[] { kind, role, modules{} }`. `publicOperationWorkplace` já omite
  o `tokenId`. **Não criar segunda tabela de permissão.**
- **PR 6 implementado:** `/admin/api/auth/login` autentica a pessoa uma vez,
  oferece somente workplaces ativos e usa ticket `pt_` opaco/de uso único na
  escolha. Matriz só recebe `ms_` após revalidar `panel_role`; parceiro recebe
  `ps_`; vendedor/entregador sem `panel_role` permanece fora do painel da
  Matriz. `/admin/api/auth/me` agora devolve `workplace` e módulos calculados
  no servidor. Nenhum `tokenId` é enviado ao navegador.
- `unit_id` é **derivado no servidor** e gravado na sessão. Nunca aceito de
  body, query, header ou path. O `:slug` da URL só serve para ser **comparado**
  (401 se divergir). Trocar de loja = **novo login**.

### 3.2 Rota, pool e banco
| camada | contrato |
|---|---|
| Menu | Deriva das permissões. **Cosmético — nunca citado como controle** |
| Rota | `/parceiro/:slug/api/*` é o **único** caminho do parceiro. Rota de matriz **não ganha** `if (isPartner)` |
| Pool | Escolhido pelo **tipo de sessão**, no `preHandler`. Perfil parceiro ⇒ `withPartnerContext` **obrigatório** |
| Banco | RLS nas 31 `partner_*` + denylist de GRANT (§3.3) |

**Regra dura:** o parceiro nunca é atendido por handler que roda no pool admin.
Se uma tela da matriz precisa aparecer para o parceiro, nasce **endpoint novo**
em `src/parceiro/` com a query escopada. **Reutiliza-se o componente visual,
nunca o handler.**

As 14 exceções herdadas do §2.3 são dívida explicitamente registrada, não
precedente para código novo. O gate `prova-arquitetura-pools` impede que essa
superfície aumente e exige reduzir o baseline quando uma exceção é corrigida.

**Pool + GUC sempre em par:** as policies são estritas
(`src/parceiro/db.ts:47-50`, `IS NOT NULL AND …`). Pool restrito **sem**
`withPartnerContext` (`db.ts:56-74`) = **zero linhas**, não "as do parceiro".

### 3.3 Política de GRANT
- **Preservar hash + lista exata** do conjunto permitido em
  `scripts/baseline-grants-parceiro.json` — mesma disciplina de
  baseline que a casa usa em paridade e rotas: quem muda **regrava DE PROPÓSITO
  no mesmo commit**, com o delta na mensagem.
- **Denylist explícita**, verificada além do hash: `commerce.wholesale_*`,
  `commerce.matriz_*`, `network.commission_entries`, `network.commission_entry_events`,
  `finance.matriz_ledger_*`. Zero grants — hoje confirmado.
- **Conferir atributos da role**: `LOGIN`, `NOSUPERUSER`, `NOINHERIT`,
  `NOCREATEROLE`, `NOCREATEDB`, `NOREPLICATION` e `NOBYPASSRLS`.
- **Baseline atualizado conscientemente para 71 grants**, incluindo o
  `SELECT ON commerce.tire_specs` criado pela `0202` e o único `INSERT` na
  telemetria técnica do canário criado pela `0203`.
  SHA-256 atual: `59ef335494b84faa0b35855c18b14a1a386aa2962e2ddcf39ad93d2eaa8b3ff8`.
  Algoritmo: ordenar `schema.tabela:PRIVILÉGIO:IS_GRANTABLE`, unir com LF e
  calcular SHA-256 em UTF-8. A denylist verifica privilégios efetivos de tabela
  **e de coluna**, inclusive os herdados de `PUBLIC`; portanto um grant parcial
  não consegue passar escondido.

### 3.4 Proibições
- **Não** conceder GRANT nas tabelas da denylist. Dado que a tela precisa vira
  **endpoint agregado**, nunca acesso à tabela.
- **Não** matar `PARTNER_DATABASE_URL` nem o fail-closed de
  `src/parceiro/db.ts:20-24`.
- **Não** aceitar `unit_id`/`slug` do cliente como fonte de escopo.
- **Não** unificar os quatro prefixos de sessão.
- **Não** ligar `ADMIN_BEARER_FALLBACK_ENABLED` enquanto houver parceiro no
  namespace `/admin/*`: o token estático concede `role: 'owner'`
  (`src/admin/auth.ts:99-107`).
- **Não** usar spread para montar módulo (congela getter — 126 no parceiro).
- **Não** tratar menu escondido como autorização.

---

## 4. Portões e regressões — antes de qualquer tela

### Regressão obrigatória — roteamento e motor por escopo
Consequência da correção factual de §2.1. A prova versionada
`scripts/prova-vendas-roteamento.ts` deve reprovar se qualquer elo mudar:

1. Parceiro autenticado recebe `ps_` e `/operacao` chama
   `/parceiro/:slug/api/vendas`.
2. Desktop parceiro legado e `/operacao` convergem no mesmo handler
   `registerPartnerSale` com `withPartnerContext` + RLS.
3. O corpo gerado pelo `/operacao` passa em `partnerSaleSchema`.
4. Matriz autenticada recebe `cs_`, chama `/api/caixa/vendas` e permanece no
   `registerWalkinOrder` da unidade `main`.
5. O corpo da Matriz passa em `createCaixaSaleSchema`.
6. As integrações financeiras existentes dos dois motores continuam verdes.

Não se compara o conteúdo das tabelas `commerce.orders` e
`commerce.partner_orders`: elas representam domínios diferentes. A paridade
exigida é entre as **duas interfaces do parceiro**, que já chegam ao mesmo
handler transacional.

### Portão 1 — Gates automáticos
| gate | o que faz | onde |
|---|---|---|
| **Roteamento** | garante `ps_` → rota/RLS do parceiro e `cs_` → walk-in `main` | `prova-vendas-roteamento.ts` |
| **Arquitetura** | falha o build se arquivo alcançável de `src/parceiro/route*.ts` importar `persistence/db.js`. Exceções **congeladas** (hoje: `auth.ts`, `queries.ts` Config, `people.ts`, `simple-finance.ts`, `my-sales.ts`, `operation-*.ts`), molde de `scripts/teto-herdado.json` | novo |
| **Rotas** | baseline grava por rota **(guard, pool esperado, escopo)**. Hoje só grava `AUTH(n)` (`scripts/prova-rotas-matriz.ts:29-40`) — trocar `requireAdminOwner` por `requireAdminAuth` passa idêntico | estender |
| **Compositor** | colisão **não declarada** falha o build; allowlist explícita com justificativa para overrides intencionais | `app.montagem.js:68` |
| **GRANT** | hash + denylist + atributos da role, como gate de CI | `scripts/prova-instalador.ts` |

### Portão 2 — Casco preparado
1. **Namespace nos módulos portados**: `partnerResumo`, `partnerRetiradas`, etc.
   **Helpers compartilhados existem uma única vez** na raiz.
2. **`/admin/api/auth/me` rico**: `{ role, workplace, modules[] }` derivado de
   `listOperationWorkplaces`.
3. **`liveMenu` vira getter derivado** de `modules`; cada item declara
   `requires`. Deletar a mutação por `filter` em `painel/public/app.api.js:104-106`.
   ⚠️ Hoje há **109 usos** de `adminUser?.role` no front — não alimentar.
   ⚠️ A campainha do Bot escreve `item.badge` dentro do array `liveMenu`
   (`app.core.js:173-175`) — quebra quando virar getter.
4. **Boot condicional**: hoje dispara `loadRealData/loadComissoes/loadSino/
   loadBotCampainha` (`app.core.js:83-93`) contra rotas admin-only — sessão de
   parceiro tomaria 401 em loop.
5. **Registro por página** (`PAINEL_PAGES[id].load`) no lugar dos 12 `if` do
   `$watch` (`app.core.js:109-139`).
6. **HTML**: `painel/public/index.html` tem **9.556 linhas** e está fora do
   fiscal de tamanho. Decisão do dono: **sem montagem em runtime**. Ou divisão
   determinística no build já existente (`npm run build`), ou **adiar a divisão
   para depois das primeiras telas**. Recomendação: adiar — não misturar
   máquina nova com obra de escopo.

---

## 5. Inventário e classificação das telas

Categorias (decisão do dono, item 5, com o ajuste do Codex):

- **REUTILIZAR** — já existe equivalente adequado na matriz
- **ADAPTAR** — existe na matriz, mas precisa de API/escopo do parceiro
- **CRIAR NO CASCO** — exclusiva do parceiro
- **DESCARTAR** — duplicada, morta ou inferior ao equivalente atual
- **MANTER NO `/operacao` E USAR COMO REFERÊNCIA** — o mobile fica intacto e
  serve de referência funcional; **não elimina a versão desktop**

| Tela | Endpoints (`/parceiro/:slug/api/…`) | Acopl. | Categoria |
|---|---|---|---|
| **resumo** | `resumo`, `comissao/equipe`, `meu-desempenho` | BAIXO | ADAPTAR |
| **vendas** (PDV) | `produtos`,`estoque`,`clientes/buscar`, POST `vendas`, DELETE `vendas/:id` | **ALTO** | ADAPTAR + referência `/operacao` |
| **pedidos** | `vendas`,`clientes/buscar`, POST `entregas/:orderId` | **ALTO** | ADAPTAR |
| **entrega** | POST `entregas/:id`, `…/confirmar-retorno` | **ALTO** | ADAPTAR + referência `/operacao` |
| **retiradas** | `retiradas`, POST/DELETE `retiradas/:orderId` | **ALTO** | **CRIAR NO CASCO** |
| **clientes** | `clientes` (CRUD), `clientes/buscar` | MÉDIO | ADAPTAR |
| **estoque** | `estoque`,`catalogo/busca`, `operacao/estoque/*` (7 rotas) | **ALTO** | ADAPTAR + referência `/operacao` |
| **financeiro** | `fluxo-caixa`,`compras`,`despesas`,`contas-a-*`, `route-finance-credit.ts` | **ALTO** | ADAPTAR |
| **batepapo** | `chat/conversations*`, `chat/stream-ticket`, `chat/stream` (SSE), `photo-requests*` | **ALTO** (infra) | **CRIAR NO CASCO** |
| **relatorios** | `relatorios/{vendas,pneus,caixa}`, `itens/order/:id/desarquivar` | BAIXO | ADAPTAR |
| **config** | `configuracoes*`, `funcionarios*`, `equipe*` | **ALTO** (auth) | ADAPTAR |

### 5.1 Exclusivo do parceiro — sem componente na matriz
| Coisa | Onde |
|---|---|
| Reserva de estoque (0076) — `quantity_reserved`, CHECK que barra editar item reservado | `src/parceiro/queries.ts:280-295, 1716, 1793, 2089` |
| Retirada — reserva vira baixa física | `queries.ts:1195`; `route.ts:1339` |
| COD — reserva vira baixa em `delivered`; falha PRESERVA a reserva | `queries.ts:1304,1335`; `route.ts:1316` |
| Chat unificado + SSE (ticket, slot-limit, heartbeat) | `route.ts:1094-1150`; `src/normalization/partner-chat.fanout.ts` |
| Foto sob demanda (canal global) | `parceiro/public/app.foto.js`; `route.ts:1005-1090` |
| Fila de aprovação de estoque | `src/parceiro/route-operation-stock*.ts` |
| Score de saúde da loja (gauge 0-1000) | `parceiro/public/app.financeiro.score.js` |
| **Permissão por TELA por pessoa** (9 telas) | `src/parceiro/auth.ts:255-324` — modelo diferente do da matriz |

### 5.2 DESCARTAR — não portar
| Item | Estado |
|---|---|
| `PUT /configuracoes/area`, `GET /configuracoes/bairros` (`route.ts:764,785`) | **mortos** — zero consumidor; o raio aposentou os bairros. Sobra `areaForm` órfão (`app.js:83`) |
| `POST contas-a-receber/:id/parcelas/:id/receber` (`route-finance-credit.ts:145`) | parcelamento **desligado** (`queries.ts:906`); front manda sempre 1 |
| `parceiro/public/sw.js` | tombstone de PWA |
| `retireLegacyMobile` (`route.ts:455`) | muleta de transição; some com o painel velho |
| `permCount` com 9 telas chumbadas (`app.config.js:54`) | duplica a verdade de `auth.ts:261` |

---

## 6. Sequência de PRs

Cada PR: pequeno, verde nos fiscais, revisável isolado. **Nenhum PR mistura
gate com tela.**

| PR | Título | Arquivos | Aceite |
|---|---|---|---|
| **1** | corrigir o plano + prova de regressão do roteamento | `scripts/prova-vendas-roteamento.ts`, `package.json`, este plano | parceiro converge no motor com RLS; Matriz permanece no walk-in `main` |
| **2** | gate de arquitetura (parceiro × pool admin) | `scripts/prova-arquitetura-pools.cjs`, `scripts/pools-herdados.json`, `package.json`, CI | CI falha ao adicionar import novo; 14 exceções atuais congeladas |
| **3** | baseline de rotas com guard+pool+escopo | `scripts/prova-rotas-matriz.ts`, `scripts/baseline-rotas-matriz.json`, CI | 104 rotas owner e 55 owner/admin congeladas; trocar `requireAdminOwner`→`requireAdminAuth` reprova |
| **4** | detector de colisão no compositor | `painel/public/app.montagem.js`, allowlist explícita, CI | única colisão atual congelada; redefinição nova ou autorização obsoleta falha o build |
| **5** | GRANT: hash + denylist + atributos | `scripts/prova-instalador.ts` (+CI) | baseline 71 grants; denylist zero |
| **6** | broker de login + `/auth/me` rico | `src/admin/login.route.ts`, `src/admin/session.ts`, `src/admin/caixa/operation-auth.ts` | `ms_` só com `panel_role`; parceiro recebe `ps_`; A3/A4/A11 passam |
| **7** | menu derivado + boot condicional + registro por página | `painel/public/app.core.js`, `app.api.js`, `app.nav.js` | matriz sem regressão; paridade regravada de propósito |
| **8** | **Resumo do parceiro** (read-only) atrás de flag | `painel/public/app.partner-resumo.js`, `src/parceiro/route-resumo*.ts`, `route-static.ts` | prova login+contexto+menu+escopo; A1/A2/A5/A12 passam |
| **9** | **Retiradas do parceiro** atrás de flag | `painel/public/app.partner-retiradas.js`, rotas existentes | permissão, escrita, idempotência, transação; A6/A8 passam |
| **10** | canário + telemetria de divergência | flag por unidade | duas telas batendo com o painel antigo |

Andamento: PRs 6, 7, 8 e 9 incorporados; o PR 10 fecha a obra. O broker emite `ms_`/`ps_`, `/auth/me`
devolve o contexto calculado no servidor, o menu é derivado de `modules`, os
badges não alteram a definição do menu e o boot administrativo só roda para a
Matriz. O Resumo moderno do parceiro é somente leitura e permanece
desligado por padrão: usa exclusivamente `resumo`, `comissao/equipe` e
`meu-desempenho` sob sessão `ps_`; não refaz contas financeiras no navegador e
mantém competência, caixa e títulos em aberto visualmente separados. A flag
por unidade do PR 10 nasce desligada, portanto o painel legado permanece o
caminho do parceiro até o dono habilitar uma unidade conscientemente. O PR 9
implementa Retiradas no mesmo casco e preserva a operação auditada: fila
escopada, pagamento no balcão, reserva→baixa física→caixa apenas na confirmação,
cancelamento sem caixa e foto aprovada como apoio opcional. O navegador não
refaz efeitos de estoque ou financeiro.

O PR 10 acrescenta a chave owner-only na ficha da unidade, rollback sem deploy,
leitura da flag no broker e no `/api/me`, e telemetria técnica de 24 horas
(eventos, erros e latência p95). O evento é allowlisted, usa pool restrito + RLS
e não contém PII, pedido, valor ou JSON livre. Resumo e Retiradas continuam
chamando exatamente as mesmas rotas transacionais do painel legado.

**Paridade fechada de Retiradas (PR 9):** listar somente pickups aguardando;
mostrar cliente, telefone, itens, origem 2W, total e foto quando autorizada;
avisar por telefone/WhatsApp; escolher Pix/Dinheiro/Cartão; confirmar uma única
vez; cancelar com motivo obrigatório no fluxo 2W; liberar reserva sem entrada
no caixa; respeitar `requireScreen('retiradas')` sem exigir acesso a Vendas.

**Migration necessária:** `0203_partner_modern_panel_canary.sql`, aditiva e
compatível com o código antigo. Aplicar no banco novo correto **antes** do deploy;
não usar a `.env.pooler` enquanto ela apontar para o banco externo divergente.

---

## 7. Bateria de testes

### 7.1 Ataques (todos em Docker, **nunca** em produção)
Criar unidades **A** e **B** no laboratório e atacar cada endpoint do parceiro
que usa pool administrativo, manipulando slug, body, query e IDs.

| # | ataque | resultado exigido |
|---|---|---|
| A1 | `unit_id` no body/query de rota do parceiro | ignorado; nunca 200 com dado alheio |
| A2 | sessão da loja A chamando `/parceiro/loja-B/api/vendas` | 401 |
| A3 | `ps_` no cookie da matriz → `/admin/api/matriz/financeiro` | 401 |
| A4 | `ps_` como `Authorization: Bearer` em rota de matriz | 401, **sem cair no fallback** (`src/admin/auth.ts:48-54`) |
| A5 | varredura das 145 rotas `/admin/api/*` com sessão de parceiro | 401/403 em todas; zero 200 |
| A6 | funcionário com `financeiro:false` chamando o endpoint direto | 403 `partner_forbidden_screen` |
| A7 | sessão revogada / loja `status<>'active'` reusada | 401 |
| A8 | query do parceiro fora de `withPartnerContext` | 0 linhas |
| A9 | `SELECT` em `commerce.wholesale_*` com a role do parceiro | `permission denied` |
| A10 | CSRF: POST externo com cookie válido | 403 `csrf_rejected` (`admin/auth.ts:116`) |
| A11 | sessão `cs_`/`es_` em rota de dono | 403 |
| A12 | `/api/me` de owner parceiro | sem `tokenId`, sem ids de outras unidades |
| **A13** | **nenhuma operação da unidade A lê ou altera B** | conjunto vazio |

**Classificação:** só é **vulnerabilidade ativa** com exploração
reproduzível. Sem isso, registrar como **dívida de defesa em profundidade** —
com o roteiro do ataque anexado.

### 7.2 Fiscais em cada PR
`npm run check:migrations` · `npm run checar-tamanho` · `npx tsc --noEmit` ·
`npm test` · `npm run prova-vendas-roteamento` · `npm run prova-painel` ·
`npm run prova-instalador`

⚠️ **Não rodar `npm test` em paralelo com `prova-painel`** — disputa de CPU
gera falha falsa em testes sensíveis a tempo (aconteceu em 2026-08-23:
8 "falhas" que sumiram na execução limpa; 1306/1306).

Após a implementação de Retiradas, o domínio foi extraído para
`src/parceiro/pickup-queries.ts`; `src/parceiro/queries.ts` ficou em
**4191/4310**. A regra continua: funcionalidade nova deve nascer em módulo
próprio, sem engordar o arquivo herdado.

---

## 8. Canário e rollback

**O canário NÃO é Rio do Ouro** — ela não existe no banco novo (zero parceiros
cadastrados). Será **a primeira unidade cadastrada ou uma unidade
demonstrativa controlada**, criada de propósito para isso.

- Flag **por unidade** (não global).
- `parceiro/public` permanece de pé como rollback durante toda a transição.
- Rollback = desligar a flag da unidade. Sem deploy, sem migration reversa.
- Aposentar `parceiro/public` **só depois** de paridade por tela + canário
  estável.

**Definição de paridade** (senão nunca fecha): por tela, uma lista fechada de
operações que o painel antigo faz e o novo tem que fazer, cada uma conferida no
canário. Sem checklist assinado, a tela não conta como migrada.

---

## 9. Critérios de aceite

1. A regressão de roteamento comprova que `/operacao` e desktop do parceiro
   convergem na rota com RLS; o Caixa da Matriz continua separado em `main`.
2. Os 4 gates do Portão 1 rodando em CI e **reprovando de verdade** quando
   provocados.
3. A1–A13 executados em Docker com resultado registrado.
4. Resumo e Retiradas funcionando para o canário, atrás de flag.
5. Matriz **sem regressão**: paridade e rotas regravadas apenas de propósito,
   com delta na mensagem do commit.
6. `panel_role` continua obrigatório para `ms_`; parceiro nunca recebe `ms_`.
7. Nenhum handler novo do parceiro no pool admin.

---

## 10. Riscos restantes

| risco | por quê | mitigação |
|---|---|---|
| **Roteamento do parceiro regredir para o Caixa da Matriz** | mistura domínio, estoque e financeiro | prova automática de roteamento |
| **Colisão silenciosa de propriedades** | invisível; paridade não pega | detector + namespace |
| **Regressão no Financeiro da matriz** | maior superfície; o **sweep de comissão roda no GET** — se o casco mudar quando a página carrega, "quem te deve" congela com a tela viva | teste de carregamento por página |
| **Regressão na Rede** | 9 charts por id global de `<canvas>` (`app.nav.js:66-81`) — id repetido pinta no lugar errado | namespace de canvas |
| **Campainha do Bot** | escreve `badge` dentro do array `liveMenu` | tratar antes do PR 7 |
| **Conversa de cliente vazar pro parceiro** | dado do Bot nunca pode ir pro parceiro | denylist + A5 |
| **Pool restrito sob carga** | `max: 15` (`src/parceiro/db.ts:36`); painel unificado pode dobrar chamadas por boot | medir no canário |
| **Duas interfaces divergirem** | aceito por decisão | regra no servidor, nunca na tela |

---

## 11. Pendências fora desta obra

- 🔴 **Bot mudo em produção desde 17/08** (OpenAI sem crédito). Pendência
  operacional separada e urgente — não bloqueia esta obra, mas não pode ser
  escondida por ela.
- 🟠 Rotacionar segredos expostos (Meta, VAPID, Google Maps, senha do postgres).
- 🟡 Cadastrar no banco novo: unidade canário, medidas, estoque, parceiros e
  raios reais.

---

## 12. O que NÃO foi verificado

- A prova somente leitura anterior confirmou **157 tabelas**, role do parceiro
  restrita, **70 grants** e zero grant no galpão/comissão até a `0202`. Após
  aplicar a `0203`, o contrato esperado passa conscientemente a **71 grants**
  (somente `INSERT` na telemetria técnica) e precisa ser reconfirmado no banco
  novo correto.
- O banco não está mais zerado porque Wallace usou as telas após o deploy:
  cadastrou 1 produto/medida, 2 compatibilidades, 2 versões de preço e uma
  compra de 5 pneus. A compra gerou fornecedor, item, estoque, movimento,
  ledger e auditoria de forma conciliada. São dados de teste, mas só podem ser
  removidos por uma limpeza transacional completa; apagar cinco linhas avulsas
  quebraria a trilha financeira. Nenhum dado foi apagado nesta revisão.
- **Venda real pelo navegador** não foi executada nesta revisão; o roteamento
  foi provado por código/teste, e os dois motores passaram em Docker (47 testes
  transacionais nos arquivos `partner-portal` e `matriz-walkin-atomic`).
- **Paridade funcional real entre `/operacao` e o painel desktop** — não medida.
- **Front não auditado pela ótica de segurança** — só o servidor.
- **Custo/latência do pool restrito sob carga unificada**.

---

*Banca: `seguranca`, `parceiro`, `matriz` (Claude Opus 5) · revisão crítica do
Codex · decisões do dono · 2026-08-23.*
