# Plano — Painel único (matriz + parceiro) · 2026-08-23

> **Documento para implementação.** Escrito por uma banca de 3 especialistas
> (`seguranca`, `parceiro`, `matriz`) que leram o código deste repositório e
> citam arquivo:linha. Destinado ao Codex/GPT ou a quem for implementar.
>
> **Leia as Seções 1 e 2 antes de propor qualquer coisa.** Elas contradizem o
> desenho inicial que circulou, e ignorá-las produz um plano que não sobrevive
> ao contato com o código.

---

## 0. Objetivo e janela

Unificar a experiência: um casco visual só, com **permissões** decidindo o que
cada perfil vê e pode fazer — matriz enxerga tudo, parceiro enxerga a operação
dele. Aposentar o front legado no fim.

**A janela é agora e é a melhor possível:** banco novo e vazio (projeto
`beisgivepyfhgcujsqan`, sa-east-1), **zero cliente do software**, 2 parceiros
conhecidos, instalador que reconstrói o banco do zero em minutos
(`npm run instalar-projeto`) e fiscais de paridade que denunciam mudança de
interface. Obra estrutural feita depois de ter cliente pagando nunca acontece.

**Regra de ouro:** não reescrever cálculo, motor financeiro, estoque ou regra
de negócio já auditada. A obra é de **casca, rota e escopo** — não de motor.

---

## 1. ⚠️ Três achados que mudam o plano

### 1.1 A migração JÁ COMEÇOU — existem TRÊS frentes, não duas

`src/parceiro/route.ts:455-460` (`retireLegacyMobile`) **redireciona todo o
tráfego MOBILE do parceiro para `/operacao`**. A PWA do parceiro já foi
aposentada — `parceiro/public/sw.js` é um tombstone que empurra pra lá.

`/operacao` é um app que já existe em `painel/public/caixa-*.js` (**30
arquivos, vanilla JS — NÃO é Alpine**), servido por
`src/admin/caixa/route-static.ts`. Painéis já construídos lá: cash, sales,
stock (+detail/receipts), deliveries, finance (+entries/commissions), team
(+permissions/remuneration/commission), notifications, profile.

**Consequência:** `parceiro/public/` é hoje o painel **DESKTOP legado** do
parceiro. O inventário real é:

| frente | stack | quem usa |
|---|---|---|
| `painel/public/app*.js` | Alpine, 56 módulos | painel da matriz |
| `painel/public/caixa-*.js` (`/operacao`) | **vanilla JS**, 30 arquivos | parceiro no **celular** (já ativo) |
| `parceiro/public/*.js` | Alpine, 31 módulos, 599 props | parceiro no **desktop** (legado) |

**Isto é a decisão #1 e ela é do dono** (Seção 8). Planejar "unificar dois
painéis" ignora que metade do caminho já foi andada — em uma terceira stack.

### 1.2 As 145 rotas da matriz não têm noção de "dono"

`grep preHandler` em `src/admin/painel/route-*.ts`: **145 handlers**
(63+27 `requireAdminOwner`, 52+3 `requireAdminAuth`). **Nenhum tem `unit_id`
no escopo** — foram escritos sob a premissa *"quem chama é a matriz e vê a
rede inteira"*.

E `src/admin/painel/` tem **94 arquivos** importando `persistence/db.js` (role
`postgres`, BYPASSRLS) e **ZERO** usando `partnerPool`/`withPartnerContext`.

**Consequência:** trocar o pool **não conserta uma query que nunca teve
cláusula de dono**. Servir tela da matriz ao parceiro não é questão de
permissão nem de conexão — é reescrever consulta por consulta. Este é o custo
real da obra, e não estava no desenho original.

### 1.3 O muro de GRANT já tem furo hoje (SEC-002 vivo)

`src/parceiro/auth.ts:6` importa o pool admin, e `resolvePartnerPermissions`
(`auth.ts:260-266`) lê a tabela de autorização por lá. Pior:
`src/parceiro/queries.ts:3788-3800` **documenta** que toda a Config da loja
roda no pool admin — isolamento ali é só o `WHERE`.

`src/parceiro/route-coverage.ts:3` importa
`admin/painel/queries-parceiros-rede.js` — o parceiro já invade a matriz.

**Consequência:** a obra unificada não abre um furo novo; ela **promove a
exceção a padrão da casa**. Por isso o desenho da Seção 2 é inegociável.

---

## 2. Desenho de segurança — INEGOCIÁVEL

Veredicto da banca: **FIX-ANTES**. O que segue não é preferência, é o contrato.

### 2.1 Pool + GUC, sempre em par

