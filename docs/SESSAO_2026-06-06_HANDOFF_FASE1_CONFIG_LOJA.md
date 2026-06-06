# HANDOFF — Sessão 2026-06-06: Fase 1 "Configurações da Loja + Roteamento Multi-Parceiro"

> **Para quem lê este documento:** você é uma LLM que NÃO tem contexto algum deste projeto.
> Tudo que você precisa está aqui. Não presuma nada que não esteja descrito abaixo.
> Datas sempre absolutas. Código citado foi confirmado nos arquivos reais antes de ser escrito.

---

## 0. Contexto do projeto (do zero)

### O que é o Farejador

"Farejador" é o sistema de uma **rede de lojas de pneus meia-vida** (pneus usados selecionados,
não novos) que vende via WhatsApp e Chatwoot. Tem três camadas:

**(a) Bot de atendimento** (`src/atendente-v2/`)
- Modelo: GPT-5.5 (OpenAI), chamado pela aplicação Fastify.
- Cota produto e frete, coleta dados, cria pedidos para o cliente final via WhatsApp.
- Ferramenta central: `criar_pedido` (em `src/atendente-v2/tools.ts`).
- Roteamento: dado o bairro do cliente, o bot decide se o pedido vai para um **parceiro** (loja
  local com estoque) ou para a **matriz** (estoque centralizado).

**(b) Painel do parceiro** (`src/parceiro/` + `parceiro/public/`)
- Tecnologia: Fastify (backend) + Alpine.js (frontend SPA, sem build step, arquivos estáticos
  servidos pelo próprio Fastify em `parceiro/public/`).
- Cada parceiro acessa via `/parceiro/<slug>/`. O slug é o identificador da loja (ex: `rio-do-ouro`).
- Papéis de login: **owner** (dono, vê tudo) e **funcionario** (acesso configurável pelo dono).
- Funcionalidades: estoque, vendas, pedidos, clientes, entregas, financeiro, chat, configurações.

**(c) Camada "Rede/Matriz"** (código em `src/admin/` e `src/atendente-v2/fulfillment.ts`)
- Agrega vários parceiros, roteia pedidos do bot, gera a fatura de comissão para cada parceiro.
- A "Matriz" é uma entidade virtual: quando nenhum parceiro atende o pedido, ele vai para o
  estoque da matriz (São Gonçalo).

### Banco de dados

Postgres no Supabase, projeto único chamado "Farejador" = produção.
- Schema `network.*` — parceiros, unidades, cobertura geográfica, permissões, tokens de acesso.
- Schema `commerce.*` — pedidos, catálogo, frete, geo.
- Schema `analytics.*` — tabela `fact_evidence` com trigger append-only (imutável; conversa real
  gera ~50 linhas que nunca podem ser apagadas).
- Coluna `environment` em todas as tabelas de dados: `'prod'` ou `'test'`. O ambiente `test` é
  usado para testes sem poluir analytics imutável.

### Parceiros reais em produção (2026-06-06)

| Slug | Nome | Cidade atendida |
|---|---|---|
| `rio-do-ouro` | Borracharia Rio do Ouro | Itaboraí |
| `anderson-tavares` | Anderson Tavares | Niterói |

### Arquitetura de migrations

Migrations numeradas sequencialmente. Última aplicada em produção antes desta sessão: `0086`.
A migration desta sessão é a `0087`. Não foi aplicada ainda.

---

## 1. O que esta sessão fez — resumo executivo

Esta sessão executou a **Fase 1** do plano
`docs/PLANO_CONFIG_LOJA_E_ROTEAMENTO_REDE_2026-06-05.md`.

A Fase 1 consiste em:
1. Uma **tela "Configurações da Loja"** no painel do parceiro (4 abas: dados da loja, atendimento,
   área de entrega, equipe/permissões).
2. **Permissões de tela por funcionário** — o dono pode ligar/desligar telas para o funcionário,
   incluindo as telas de dinheiro (Resumo e Financeiro).
3. **Ajuste no bot**: pergunta de modalidade (entrega ou retirada?) no fechamento de pedido +
   endurecimento das CRITICAL RULES para proibir promessas de prazo/horário sem fonte de tabela.

**Estado atual (2026-06-06):** TUDO NÃO-COMITADO, NÃO-APLICADO.
Todo o código está no working tree (modificações locais). A migration `0087` ainda não foi
aplicada ao banco. O dono (Wallace) quer revisar antes de tocar o banco/produção.

Orquestração: Claude (Opus 4.8) sobre subagentes `banco`, `parceiro`, `bot`, `seguranca`
(todos Opus 4.8).

---

## 2. As 5 decisões do dono fechadas em 2026-06-05

Estas decisões foram tomadas por Wallace antes da execução. As decisões 1-4 travam apenas
a Fase 2 (não construída). A decisão 5 influencia o bot.

