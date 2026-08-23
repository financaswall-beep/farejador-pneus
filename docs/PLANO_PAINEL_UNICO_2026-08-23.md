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

O servidor é a fonte única das regras. **⚠️ Hoje isso não é verdade — ver §2.**

---

## 2. ⚠️ Achados que contradizem o desenho — leia antes de propor

### 2.1 🔴 `/operacao` roda 100% no pool administrativo

**Verificado:** `grep -rn "withPartnerContext\|partnerPool" src/admin/caixa/*.ts`
→ **zero ocorrências em 32 arquivos**.

`src/admin/caixa/checkout.ts:2` importa `pool` de `persistence/db.js` (role
`postgres`, BYPASSRLS) e `:7` usa `registerWalkinOrder` de
`../painel/walkin-order.js` — o motor de venda **da matriz**.
`src/admin/caixa/operation-stock.ts:4` só importa um **type** de
`parceiro/operation-stock.js` (apagado na compilação).

**Consequências:**
1. A muralha (role restrita + RLS + 70 grants) **não cobre a interface que os
   parceiros usam hoje no celular**.
2. O SEC-002 é maior que o documentado: não é "algumas funções do parceiro
   usam o pool admin" — é **a operação móvel inteira**.
3. Existem **duas famílias de escrita** para a mesma operação do parceiro:
   `/parceiro/:slug/api/vendas` (motor do parceiro, pool restrito) e
   `/api/caixa/vendas` (motor walk-in da matriz, pool admin).

**Risco direto para esta obra:** se o desktop novo chamar as rotas do parceiro
e o celular continuar nas do caixa, o **mesmo parceiro** vendendo no computador
e no celular passa por códigos diferentes. Isso não é manutenção — é risco de
número divergente. Daí o **Portão 0** (§4.0).

**NÃO afirmado (falta provar):** se as duas vendas produzem efeito equivalente
em estoque e financeiro; se a reserva (0076) vale no caminho do celular.
`walkin-order.ts:152,177` escreve em `commerce.orders`/`order_items` e não
menciona reserva — mas há vínculo entre as tabelas desde a 0081.

### 2.2 As 145 rotas da matriz não têm noção de "dono"
`grep preHandler` em `src/admin/painel/route-*.ts`: **145 handlers**
(63+27 `requireAdminOwner`, 52+3 `requireAdminAuth`), **nenhum com `unit_id` no
escopo**. E **94 arquivos** de `src/admin/painel/` importam `persistence/db.js`;
**zero** usam `partnerPool`.

Trocar o pool **não conserta query que nunca teve cláusula de dono**. Este é o
custo real da obra.

### 2.3 O muro de GRANT já tem furo hoje
`src/parceiro/auth.ts:6` importa o pool admin; `auth.ts:260-266` lê a tabela de
autorização por lá. `src/parceiro/queries.ts:3788-3800` **documenta** que toda
a Config da loja roda no pool admin. `src/parceiro/route-coverage.ts:3` importa
`admin/painel/queries-parceiros-rede.js`.

### 2.4 Colisão silenciosa entre os dois conjuntos de módulos
`painel/public/app.montagem.js:68-70` faz
`Object.defineProperties(out, Object.getOwnPropertyDescriptors(f()))` sobre 56
fábricas. Existem nos DOIS painéis: `formatDateTime`, `init`, `saleForm`,
`stockForm`, `clientes`, `compras`, `apiHeaders`, `waLink`, `deliveryAddr`,
`mapsNavUrl`, `toE164Phone`. **O último ganha sem erro, sem warning, e a
paridade não vê** (nome e tipo idênticos ao baseline).

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

**Pool + GUC sempre em par:** as policies são estritas
(`src/parceiro/db.ts:47-50`, `IS NOT NULL AND …`). Pool restrito **sem**
`withPartnerContext` (`db.ts:56-74`) = **zero linhas**, não "as do parceiro".

### 3.3 Política de GRANT
- **Preservar hash/snapshot** do conjunto permitido — mesma disciplina de
  baseline que a casa usa em paridade e rotas: quem muda **regrava DE PROPÓSITO
  no mesmo commit**, com o delta na mensagem.
- **Denylist explícita**, verificada além do hash: `commerce.wholesale_*`,
  `commerce.matriz_*`, `network.commission_entries`, `network.commission_entry_events`,
  `finance.matriz_ledger_*`. Zero grants — hoje confirmado.
- **Conferir atributos da role**: `NOBYPASSRLS` e `NOINHERIT`.
- **Baseline atualizado conscientemente para 70 grants**, incluindo o
  `SELECT ON commerce.tire_specs` criado pela `0202`
  (`db/migrations/0202_catalog_bootstrap_fitment_workflow.sql:134`).
  Hash atual do conjunto: `16bdb2433828b2a73d7134ad9e2a5f4b`.

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