O pool restrito sozinho **não liga o RLS**. As policies são estritas
(`src/parceiro/db.ts:47-50`: `IS NOT NULL AND …`) e dependem do GUC por
transação que `withPartnerContext` (`db.ts:56-74`) planta via
`set_config('app.partner_unit_id', …, true)`.

> Pool restrito **sem** o wrapper = **zero linhas**, não "as linhas do parceiro".

### 2.2 Namespace físico separado — não `if` no handler

| camada | o que tem que ser verdade |
|---|---|
| **Menu** | Deriva de `/api/me`. É **cosmético** — nunca citado como controle |
| **Rota** | `/parceiro/:slug/api/*` continua o **único** caminho do parceiro. Rota de matriz **não ganha** `if (isPartner)` |
| **Pool** | Escolhido pelo **tipo de sessão**, no `preHandler`, nunca pelo handler |
| **Banco** | RLS nas 31 `partner_*` + **nenhum GRANT novo** a `farejador_partner_app`. Default deny é o último muro |

**Regra dura:** o parceiro nunca é atendido por handler que hoje roda no pool
admin. Se uma tela da matriz precisa aparecer pro parceiro, nasce um endpoint
**novo** em `src/parceiro/` com a query reescrita e escopada. **O reuso é do
componente de UI, não do handler.**

### 2.3 Sessão, perfil e `unit_id`

São **QUATRO** sistemas de sessão, não três: `ps_` (`src/parceiro/password.ts:20`),
`ms_` (`src/admin/session.ts:9`), `es_` (`src/admin/entregador/queries.ts:29`),
`cs_` (`src/admin/caixa/queries.ts:8`). Os três últimos gravam na **mesma
tabela** `network.matriz_staff_sessions`; o que os separa é o **regex de
prefixo dentro de cada validador**. Validador novo que esqueça o check de
prefixo = escalada instantânea entre portais.

O modelo certo **já existe**: `listOperationWorkplaces`
(`src/admin/caixa/operation-auth.ts:69-150`) junta matriz e parceiro na mesma
pessoa e devolve `workplaces[] { kind: 'matrix'|'partner', role, modules{...} }`,
lendo `partner_access_tokens` + `partner_token_permissions`. E
`publicOperationWorkplace` **omite o `tokenId`** do JSON.

**Copie esse modelo. Não crie uma segunda tabela de permissão.**

1. Login devolve a lista de workplaces derivada do banco.
2. Cliente escolhe por **id opaco**; o servidor **re-resolve** o vínculo por
   `person_id` + workplace ao emitir a sessão (`caixa/queries.ts:90-110` já faz).
3. `unit_id` fica **gravado na sessão**. **Nunca** aceito de body, query, header
   ou path. O `:slug` da URL só serve pra ser **comparado** (401 se divergir).
4. Trocar de loja = **novo login**, não um seletor que muda o escopo da sessão viva.

### 2.4 Os 12 ataques que a prova tem que cobrir

| # | ataque | resultado exigido |
|---|---|---|
| A1 | `unit_id` no body/query de rota do parceiro | ignorado; nunca 200 com dado alheio |
| A2 | sessão da loja A chamando `/parceiro/loja-B/api/vendas` | 401 (slug ≠ sessão) |
| A3 | `ps_` no cookie da matriz → `/admin/api/matriz/financeiro` | 401 (prefixo reprovado) |
| A4 | `ps_` como `Authorization: Bearer` em rota de matriz | 401 — **e não pode cair no fallback** (`src/admin/auth.ts:48-54`) |
| A5 | varredura das 145 rotas `/admin/api/*` com sessão de parceiro | 401/403 em **todas**; zero 200 |
| A6 | funcionário com `financeiro:false` chamando o endpoint direto | 403 `partner_forbidden_screen` |
| A7 | sessão revogada / loja `status<>'active'` reusada | 401 no request seguinte |
| A8 | query do parceiro **fora** de `withPartnerContext` | 0 linhas, nunca dado alheio |
| A9 | `SELECT` em `commerce.wholesale_*` com a role do parceiro | `permission denied` |
| A10 | CSRF: POST externo com cookie válido | 403 `csrf_rejected` (`admin/auth.ts:116`) |
| A11 | sessão `cs_`/`es_` em rota de dono | 403 (`panel_role IS NOT NULL` barra) |
| A12 | `/api/me` de owner parceiro — inspecionar payload | sem `tokenId`, sem ids de outras unidades |

---

## 3. Os 3 erros mais prováveis — e a trava de cada um

### Erro 1 — Handler compartilhado com `if (perfil === 'partner')`
É a forma que a obra vai naturalmente tomar. Transforma o muro de GRANT num
`if` de TypeScript.