| # | Decisão | Resolução |
|---|---|---|
| 1 | Tentar o 2º parceiro da área antes de cair na matriz? | **SIM** |
| 2 | Janela do "acionou menos" (régua de justiça entre parceiros)? | **7 dias** (curta = re-nivela rápido) |
| 3 | Empurrão do parceiro novato? | **Suave** — semente na mediana, `COLD_START_FATOR=1.0` (novato entra no nível da galera e disputa igual) |
| 4 | Retirada (pickup) vira caminho do parceiro? | **SIM** — cliente agenda, vai à unidade, pneu é colocado lá; financeiro só baixa quando o parceiro marca "cliente retirou"; **fica na Fase 2** (`PICKUP_TO_PARTNER`) |
| 5 | Gate programático (porteiro/SayValidator) agora? | **NÃO** — testar ao vivo confiando no modelo; sem detector de fumaça embutido (só observar; reativar se o bot errar nos testes) |

---

## 3. Arquitetura da solução — Fase 1 versus Fase 2

### Fase 1 (construída nesta sessão, aguardando deploy)

- Tela Configurações + permissões de funcionário no painel.
- Bot pergunta "entrega ou retirada?" e não mais promete horário/prazo sem fonte.
- Com apenas 1 parceiro por cidade (situação atual), **o roteamento do bot não muda**: a pergunta
  de modalidade apenas coleta a intenção do cliente para o campo `modalidade` de `criar_pedido`.
- Princípio inegociável: todo default novo reproduz o comportamento de hoje. Anderson/Rio do Ouro
  roteiam idêntico até o dono editar.

### Fase 2 (projetada, NÃO construída)

Motor de escolha entre vários parceiros, cada peça atrás de uma feature flag. Flag desligada =
comportamento byte-idêntico ao de hoje. Flags: `ROUTING_MULTI_CANDIDATE`, `ROUTING_MODE_FILTER`,
`ROUTING_NEIGHBORHOOD`, `ROUTING_FAIRNESS`, `PICKUP_TO_PARTNER`.

**Descompasso importante da Fase 1 a registrar:** o bot já PERGUNTA "entrega ou retirada?",
mas na Fase 1 a retirada ainda cai na **matriz** (o parceiro NÃO recebe pedido de retirada). O
loop retirada-no-parceiro é Fase 2 (`PICKUP_TO_PARTNER`).

---

## 4. O que foi feito, peça por peça

### 4a. Banco — migration `0087_partner_store_config_and_delivery_areas.sql`

Arquivo: `db/migrations/0087_partner_store_config_and_delivery_areas.sql`
Status: **escrita, NÃO aplicada**.
Caráter: 100% aditiva/retrocompatível. Só `ADD COLUMN IF NOT EXISTS`, `CREATE TABLE`,
troca de índice UNIQUE, CHECKs e backfill. Zero `DROP` de dado.

**Tabela `network.partner_units` — colunas adicionadas:**

| Coluna | Tipo | Default | Papel |
|---|---|---|---|
| `service_mode` | `TEXT NOT NULL` | `'both'` | CHECK `IN ('delivery','pickup','both')`. Default `'both'` = atende entrega e retirada (= comportamento de hoje) |
| `opening_hours_text` | `TEXT` | `NULL` | Horário em texto livre (ex: "Seg–Sex 8h–18h"). NULL = bot não fala horário |
| `address_street` | `TEXT` | `NULL` | Rua do endereço estruturado da unidade |
| `address_number` | `TEXT` | `NULL` | Número |
| `address_neighborhood` | `TEXT` | `NULL` | Bairro |
| `address_city` | `TEXT` | `NULL` | Cidade |
| `address_complement` | `TEXT` | `NULL` | Complemento |
| `cep` | `TEXT` | `NULL` | CEP (texto, sem máscara obrigatória) |
| `address_confirmed_at` | `TIMESTAMPTZ` | `NULL` | Auditoria: quando o dono confirmou o endereço |

Arbitragem A (do orquestrador): horário em TEXTO, não jsonb. O bot só diz o horário, não calcula
"aberto agora". Estruturado entra quando existir "aberto agora".

**Tabela `network.unit_coverage` — colunas adicionadas:**

| Coluna | Tipo | Default | Papel |
|---|---|---|---|
| `neighborhood_canonical` | `TEXT` | `NULL` | NULL = cobre a cidade inteira (= hoje). Preenchido = cobre só aquele bairro (normalizado `lower(unaccent)`) |
| `coverage_kind` | `TEXT NOT NULL` | `'city'` | CHECK casado: `'city'` implica `neighborhood_canonical IS NULL`; `'neighborhood'` implica `neighborhood_canonical IS NOT NULL` |

Backfill: `UPDATE network.unit_coverage SET coverage_kind = 'city' WHERE neighborhood_canonical IS NULL AND coverage_kind IS DISTINCT FROM 'city'` — garante que linhas existentes ficam marcadas corretamente.

Troca de índice único:
- Antes: `UNIQUE (environment, unit_id, municipio)` — criado na migration 0083 como constraint.
- Depois: índice funcional `unit_coverage_unit_municipio_bairro_uq` em 4 colunas:
  `(environment, unit_id, municipio, coalesce(neighborhood_canonical, ''))`.

Isso permite coexistir "cidade inteira" (bairro NULL → coalesce '') + N bairros no mesmo município
sem colisão de chave.

**Nova tabela `network.partner_unit_permissions`:**

Tabela 1:1 com `network.partner_units` (PK = `partner_unit_id`). Permissões de tela do
funcionário. Colunas booleanas explícitas (arbitragem C: não jsonb — é autorização lida em todo
request, tem que ser auditável e impossível de vir com chave inesperada).