## 4. Portões — antes de qualquer tela

### Portão 0 — Provar que as duas vendas concordam 🔴 NOVO
Consequência de §2.1. Antes de escolher qual motor o desktop usa:

1. Em laboratório, executar a **mesma venda** por `/parceiro/:slug/api/vendas`
   e por `/api/caixa/vendas`.
2. Comparar o efeito em: `commerce.orders`/`order_items`,
   `commerce.partner_orders`/`partner_order_items`,
   `commerce.partner_stock_levels` (incl. `quantity_reserved`),
   `finance.partner_receivables` e trilha de auditoria.
3. **Se divergirem**, isso é achado financeiro e sobe de prioridade — o desktop
   novo não pode nascer sobre um motor que discorda do que já roda no celular.
4. Registrar o resultado como prova versionada (`scripts/prova-vendas-paridade.ts`).

> Se o dono preferir, este portão roda **em paralelo** ao Portão 1 — mas tem
> que fechar antes da primeira escrita do parceiro no painel novo.

### Portão 1 — Gates automáticos
| gate | o que faz | onde |
|---|---|---|
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
| **1** | prova de paridade das duas vendas | `scripts/prova-vendas-paridade.ts` | Portão 0 fechado ou divergência documentada |
| **2** | gate de arquitetura (parceiro × pool admin) | `scripts/prova-arquitetura-pools.cjs`, `scripts/pools-herdados.json`, `package.json` | build falha ao adicionar import novo; exceções atuais congeladas |
| **3** | baseline de rotas com guard+pool+escopo | `scripts/prova-rotas-matriz.ts`, `scripts/baseline-rotas-matriz.json` | trocar `requireAdminOwner`→`requireAdminAuth` reprova |
| **4** | detector de colisão no compositor | `painel/public/app.montagem.js`, allowlist | redefinição não declarada falha o build |
| **5** | GRANT: hash + denylist + atributos | `scripts/prova-instalador.ts` (+CI) | baseline 70 grants; denylist zero |
| **6** | broker de login + `/auth/me` rico | `src/admin/login.route.ts`, `src/admin/session.ts`, `src/admin/caixa/operation-auth.ts` | `ms_` só com `panel_role`; parceiro recebe `ps_`; A3/A4/A11 passam |
| **7** | menu derivado + boot condicional + registro por página | `painel/public/app.core.js`, `app.api.js`, `app.nav.js` | matriz sem regressão; paridade regravada de propósito |
| **8** | **Resumo do parceiro** (read-only) atrás de flag | `painel/public/app.partner-resumo.js`, `src/parceiro/route-resumo*.ts`, `route-static.ts` | prova login+contexto+menu+escopo; A1/A2/A5/A12 passam |
| **9** | **Retiradas do parceiro** atrás de flag | `painel/public/app.partner-retiradas.js`, rotas existentes | permissão, escrita, idempotência, transação; A6/A8 passam |
| **10** | canário + telemetria de divergência | flag por unidade | duas telas batendo com o painel antigo |

**Migrations necessárias:** nenhuma prevista até o PR 10. Se o modelo de
permissão exigir coluna nova, ela entra em PR próprio, **antes** do PR 6.

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
`npm test` · `npm run prova-painel` · `npm run prova-instalador`

⚠️ **Não rodar `npm test` em paralelo com `prova-painel`** — disputa de CPU
gera falha falsa em testes sensíveis a tempo (aconteceu em 2026-08-23:
8 "falhas" que sumiram na execução limpa; 1306/1306).

⚠️ `src/parceiro/queries.ts` está em **4298/4310** — sobram **12 linhas**.
Qualquer adição exige fatiar antes.

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

1. Portão 0 fechado (as duas vendas concordam, ou a divergência está documentada
   e priorizada).
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
| **Divergência entre as duas vendas** | §2.1 — duas famílias de escrita | Portão 0 |
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

- **Nada rodou ao vivo.** Leitura de código + fiscais estáticos.
- **Equivalência entre `/api/caixa/vendas` e `/parceiro/:slug/api/vendas`** —
  é justamente o Portão 0.
- **Paridade funcional real entre `/operacao` e o painel desktop** — não medida.
- **Front não auditado pela ótica de segurança** — só o servidor.
- **Custo/latência do pool restrito sob carga unificada**.

---

*Banca: `seguranca`, `parceiro`, `matriz` (Claude Opus 5) · revisão crítica do
Codex · decisões do dono · 2026-08-23.*