**Trava:** teste de arquitetura que **falha o build** se qualquer arquivo
alcançável a partir de `src/parceiro/route*.ts` importar `persistence/db.js`.
Lista de exceções **congelada** (hoje: `auth.ts`, `queries.ts` Config,
`people.ts`, `simple-finance.ts`, `my-sales.ts`, `operation-*.ts`), no molde de
`scripts/teto-herdado.json`. Entrada nova = falha, salvo remoção no mesmo commit.

### Erro 2 — GRANT concedido "pra destravar" no meio do desenvolvimento
Alguém bate em `permission denied`, roda um `GRANT SELECT`, e o muro cai calado.

**Trava:** `scripts/prova-instalador.ts` já compara o conjunto de grants por
hash (`d718da85…`). Promover a **gate de CI obrigatório** e assertar
explicitamente **zero grant** em `commerce.wholesale_*`, `commerce.matriz_*`,
`network.commission_entries`, `finance.matriz_ledger_*`.

### Erro 3 — Colisão silenciosa entre os dois conjuntos de módulos
**Esta é a mais perigosa porque é invisível.** O compositor
(`painel/public/app.montagem.js:68-70`) faz
`Object.defineProperties(out, Object.getOwnPropertyDescriptors(f()))` sobre 56
fábricas. O parceiro tem seu próprio `formatDateTime`, `init`, `saleForm`,
`stockForm`, `clientes`, `compras`, `apiHeaders`, `waLink`, `deliveryAddr`,
`mapsNavUrl`, `toE164Phone`.

Ao juntar, **o último ganha sem erro, sem warning, e a paridade não vê** —
nome e tipo continuam idênticos ao baseline. O sintoma aparece semanas depois
(data errada, campo fantasma no formulário de venda) e a suspeita cai no lugar
errado.

**Trava:** o loop do compositor deve **estourar em redefinição não declarada**,
com allowlist explícita de overrides intencionais. Construir **antes** de
hospedar qualquer coisa.

---

## 4. Ordem de obra

### Fase 0 — Preparar o casco (antes de hospedar qualquer tela)

1. **Detector de colisão no compositor** + namespace (Erro 3 acima).
2. **`/admin/api/auth/me` rico**: `{ role, workplace, modules[] }` derivado de
   `listOperationWorkplaces` — fonte única. E **login da matriz deixa de exigir
   `panel_role IS NOT NULL`** (`src/admin/session.ts:79`).
3. **`liveMenu` vira getter derivado** de `modules`; cada item declara o que
   exige (`{ id:'financeiro', requires:'financeiro' }`). Deletar a mutação por
   `filter` em `painel/public/app.api.js:104-106`. Hoje há **109 usos** de
   `adminUser?.role` no front — o `if` gigante já começou; não alimentar.
4. **Boot condicional**: hoje o boot dispara `loadRealData/loadComissoes/
   loadSino/loadBotCampainha` (`app.core.js:83-93`) contra rotas admin-only.
   Sessão de parceiro tomaria 401 em loop.
5. **Registro por página** (`PAINEL_PAGES[id].load`) no lugar dos 12 `if` do
   `$watch` (`app.core.js:109-139`) — senão vira 25 `if`.
6. **Fatiar `painel/public/index.html`** em partials por página. Ele já tem
   **9.556 linhas** e está **fora** do fiscal de tamanho.
7. **Teste de arquitetura do Erro 1** + gate de CI do Erro 2.

### Fase 1 — A primeira tela

Ver Seção 5. Uma tela só, atrás de flag, com o painel legado de pé.

### Fase 2 em diante
Só depois da Fase 1 medida. **Não planejar as fases seguintes antes de ter o
número real da primeira.**

---

## 5. A primeira tela: **RETIRADAS**

Não é a mais fácil. É a de melhor razão aprendizado/estrago.

| critério | por quê |
|---|---|
| **Exclusiva do parceiro** | obriga a construir no casco da matriz o componente que falta (fila de operação: card + ação + motivo). Entregas, estoque e pedidos reusam esse molde depois |
| **Exercita a pilha que importa** | `requirePartnerAuth` + `requireScreen('retiradas')` (`src/parceiro/auth.ts:293`), feed próprio (`route.ts:832`), 2 escritas que tocam **reserva** (`route.ts:1339`/`:1367`) e a régua de venda realizada da 0077 |
| **Superfície ridícula** | 1 GET + 2 escritas; o front cabe em ~90 linhas |
| **Prova pronta** | `scripts/prova-retirada-reserva-test.ts` |
| **Rollback trivial** | painel legado de pé, 2 parceiros, volume baixo |