```sql
CREATE TABLE IF NOT EXISTS network.partner_unit_permissions (
  partner_unit_id  UUID PRIMARY KEY REFERENCES network.partner_units(id),
  environment      env_t NOT NULL,
  allow_vendas     BOOLEAN NOT NULL DEFAULT true,
  allow_estoque    BOOLEAN NOT NULL DEFAULT true,
  allow_pedidos    BOOLEAN NOT NULL DEFAULT true,
  allow_clientes   BOOLEAN NOT NULL DEFAULT true,
  allow_entregas   BOOLEAN NOT NULL DEFAULT true,
  allow_batepapo   BOOLEAN NOT NULL DEFAULT true,
  allow_resumo     BOOLEAN NOT NULL DEFAULT false,
  allow_financeiro BOOLEAN NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Defaults reproduzem a "Etapa 4" atual: operacional ON; Resumo e Financeiro OFF (funcionário
existente não muda de comportamento). Linha ausente = código aplica os mesmos defaults sem
precisar existir linha.

Não existe coluna `config`: Configurações é cadeado duro — nunca liberável por permissão.

Triggers: `partner_unit_permissions_set_updated_at` (updated_at automático),
`env_match_partner_unit_permissions_unit` (env da linha tem que bater com o env da unidade),
`env_immutable_partner_unit_permissions` (environment imutável após insert).

**Ajuste acoplado — `src/admin/painel/queries.ts`, função `createPartnerUnit`:**

O índice de `unit_coverage` mudou de 3 para 4 colunas. A função `createPartnerUnit` (linha ~722)
tinha `ON CONFLICT (environment, unit_id, municipio)` — que quebraria porque a constraint foi
removida. Foi alterado para:

```sql
ON CONFLICT (environment, unit_id, municipio, coalesce(neighborhood_canonical, '')) DO NOTHING
```

Este ajuste DEVE subir no **mesmo deploy** da 0087. Se o backend novo subir sem a 0087, ou a
0087 subir sem o backend novo, o cadastro de parceiro novo quebra.

**Script de não-regressão: `scripts/checar-naoregressao-roteamento.cjs`**

Read-only (SELECT puro com BEGIN/ROLLBACK por garantia). Roda a mesma query de
`resolveUnitForMunicipio` (código em `src/atendente-v2/fulfillment.ts`) e verifica:

- `itaborai` → parceiro com nome contendo `'rio do ouro'` (Borracharia Rio do Ouro)
- `niteroi` → parceiro com nome contendo `'anderson'` (Anderson Tavares)

Saída com código `!= 0` se divergir. Deve rodar com `DATABASE_URL` apontando para prod,
**antes E depois** de aplicar a 0087. O resultado tem que ser idêntico nos dois momentos.

Uso: `node scripts/checar-naoregressao-roteamento.cjs`

---

### 4b. Parceiro — tela Configurações e permissões de funcionário

**Arquivos modificados:** `src/parceiro/auth.ts`, `src/parceiro/queries.ts`,
`src/parceiro/route.ts`, `parceiro/public/index.html`, `parceiro/public/app.js`,
`parceiro/public/style.css`.

#### Novos tipos e constantes em `src/parceiro/auth.ts`

```typescript
export const PARTNER_SCREENS = [
  'vendas', 'estoque', 'pedidos', 'clientes', 'entregas', 'batepapo', 'resumo', 'financeiro',
] as const;
export type PartnerScreen = (typeof PARTNER_SCREENS)[number];
export type PartnerPermissions = Record<PartnerScreen, boolean>;
```

Nota: `'config'` NÃO está na `PARTNER_SCREENS`. Esta é a allowlist canônica — qualquer chave
fora daqui é ignorada na escrita.

Defaults hard-coded (linha ausente em `partner_unit_permissions` → estes valores):

```typescript
const EMPLOYEE_DEFAULT_PERMISSIONS: PartnerPermissions = {
  vendas: true, estoque: true, pedidos: true, clientes: true,
  entregas: true, batepapo: true, resumo: false, financeiro: false,
};
const OWNER_PERMISSIONS: PartnerPermissions = {
  vendas: true, estoque: true, pedidos: true, clientes: true,
  entregas: true, batepapo: true, resumo: true, financeiro: true,
};
```

#### Novo guard `requireScreen(tela)` em `src/parceiro/auth.ts`

Existe ao lado de `requireOwner` (que continua existindo e é o cadeado de Configurações).

- Owner: passa sempre (sem I/O).
- Funcionário: lê `network.partner_unit_permissions` (pool admin, escopado por
  `partner_unit_id + environment`); tela desligada → HTTP 403 real com
  `{ error: 'partner_forbidden_screen', screen }`.

Fail-safe (gate §5.3): qualquer erro ao ler o perfil → devolve `EMPLOYEE_DEFAULT_PERMISSIONS`
(Resumo/Financeiro OFF). Nunca "deixa passar" liberando dinheiro.

```typescript
export function requireScreen(screen: PartnerScreen) {
  return async function requireScreenGuard(request, reply) {
    const context = request.partnerContext;
    if (!context) { reply.status(401)...; return; }
    if (context.role === 'owner') return;  // passa direto sem I/O
    const permissions = await resolvePartnerPermissions(context);
    if (!permissions[screen]) {
      reply.status(403).send({ error: 'partner_forbidden_screen', screen });
    }
  };
}
```

#### Função `resolvePartnerPermissions` em `src/parceiro/auth.ts`

Chamada por `requireScreen` e por `GET /api/me`. Pool admin (não pool restrito — `farejador_partner_app`
não tem grant em `partner_unit_permissions`). Query:

```sql
SELECT allow_vendas, allow_estoque, allow_pedidos, allow_clientes,
       allow_entregas, allow_batepapo, allow_resumo, allow_financeiro
  FROM network.partner_unit_permissions
 WHERE partner_unit_id = $1 AND environment = $2