**Não comece por:** Resumo (só leitura — não ensina nada sobre permissão nem
transação) nem Financeiro/PDV (dinheiro no dia 1).

---

## 6. Fiscais: como manter úteis durante a obra

| fiscal | problema na obra | conserto |
|---|---|---|
| `prova-paridade-matriz.cjs` | vai regravar todo dia e virar carimbo | regravar **só** no commit que muda a interface de propósito, com o delta na mensagem; **+ detector de colisão** (hoje duas props de mesmo nome/tipo passam idênticas) |
| `prova-rotas-matriz.ts` | grava `AUTH(n)` mas não **qual** guard | estender pra gravar **(guard, pool esperado, escopo)** por rota. Trocar `requireAdminOwner` por `requireAdminAuth` é a regressão mais cara e hoje passa idêntica |
| `checar-tamanho` | `*.html` está fora da regra | `index.html` já tem 9.556 linhas e é a maior peça da obra — criar teto ou partials |
| `prova-instalador.ts` | roda à mão | virar **gate de CI** com assert de zero-grant |

⚠️ `npm run prova-painel` roda 5 fiscais — mexer no parceiro pode reprovar por
causa da matriz. Baseline do parceiro hoje: **599 props** (verde).

---

## 7. O que NÃO fazer

- **Não** conceder GRANT nenhum a `farejador_partner_app` nas tabelas da
  matriz. Dado que a tela precisa vira **endpoint agregado**, nunca acesso à tabela.
- **Não** matar `PARTNER_DATABASE_URL` nem o fail-closed de
  `src/parceiro/db.ts:20-24` — é o único ponto do sistema que prefere ficar
  fora do ar a vazar.
- **Não** aceitar `unit_id`/`slug` do cliente como fonte de escopo, nem em
  "modo admin".
- **Não** unificar os 4 prefixos de sessão num token único, e não escrever
  validador novo sem o check de prefixo.
- **Não** ligar `ADMIN_BEARER_FALLBACK_ENABLED` enquanto houver parceiro
  tocando `/admin/*`: esse token estático concede `role: 'owner'`
  (`src/admin/auth.ts:99-107`) e viraria chave-mestra da rede.
- **Não** usar spread pra montar módulo (congela getter — são 126 getters no
  parceiro).
- **Não** tratar menu escondido como autorização.
- **Não** carregar o que já está morto: `PUT /configuracoes/area` e
  `GET /configuracoes/bairros` (`route.ts:764,785`, zero consumidor);
  parcelamento (`route-finance-credit.ts:145`, desligado em `queries.ts:906`);
  `parceiro/public/sw.js` (tombstone); `permCount` com lista de 9 telas
  chumbada (`app.config.js:54`, duplica `auth.ts:261`).

---

## 8. Decisões que só o dono toma

1. **O que acontece com `/operacao`?** (Seção 1.1) Ele já é o caminho mobile do
   parceiro, em **vanilla JS**. As opções: (a) casco da matriz absorve também o
   `/operacao` — obra maior, uma stack só no fim; (b) `/operacao` vira o
   destino e o casco da matriz converge pra lá; (c) mantém `/operacao` no
   celular e unifica só o desktop — mais barato, mas **três stacks convivendo**.
   **Nada deve ser implementado antes desta resposta.**
2. **Auditar SEC-002 antes ou junto?** A banca recomenda **antes**: a obra
   multiplica exatamente a classe de furo que o SEC-002 descreve.
3. **Ordem contra o resto da fila:** hoje o bot está mudo em produção (OpenAI
   sem crédito) e nenhuma venda real passou pelo sistema.

---

## 9. Limites desta análise

- **Nada foi executado ao vivo.** É leitura de código + fiscais estáticos
  (`checar-tamanho` [OK], `prova-paridade-painel` [OK] 599 props). Sem preview,
  sem navegador.
- **`/operacao` não foi conferido funcionando** — o grau real de paridade
  funcional entre ele e o painel desktop **precisa ser medido** antes de
  fechar a ordem das fases.
- O front (`painel/public/*.js`, `parceiro/public/*.js`) **não foi auditado
  pela ótica de segurança** — só o servidor.
- Não foi avaliado **custo/latência do pool restrito sob carga unificada**
  (`max: 15`, `src/parceiro/db.ts:36`). Se o painel unificado dobrar as
  chamadas por boot, isso vira fila.
- **Espaço de teto:** `src/parceiro/queries.ts` está em **4298/4310** — sobram
  **12 linhas**. Qualquer adição exige fatiar antes.

---

*Banca: `seguranca`, `parceiro`, `matriz` — Claude Opus 5, 2026-08-23.*