```

#### 6 endpoints novos em `src/parceiro/route.ts` — todos `ownerOnly`

| Método | Rota | Função de query | Descrição |
|---|---|---|---|
| `GET` | `/parceiro/:slug/api/configuracoes` | `getPartnerConfiguracoes` | Lê tudo: dados da loja + service_mode + cobertura + permissões efetivas |
| `PUT` | `.../configuracoes/loja` | `updatePartnerLoja` | Nome de exibição, endereço estruturado, horário |
| `PUT` | `.../configuracoes/atendimento` | `updatePartnerAtendimento` | 2 booleans → enum `service_mode` |
| `PUT` | `.../configuracoes/area` | `updatePartnerArea` | Cidade inteira vs bairros específicos |
| `GET` | `.../configuracoes/bairros` | `searchPartnerBairros` | Busca de bairros (digita "copa" → Copacabana) |
| `PUT` | `.../configuracoes/permissoes` | `upsertPartnerPermissions` | Upsert de permissões de tela do funcionário |

Mapeamento de checkboxes para enum (rota `atendimento`):
```typescript
const serviceMode: PartnerServiceMode = faz_entrega && tem_retirada
  ? 'both'
  : (faz_entrega ? 'delivery' : 'pickup');
```

Ponto importante: o schema `configPermissoesSchema` usa `.passthrough()` pra tolerar chaves
extras no corpo, mas a query `upsertPartnerPermissions` descarta qualquer chave fora da allowlist
`PARTNER_SCREENS` — defesa em profundidade (gate §5.2).

#### `GET /api/me` agora devolve `permissions`

O endpoint existente foi modificado para incluir o mapa efetivo das 8 telas, resolvido no
servidor (gate §5.5). Nunca aceito do cliente:

```typescript
fastify.get('/parceiro/:slug/api/me', { preHandler: requirePartnerAuth }, async (req, reply) => {
  const ctx = getPartnerContext(req);
  const permissions = await resolvePartnerPermissions(ctx);
  return reply.status(200).send({ role: ctx.role, slug: ctx.slug,
    partner_name: ctx.partnerName, unit_name: ctx.unitName, permissions });
});
```

#### Trocas de guard nas rotas existentes

Estas rotas mudaram de guard. A coluna "Antes" é o que estava em produção; "Depois" é o
working tree atual:

| Rota | Antes | Depois |
|---|---|---|
| `GET /api/resumo` | `ownerOnly` | `[requirePartnerAuth, requireScreen('resumo')]` |
| `GET /api/fluxo-caixa` | `ownerOnly` | `financeiroScreen` (= `[requirePartnerAuth, requireScreen('financeiro')]`) |
| `GET /api/despesas` | `ownerOnly` | `financeiroScreen` |
| `GET /api/compras` | `ownerOnly` | `financeiroScreen` |
| `GET /api/contas-a-pagar` | `ownerOnly` | `financeiroScreen` |
| `GET /api/contas-a-receber` | `ownerOnly` | `financeiroScreen` |
| `POST .../contas-a-pagar` (nova conta) | `ownerOnly` | `financeiroScreen` |
| `POST .../contas-a-receber` (nova conta) | `ownerOnly` | `financeiroScreen` |
| `POST .../contas-a-receber/:receivableId/parcelas/:installmentId/receber` | `ownerOnly` | `financeiroScreen` |
| `POST .../contas-a-pagar/:id/pagar` | `ownerOnly` | `financeiroScreen` |
| `POST .../contas-a-receber/:id/receber` | `ownerOnly` | `financeiroScreen` |
| `PATCH .../contas-a-pagar/:payableId` | `ownerOnly` | `financeiroScreen` |
| `PATCH .../contas-a-receber/:receivableId` | `ownerOnly` | `financeiroScreen` |
| `DELETE .../contas-a-pagar/:id` | `ownerOnly` | `financeiroScreen` |
| `DELETE .../contas-a-receber/:id` | `ownerOnly` | `financeiroScreen` |
| `DELETE .../compras/:id` | `ownerOnly` | `financeiroScreen` |
| `DELETE .../despesas/:id` | `ownerOnly` | `financeiroScreen` |
| `POST .../despesas` | `ownerOnly` | `financeiroScreen` |
| `GET /api/vendas` | `requirePartnerAuth` | `[requirePartnerAuth, requireScreen('vendas')]` |
| `POST /api/vendas` | `requirePartnerAuth` | `[requirePartnerAuth, requireScreen('vendas')]` |
| `DELETE /api/vendas/:orderId` | `requirePartnerAuth` | `[requirePartnerAuth, requireScreen('vendas')]` |
| `GET /api/estoque` | `requirePartnerAuth` | `[requirePartnerAuth, requireScreen('estoque')]` |
| `POST /api/estoque` | `requirePartnerAuth` | `[requirePartnerAuth, requireScreen('estoque')]` |
| `DELETE /api/estoque/:stockId` | `requirePartnerAuth` | `[requirePartnerAuth, requireScreen('estoque')]` |
| `GET /api/clientes` | `requirePartnerAuth` | `[requirePartnerAuth, requireScreen('clientes')]` |
| `POST /api/clientes` | `requirePartnerAuth` | `[requirePartnerAuth, requireScreen('clientes')]` |
| `PUT /api/clientes/:id` | `requirePartnerAuth` | `[requirePartnerAuth, requireScreen('clientes')]` |
| `DELETE /api/clientes/:id` | `requirePartnerAuth` | `[requirePartnerAuth, requireScreen('clientes')]` |
| `POST /api/entregas/:orderId` | `requirePartnerAuth` | `[requirePartnerAuth, requireScreen('entregas')]` |
| `GET /api/chat/conversations` | `requirePartnerAuth` | `[requirePartnerAuth, requireScreen('batepapo')]` |
| `GET .../conversations/:id/messages` | `requirePartnerAuth` | `[requirePartnerAuth, requireScreen('batepapo')]` |
| `GET .../conversations/:id/customer` | `requirePartnerAuth` | `[requirePartnerAuth, requireScreen('batepapo')]` |
| `POST .../conversations/:id/send` | `requirePartnerAuth` | `[requirePartnerAuth, requireScreen('batepapo')]` |
| `POST .../conversations/:id/read` | `requirePartnerAuth` | `[requirePartnerAuth, requireScreen('batepapo')]` |
| `POST .../conversations/:id/link-customer` | `requirePartnerAuth` | `[requirePartnerAuth, requireScreen('batepapo')]` |
| SSE `GET /api/chat/stream` | check inline: só `requirePartnerAuth` | check inline adicionado: se funcionário e `!permissions.batepapo` → 403 |

**Mantidos `ownerOnly` cru** (cadeado duro): `/configuracoes*`, `/funcionarios*`.

**Mantidos abertos** (`requirePartnerAuth` sem `requireScreen`): `/produtos` (catálogo PDV),
`/clientes/buscar` (busca pelo PDV e pelo chat), `/catalogo/busca`.

Decisão técnica: toda a Config usa o **pool admin** (`pool` de `src/persistence/db.js`, role
`postgres`, `BYPASSRLS`), não o pool restrito `partnerPool`. A role `farejador_partner_app` não
tem grant em `partner_unit_permissions` nem em `network.unit_coverage`. Isolamento garantido
pelo `WHERE partner_unit_id = ctx.partnerUnitId` em cada call site.

#### Tela Config no front (`parceiro/public/index.html` + `parceiro/public/app.js`)

4 abas internas dentro da seção `config`:

| Aba (valor de `configTab`) | Conteúdo |
|---|---|
| `'loja'` | Nome de exibição, endereço estruturado (rua/número/bairro/cidade/CEP/complemento), horário em texto livre |
| `'atendimento'` | 2 checkboxes: "Faço entrega" e "Tem retirada na loja" (pelo menos um) |
| `'area'` | Toggle "Atendo a cidade inteira" vs "Atendo bairros específicos"; busca de bairros com chips removíveis (via `GET .../bairros?q=...`). Fase 1 = declarativo (grava e exibe; o bot não filtra por bairro ainda) |
| `'equipe'` | Card de funcionários (Etapa 4) + sub-seção de permissões com 8 checkboxes; `'config'` nunca aparece |

`canSee(tela)` no Alpine.js: função nova que lê `this.permissions[tela]` (mapa vindo do
`/api/me`). Usada para pintar o menu (Resumo e Financeiro passam de `x-show="isOwner"` para
`x-show="canSee('resumo')"` e `x-show="canSee('financeiro')"`). É só pintura de UI; a trava
real é nos guards do backend.

**Bug latente achado e corrigido:** a seção `config` não estava na lista `x-show` do
container `pos-shell` (`index.html` linha 123). O container antes listava:

```html
x-show="['resumo', 'vendas', 'pedidos', 'entrega', 'clientes', 'estoque', 'financeiro', 'batepapo'].includes(currentSection)"
```

Ao clicar em Configurações (F9), o `pos-shell` se escondia e apagava a tela inteira. A gestão
de Funcionários (Etapa 4) foi entregue em produção inacessível por esse bug. Corrigido: `'config'`
foi adicionado à lista.

---

### 4c. Bot — ajustes em `src/atendente-v2/prompt.ts`

O arquivo live em produção é `src/atendente-v2/prompt.ts`. O `src/atendente-v2/prompt.legacy-ptbr.ts`
é o arquivo dormante de rollback — não é o prompt ativo.

O campo `modalidade` (enum `'delivery' | 'pickup'`, required) já existia em `criar_pedido`
(`src/atendente-v2/tools.ts`, linha 152: `modalidade: { type: 'string', enum: ['delivery', 'pickup'] }`).
O que esta sessão mudou foi o **fluxo de prompt** e as **CRITICAL RULES**.

#### Regras novas adicionadas às CRITICAL RULES

Dois itens novos inseridos após a regra "Never invent price, stock...":

```
- NEVER promise timing, schedule or open/closed status that did not come from a tool.
  Specifically FORBIDDEN unless it came verbatim from buscar_politica: "entrego hoje",
  "sai hoje", "sai pela manhã", "sai pra entrega", "chega amanhã", "tá aberto agora",
  "entrego rápido", or any same-day/next-day/delivery-window claim. If the customer asks
  when it arrives or if you are open now, do NOT guess — call buscar_politica; if it has
  no answer, say you will check ("já confirmo isso pra ti") instead of inventing one.

- STORE HOURS and STORE ADDRESS may ONLY be stated using what buscar_politica returns.
  Never invent or estimate them. If buscar_politica does not return the address/hours,
  say you will check — do not make one up.
```

#### Closing flow (passos 3-6) reescrito para capturar modalidade

Antes do diff, o fluxo era:

```
3. [confirma interesse] → call calcular_frete → mostra total → pede fechamento
4. Se cliente disse "vou retirar" → skip frete, diz endereço via buscar_politica
5. [total confirmado] → pede rua+número+pagamento
6. [com tudo] → call criar_pedido; se delivery, passa valor_frete do calcular_frete
```

Depois do diff, o fluxo é:

```
3. [confirma interesse] → determina modalidade (ver MODALITY abaixo) ANTES do frete
4. Branching:
   - Se delivery: call calcular_frete → mostra total = produto + frete → "Bora fechar?"
   - Se pickup: skip frete; diz endereço via buscar_politica → "Bora fechar?"
5. [modalidade/total confirmado] → pede só o que falta:
   - delivery: rua + número (bairro já sabe) + pagamento
   - pickup: só pagamento (sem endereço de entrega)
6. [com tudo] → call criar_pedido com modalidade='delivery' ou 'pickup'.
   Se delivery: passa valor_frete do calcular_frete e endereco_entrega.
   Se pickup: omite valor_frete (ou 0) e omite endereco_entrega.
```

Bloco novo `MODALITY`:

```
MODALITY — ask delivery or pickup right after acceptance, before freight:
- If the customer ALREADY gave a delivery address, or already said "entrega"/"entrega
  aí"/"manda aí" or similar → assume delivery. Do NOT ask. Go straight to calcular_frete.
- If the customer already said "vou retirar", "vou buscar", "retiro aí" or similar →
  assume pickup. Do NOT ask.
- OTHERWISE, ask exactly once: "É pra entregar no teu endereço ou retirar na loja?"
  and end with OPCOES: Entrega | Retirada. Store the answer as the modalidade for
  criar_pedido.
- This question only captures the customer's intent — it does NOT change which store
  fulfills (one store per city today). Ask it naturally; do not explain why.
```

#### Exemplo reescrito no prompt

Antes:
```
A loja fica em São Gonçalo mas entrego no Rio inteiro, Niterói, Maricá todo dia.
Frete pra teu bairro fica baratinho e sai pela manhã.
```

Depois:
```
A loja fica em São Gonçalo mas entrego no Rio inteiro, Niterói, Maricá.
Frete pra teu bairro fica baratinho.
```

#### Linha de fechamento do resumo reescrita

Antes: `Valeu pela confiança, [nome]! Já separamos e sai pra entrega. Qualquer coisa chama aqui 👍`

Depois: `Valeu pela confiança, [nome]! Já tá separado aqui. Qualquer coisa chama nesse número 👍`

#### SUMMARY RULES atualizadas

Antes: `...before "Já separamos e sai pra entrega". Sounds Brazilian...`
Depois: `...before a neutral closing like "Já tá separado aqui." Sounds Brazilian — customers
expect it. Do NOT promise a delivery time or schedule in this line (no "sai pra entrega",
no "sai hoje/amanhã") unless it came from buscar_politica.`

Antes: `DO NOT write "assim que confirmar o pagamento"...end with "Já separamos e sai pra entrega"`
Depois: `...end with a neutral closing like "Já tá separado aqui" (no payment conditional, and
no invented delivery time).`

---

### 4d. Segurança — gate obrigatório antes do deploy

Gate `seguranca` executado em 2026-06-05. Cinco pontos auditados:

| Ponto | Enunciado | Resultado |
|---|---|---|
| §5.1 | `requireScreen` não afrouxa nada que `requireOwner` trava (owner ≡ passa sempre) | **PASS** — para owner, `requireScreen(x)` ≡ `requireOwner` cru |
| §5.2 | Anti-escalonamento de `config`: nunca marcável, descartado no input, endpoints de Configurações em `requireOwner` cru | **PASS** — `PARTNER_SCREENS` não contém `'config'`; `upsertPartnerPermissions` ignora qualquer chave fora da allowlist; todos os `/configuracoes*` usam `ownerOnly` |
| §5.3 | Fail-safe: erro ao ler o perfil → nega dinheiro, nunca "deixa passar" | **PASS** — `resolvePartnerPermissions` catch → `EMPLOYEE_DEFAULT_PERMISSIONS` (Resumo/Financeiro OFF) |
| §5.4 | Isolamento entre parceiros: todo `GET/PUT /configuracoes*` filtra por `ctx.partnerUnitId` | **PASS com ressalva R1** (ver SEC-002 abaixo) |
| §5.5 | `/api/me.permissions` derivado no servidor, nunca aceito do cliente | **PASS** |

**SEC-002** (criado em `docs/SEGURANCA.md` durante esta sessão):

- Severidade: Média. Não é vazamento hoje; é remoção de defesa-em-profundidade.
- Problema: `network.partner_unit_permissions` (tabela de autorização) é lida e gravada
  exclusivamente pelo pool admin (`BYPASSRLS`) sem RLS própria. Isolamento depende só do
  `WHERE partner_unit_id = ctx.partnerUnitId` em cada call site.
- Por que não foi corrigido agora: mexer no caminho quente de autorização às vésperas do deploy
  com raio de explosão mínimo (2 parceiros, 1 call site, identidade não-injetável do token).
- Gatilho para blindar: antes de a contagem de parceiros crescer / antes do roteamento
  multi-parceiro da Fase 2.

**R2 (baixa):** a permissão `pedidos` está na `PARTNER_SCREENS` mas não há rota backend própria;
`requireScreen('pedidos')` nunca é exercido. A tela Pedidos consome dados de `vendas`/`entregas`.
Cosmética hoje.

**R3 (baixa):** `updatePartnerArea` chaveia cobertura por `unit_id`. Se a expansão da Rede criar
2 `partner_units` sobre o mesmo `unit_id`, reescreveria cobertura compartilhada. Re-verificar
antes de mudar o modelo de unidades.

---

## 5. Estado atual

| Item | Estado |
|---|---|
| Código (working tree) | NÃO comitado — 10 arquivos modificados, 1 arquivo novo |
| Migration `0087` | NÃO aplicada (arquivo em `db/migrations/`, não rodou no banco) |
| `npm run typecheck` (tsc --noEmit) | Limpo (sem erros de tipo) |
| Teste em browser | NÃO realizado nesta sessão |
| Teste contra banco vivo | NÃO realizado (a tela Configurações depende da 0087 estar aplicada) |

**Arquivos tocados no working tree (confirmado via `git diff --stat`):**

| Arquivo | Linhas +/- | Natureza da mudança |
|---|---|---|
| `docs/CONTRATO_ESTOQUE_FINANCEIRO_0076_0077.md` | +64 | ⚠️ PRÉ-EXISTENTE — já estava modificado no working tree antes desta sessão (leva anterior, sobre as migrations 0076/0077). NÃO faz parte da Fase 1; listado só porque aparece no `git diff`. |
| `docs/SEGURANCA.md` | +26 | Adição do SEC-002 |
| `parceiro/public/app.js` | +279 / -33 | `canSee()`, estado de config, 4 abas, funções de save |
| `parceiro/public/index.html` | +195 / -3 | 4 abas de config, fix do pos-shell, canSee no menu |
| `parceiro/public/style.css` | +25 | Estilos das abas de config |
| `src/admin/painel/queries.ts` | +6 / -2 | Ajuste do `ON CONFLICT` em `createPartnerUnit` |
| `src/atendente-v2/prompt.ts` | +26 / -8 | CRITICAL RULES, MODALITY block, closing flow, exemplos |
| `src/parceiro/auth.ts` | +131 | `PARTNER_SCREENS`, `requireScreen`, `resolvePartnerPermissions` |
| `src/parceiro/queries.ts` | +384 | 6 funções de config + upsertPartnerPermissions |
| `src/parceiro/route.ts` | +256 / -20 | 6 endpoints de config, trocas de guard, canSee no /api/me |

**Arquivo novo (untracked):**

| Arquivo | Papel |
|---|---|
| `db/migrations/0087_partner_store_config_and_delivery_areas.sql` | Migration (não aplicada) |
| `scripts/checar-naoregressao-roteamento.cjs` | Script de não-regressão do roteamento |

---

## 6. O que falta — sequência prevista para ir a produção

O plano (§2.5/§8 de `docs/PLANO_CONFIG_LOJA_E_ROTEAMENTO_REDE_2026-06-05.md`) define esta ordem:

1. **Snapshot/shadow** no banco prod (mesmo protocolo das migrations 0076/0077) — capturar o
   estado antes.
2. **Aplicar 0087 no ambiente `test`** (banco apontando para `environment='test'`). Rodar o
   script de não-regressão: `node scripts/checar-naoregressao-roteamento.cjs`.
3. **Aplicar 0087 em prod** imediatamente antes do deploy do backend (on CONFLICT ajustado tem
   que subir junto). Rodar não-regressão novamente.
4. **Deploy do backend + frontend** (os 10 arquivos modificados no working tree).
5. **Gate `seguranca` final** (revisão da aba ao vivo) antes de liberar o acesso à tela.
6. **Validar ao vivo**: criar uma linha em `partner_unit_permissions` via a própria tela;
   confirmar que o funcionário vê/não vê as telas conforme configurado.

Pendente de confirmação com o subagente `banco`: mecânica exata de como a 0087 (DDL puro, sem
stored procedures) se aplica em `test` versus `prod` no Supabase/Coolify.

---

## 7. Fase 2 — projetada, não construída (atrás de flags)

Resumo do plano §3. Ponto de plugagem único: `decideStoreForOrder` em
`src/atendente-v2/fulfillment.ts:349`.

### 7.1 De "pega 1" para "lista de candidatos"

`resolveUnitForMunicipio` (retorna 1 parceiro, permanece como wrapper) → nova
`resolveUnitCandidates(...)` retorna **lista ordenada** sem `LIMIT 1`, consumindo
`coverage_kind`/`neighborhood_canonical`.

### 7.2 Filtros duros (eliminam antes do desempate)

Em ordem:
1. Cobre a área (bairro declarado ou cidade inteira).
2. Modo compatível: cliente quer entrega → `service_mode IN ('delivery','both')`;
   quer retirar → `IN ('pickup','both')`. Flag `ROUTING_MODE_FILTER`.
3. Tem o pneu disponível (`is_tracked AND on_hand - reserved >= qty`), todos os itens.

### 7.3 Régua de justiça — `rankCandidatesByFairness`

Flag `ROUTING_FAIRNESS`. Base: `COUNT(*)` de `partner_orders` com `source_tag='2w'`,
`status <> 'cancelled'`, `created_at >= now() - 7 DAYS`, por `unit_id`. Usa `created_at`
(não `delivered_at`) — o parceiro não controla quando o lead chegou (anti-trapaça).

Cold-start: parceiro novo entra semeado na **mediana** dos ativos, `COLD_START_FATOR=1.0`
(novato disputa igual, sem handicap nem enxurrada). Tie-break determinístico:
`credito ASC → last_lead_at ASC NULLS FIRST → unit_created_at ASC → unit_id`.

### 7.4 Tenta o 2º antes da matriz

Flag `ROUTING_MULTI_CANDIDATE`. No loop: 1º candidato com estoque vence; se falha, tenta o 2º;
só cai na matriz quando nenhum candidato da área tem estoque.

### 7.5 Retirada → parceiro (`PICKUP_TO_PARTNER`)

Hoje (guard H4 no código) pickup sempre vai para a matriz. Com a flag, pode virar
`partner_order` com `fulfillment_mode='pickup'` num parceiro `pickup`/`both`. O recebível
nasce aberto e só baixa quando o parceiro marca "serviço feito / cliente retirou" — análogo
ao `delivered` do COD. Exige novo botão no painel do parceiro.

### 7.6 Fix do funil

`getRedeFunnel` em `src/admin/painel/queries.ts:396` agrupa por `municipio` com `max(po.unit_id)`.
Com 2 parceiros na mesma cidade colapsa os dois numa linha. Fix: agrupar por `(municipio, unit_id)`.
Sobe junto com `ROUTING_MULTI_CANDIDATE`.

### 7.7 Provas no ambiente `test`

Script `scripts/prova-regua-rede-test.cjs` (a criar): chama `decideStoreForItems` diretamente,
`BEGIN ... ROLLBACK`, sem conversa real (sem analytics). Seed de 4 parceiros fake no env `test`:

| Fake | Bairros | Modo | Estoque |
|---|---|---|---|
| A | Copacabana, Botafogo | both | tem (10) |
| B | Copacabana, Botafogo | both | tem (10) |
| C | Méier, Tijuca | só entrega | tem |
| D | Campo Grande, Barra | só retirada | não tem |

5 casos de prova (ver plano §3.8 para detalhes).

---

## 8. Ponteiros — arquivos-chave

| Arquivo | Papel |
|---|---|
| `docs/PLANO_CONFIG_LOJA_E_ROTEAMENTO_REDE_2026-06-05.md` | Contrato completo: Fase 1 + Fase 2 + decisões do dono + arbitragens |
| `db/migrations/0087_partner_store_config_and_delivery_areas.sql` | Migration (NÃO aplicada) |
| `scripts/checar-naoregressao-roteamento.cjs` | Gate de não-regressão de roteamento (rodar antes/depois da 0087) |
| `src/atendente-v2/prompt.ts` | Prompt do bot ativo em produção (modificado) |
| `src/atendente-v2/tools.ts` | Tool definitions do bot; campo `modalidade` em `criar_pedido` |
| `src/atendente-v2/fulfillment.ts` | Roteamento do bot (`resolveUnitForMunicipio`, `decideStoreForItems`) |
| `src/parceiro/auth.ts` | Guards: `requirePartnerAuth`, `requireOwner`, `requireScreen`, `resolvePartnerPermissions`; `PARTNER_SCREENS` |
| `src/parceiro/queries.ts` | Funções de banco do painel: inclui `getPartnerConfiguracoes`, `updatePartnerLoja`, `updatePartnerAtendimento`, `updatePartnerArea`, `searchPartnerBairros`, `upsertPartnerPermissions` |
| `src/parceiro/route.ts` | Endpoints Fastify do painel: 6 novos de config + trocas de guard |
| `parceiro/public/index.html` | SPA Alpine.js: fix do pos-shell + 4 abas de config |
| `parceiro/public/app.js` | Lógica Alpine.js: `canSee()`, `loadConfiguracoes()`, funções de save das abas |
| `parceiro/public/style.css` | Estilos das abas de config |
| `src/admin/painel/queries.ts` | Painel da matriz; `createPartnerUnit` com `ON CONFLICT` ajustado (deve subir junto com 0087) |
| `docs/SEGURANCA.md` | Backlog de segurança: SEC-001 (aberto), SEC-002 (adicionado nesta sessão) |

---

Documentado por: escriba · Claude Sonnet 4.6
