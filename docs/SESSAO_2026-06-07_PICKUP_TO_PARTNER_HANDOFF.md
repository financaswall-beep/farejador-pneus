# Handoff — Retirada vai pro Parceiro (PICKUP_TO_PARTNER) · 2026-06-07

> Documento de passagem pra próxima IA assumir. Cobre Etapa 1 (roteamento+reserva)
> e Etapa 2 (marcar retirado + cancelar com motivo + anti-trapaça 2W), nos mínimos
> detalhes: decisões do dono, migrations, arquivos, contrato financeiro, como provar
> e o que falta. Sessão conduzida em Opus.

---

## 0. TL;DR (estado atual)

- **Objetivo:** a RETIRADA (pickup) feita pelo bot passa a ir pra **borracharia mais perto**
  (mesmos critérios da entrega: proximidade + régua de justiça) e **RESERVA o pneu** até o
  cliente retirar — antes ela ia direto pra **matriz sem segurar nada** (dava pra prometer o
  último pneu pra dois clientes).
- **Etapa 1 (bot + reserva):** FEITA, PROVADA, **commitada** na branch.
- **Etapa 2 (painel: marcar retirado + cancelar c/ motivo + selo 2W + origem imutável):**
  FEITA, PROVADA, **commitada** na branch.
- **Branch:** `feat/pickup-to-partner` · commit **`0a0cea7`** (11 arquivos). **NÃO está no `main`,
  NÃO foi deployada.**
- **Migrations 0089 + 0090 (+2 fixes) JÁ APLICADAS no banco de prod** (são aditivas e
  **dormentes**: só agem com a flag `PICKUP_TO_PARTNER` ligada, que está **desligada**).
- **Flag mestra:** `PICKUP_TO_PARTNER` (default OFF). Só tem efeito com `ROUTING_GEO=true` +
  coordenada do cliente (pino do WhatsApp OU geocode do bairro, que exige `GOOGLE_MAPS_API_KEY`).
- **Falta:** (1) deploy = merge `feat/pickup-to-partner` → `main` (Coolify auto-deploya);
  (2) ligar `PICKUP_TO_PARTNER=true` no Coolify; (3) validar ao vivo;
  (4) antifraude "cancelar+recriar como porta" (item à parte da matriz);
  (5) documentar o contrato 0089/0090 em `docs/CONTRATO_ESTOQUE_FINANCEIRO_0076_0077.md`.

---

## 1. Decisões de negócio do Wallace (NÃO reabrir sem ele)

1. **Retirada reservada, NÃO vendida antes.** Quando o cliente reserva pra retirar, o pneu fica
   **reservado** (segurado, ainda no estoque) e **nada entra no financeiro** até ele retirar.
   Wallace rejeitou explicitamente a opção "já vende + a receber". → vira venda só no "marcar retirado".
2. **Tudo do bot = origem `2w` (o diferencial da Rede).** Todo pedido do bot (entrega E retirada)
   nasce com `source_tag='2w'`, **imutável**. O borracheiro **não pode** trocar pra "porta" pra fugir
   da comissão. Venda de balcão dele = "porta".
3. **Motivo obrigatório no cancelamento de pedido 2W.** Força justificar o cancelamento de um lead
   da Rede; o motivo fica auditado e alimenta o antifraude da matriz.
4. **Critério de escolha da loja = o mesmo da entrega** (proximidade + régua de justiça). Anel de
   retirada = **15 km único** (decisão D2: o cliente vai até a loja). Entrega = anéis 10→20→30 km.

---

## 2. Como funciona, ponta a ponta (depois de ligado)

### 2.1 Bot cria a retirada (reserva)
`src/atendente-v2/tools.ts` → `criarPedido()`:
- Ramo novo: `else if (modalidade === 'pickup' && env.PICKUP_TO_PARTNER)`.
- Resolve o município (do `geo_resolution_id` se houver, senão de `args.bairro` via
  `resolveMunicipioFromBairro`).
- Resolve a coordenada do cliente: `resolveCustomerLocation()` = pino mais recente da conversa →
  senão geocode do bairro (**precisa `GOOGLE_MAPS_API_KEY`**) → senão `null`.
- Se tem município + coordenada + `ROUTING_GEO`: chama `decideStoreForItemsGeo(modalidade:'pickup')`
  (anel de 15 km, régua de justiça entre o pool). Casos: `partner` → materializa; `only_far` →
  devolve `apenas_longe` (pergunta antes de criar, igual entrega); `matriz` → cai na matriz.
- Sem coordenada/flag → **matriz** (comportamento de hoje).
- Materializa com `materializePartnerOrder(..., fulfillment_mode:'pickup', freight:0, reserve_for_pickup:true)`.

`src/atendente-v2/fulfillment.ts` → `materializePartnerOrder()`:
- Passa o 14º arg `p_reserve_for_pickup=true` pra `register_partner_local_order` → **reserva** (não baixa).
- Faz `UPDATE partner_orders SET awaiting_pickup=true`.
- **Pula** a criação da conta a receber (sem recebível na reserva).

### 2.2 Painel do parceiro
`parceiro/public/index.html` + `app.js`, seção `currentSection === 'entrega'`:
- Painel **"Retiradas aguardando"** (só aparece se `pickupAwaitingCount > 0`). Getter
  `pickupAwaiting` = `vendas` com `fulfillment_mode==='pickup' && awaiting_pickup && status!=='cancelled'`.
- **Marcar retirado** (`markRetrieved`) → `POST /parceiro/:slug/api/retiradas/:orderId` com
  `payment_method` (Pix/Dinheiro/Cartão, default Pix).
- **Cancelar** (`openCancelOrder` → textarea de motivo → `confirmCancelOrder`) →
  `DELETE /parceiro/:slug/api/vendas/:orderId` com body `{reason}`. Motivo **obrigatório** se `isTwoW`.
- **Selo 2W** verde no card de entrega e de retirada (`isTwoW(d)`).
- Entrega também ganhou motivo no "não entregue" (prompt → `setDeliveryStatus(sale,'failed',reason)`).

### 2.3 Marcar retirado (backend)
`src/parceiro/queries.ts` → `markPartnerPickupRetrieved()`:
1. `SELECT commerce.complete_partner_pickup(orderId, actor)` → converte **reserva → baixa física**.
2. `UPDATE partner_orders SET awaiting_pickup=false, retrieved_at=now(), status='paid'`.
3. Cria conta a receber **já `received`** (caixa entra), `source_tag='2w'`, `payment_method` do balcão,
   idempotency `order:<id>:pickup-receivable`.
4. Audit `partner_pickup_retrieved`. Idempotente (re-clique seguro: `complete_partner_pickup` levanta
   erro se não estiver `awaiting_pickup`; guard no TS lança `PickupAlreadyRetrievedError`).

### 2.4 Realização da venda (contrato financeiro)
A retirada **aguardando NÃO conta como venda**; conta **quando retirada** (na data `retrieved_at`).
Mesma régua da entrega (que só conta em `delivered_at`). Lugares ajustados:
- `network.partner_unit_summary` (view 0090): `orders_month`/`cogs_month` ganham `AND NOT awaiting_pickup`
  e a data vira `CASE delivery→delivered_at, senão COALESCE(retrieved_at, created_at)`.
- `src/parceiro/queries.ts` `REALIZED_SALE` (métricas do cliente no chat): `+ AND NOT awaiting_pickup`.
- `src/admin/painel/queries.ts` `realizedWhere`/`isRealizedExpr`/`realizedDate`: `+ AND NOT po.awaiting_pickup`
  e data `COALESCE(retrieved_at, created_at)` pra pickup.
- **Caixa já estava certo**: a retirada reservada tem `payment_method='A receber'` e nenhum recebível,
  então não entra no caixa até o "marcar retirado" criar o recebível `received`.

---

## 3. Migrations (TODAS já aplicadas em prod — banco é UM só, test+prod compartilham)

> ⚠️ O banco do projeto Farejador (Supabase ref `aoqtgwzeyznycuakrdhp`) é compartilhado: `test` e
> `prod` são a MESMA base, separados pela coluna `environment`. Funções/colunas/views são
> compartilhadas. Por isso, pra provar no `test` foi preciso aplicar no banco (afeta prod), mas tudo
> é aditivo + atrás de flag → prod não muda até deployar+ligar.

### 0089 — `db/migrations/0089_partner_reserve_for_pickup.sql`
- DROP+CREATE `commerce.register_partner_local_order` adicionando **`p_reserve_for_pickup boolean DEFAULT false`** (14º param, no fim).
- `false` (padrão) = byte-idêntico ao de hoje (balcão 13 args + entrega do bot intactos).
- `true` + `fulfillment_mode='pickup'` → **reserva** (`quantity_reserved += qty`) em vez de baixar (`quantity_on_hand -= qty`).
- Evento de estoque: `stock_reserved` quando reserva.

### 0090 — `db/migrations/0090_partner_pickup_retrieve_and_source_lock.sql`
1. `ALTER partner_orders ADD awaiting_pickup boolean NOT NULL DEFAULT false`, `ADD retrieved_at timestamptz`.
2. **Origem imutável:** `commerce.enforce_partner_order_source_immutable()` + trigger
   `partner_orders_source_immutable` (`BEFORE UPDATE OF source_tag`) → recusa mudar `source_tag` (erro 23514).
3. `commerce.complete_partner_pickup(order_id, actor)` → reserva→baixa física (irmã de
   `deliver_partner_local_order`, mas exige `fulfillment_mode='pickup'` + `awaiting_pickup=true`).
4. Recria `network.partner_unit_summary` (exclui awaiting + data retrieved_at — ver §2.4).
5. **Fix do cancelar** (`commerce.cancel_partner_local_order`): antes só liberava reserva pra
   `delivery` pending/dispatched; pickup caía no ELSE que **somava on_hand** → bug que inflava o
   estoque numa retirada reservada. Agora `v_release_reserve` também cobre
   `pickup AND awaiting_pickup` → libera a reserva certo.
6. Recria `commerce.partner_orders_full` adicionando `awaiting_pickup`, `retrieved_at` no fim
   (a view é fixa; `CREATE OR REPLACE` só permite acrescentar colunas no fim).

> Aplicadas via `apply_migration` (MCP Supabase) em 4 chamadas:
> `partner_reserve_for_pickup`, `partner_pickup_retrieve_and_source_lock`,
> `cancel_releases_reserve_for_pickup`, `partner_orders_full_expose_pickup_cols`.
> Rollback: as definições antigas das funções estão no histórico desta sessão / recuperáveis via
> `pg_get_functiondef` antes da troca (ver §8).

---

## 4. Flags (`src/shared/config/env.ts`, `booleanStringSchema` = default `false`)

| Flag | Papel | Estado |
|---|---|---|
| `PICKUP_TO_PARTNER` | **NOVA.** Liga a retirada→parceiro. Só age com ROUTING_GEO + coordenada. | OFF (a ligar) |
| `ROUTING_GEO` | escolhe loja por proximidade (anel) | Coolify=true |
| `ROUTING_GEO_ROAD_DISTANCE` | distância de rua (Google) em vez de linha reta | Coolify=true |
| `ROUTING_MULTI_CANDIDATE` | considera vários parceiros na cidade | Coolify=true |
| `ROUTING_FAIRNESS` | régua de justiça (quem recebeu menos lead) | Coolify=true |
| `GOOGLE_MAPS_API_KEY` | geocode do bairro + Distance Matrix. **Sem ela, endereço digitado não vira coordenada** (só pino). | Wallace disse que **preencheu** (2026-06-07) |

Anéis (`src/shared/geo/ring.ts`): entrega `GEO_RING_KM=[10,20,30]`, retirada `GEO_PICKUP_RADIUS_KM=15`.
Princípio (ring.ts): *"proximidade FILTRA quem pode disputar; a justiça DECIDE quem ganha."*

---

## 5. Arquivos tocados (commit 0a0cea7)

| Arquivo | O que mudou |
|---|---|
| `db/migrations/0089_*.sql` | param `p_reserve_for_pickup` (reserva na retirada) |
| `db/migrations/0090_*.sql` | colunas + complete_partner_pickup + origem imutável + view summary + fix cancelar + view orders_full |
| `src/shared/config/env.ts` | flag `PICKUP_TO_PARTNER` |
| `src/atendente-v2/tools.ts` | ramo pickup no `criarPedido`; materialize mode-aware (frete 0, reserve_for_pickup); descrição do `bairro` no schema |
| `src/atendente-v2/fulfillment.ts` | `BotPartnerOrderInput.reserve_for_pickup`; 14º arg; `awaiting_pickup=true`; pula recebível na reserva |
| `src/parceiro/queries.ts` | `markPartnerPickupRetrieved` + `PickupAlreadyRetrievedError`; `cancelPartnerSale(reason)`; `REALIZED_SALE += NOT awaiting_pickup`; `getPartnerVendas` retorna awaiting_pickup/retrieved_at; `UpdatePartnerDeliveryInput.reason` + failed usa o motivo |
| `src/parceiro/route.ts` | `POST /api/retiradas/:orderId`; `DELETE /api/vendas/:orderId` lê `{reason}`; `entregas` POST lê `reason`; schemas `retrieveSchema`/`cancelSchema`; deliverySchema +reason |
| `src/admin/painel/queries.ts` | filtros de venda realizada `+ NOT awaiting_pickup` + data retrieved_at |
| `parceiro/public/app.js` | `pickupAwaiting`, `markRetrieved`, `openCancelOrder/confirmCancelOrder`, `isTwoW`, `pickupPayDrafts`, `cancelOpenId/cancelReasonText`; entrega: motivo via prompt |
| `parceiro/public/index.html` | painel "Retiradas aguardando" + selo 2W (entrega+retirada) |
| `scripts/prova-retirada-reserva-test.ts` | prova end-to-end no env test (7 checks) |

---

## 6. Como provar (env `test`, tudo em BEGIN/ROLLBACK, não persiste)

```bash
npx tsx --env-file=.env scripts/prova-retirada-reserva-test.ts
```
Pré-requisito: seed `scripts/seed-fake-rede-test.cjs` (lojas `geo-*`, produto `FAKE-REDE-PNEU`,
município `zona-sul-geo`, cliente fixo em Copacabana). Os 7 checks:
1. retirada escolhe loja por proximidade (anel ≤15 km);
2. estoque RESERVADO (+1 reservado), on_hand intacto;
3. pedido é pickup 2w no painel; 4. SEM recebível na reserva;
5. balcão (reserve=false) AINDA baixa (invariante);
6. marcar retirado → baixa + libera reserva + pago + retrieved_at + caixa (1 recebível received);
7. cancelar reservada → libera reserva, on_hand intacto;
8. origem 2W imutável (UPDATE source_tag bloqueado).

Outras provas: `npm run typecheck` · `node --check parceiro/public/app.js` · `npx vitest run tests/unit` (314).
Prova de proximidade da entrega (já existia): `scripts/prova-geo-rede-test.ts`.

---

## 7. O que falta (próximos passos)

1. **Deploy (decisão do Wallace):** ligar `PICKUP_TO_PARTNER=true` no Coolify + merge
   `feat/pickup-to-partner` → `main` (Coolify auto-deploya no push pro main, ~2-3 min, lendo a flag).
   Migrations já estão no banco. Validar ao vivo (ver §2 do resumo ao Wallace).
2. **Antifraude "cancelar + recriar como porta"** (item à parte da MATRIZ): o borracheiro pode
   cancelar o 2w e relançar como "porta" pra fugir da comissão. Não tem bloqueio hard; precisa de
   DETECÇÃO na matriz (ex.: 2w cancelado + venda porta do mesmo cliente logo depois). O **motivo do
   cancelamento** (agora gravado no audit) é o insumo. Sessão dedicada.
3. **Documentar o contrato** das mudanças 0089/0090 em
   `docs/CONTRATO_ESTOQUE_FINANCEIRO_0076_0077.md` (ou SECOES/ESTOQUE.md) — reserve-on-pickup,
   complete_partner_pickup, origem imutável, realização por retrieved_at.
4. **Screen de permissão:** o endpoint `/api/retiradas/:orderId` usa `requireScreen('entregas')`
   (mesma da entrega). Se a retirada virar tela própria, revisar.
5. **Limpar dado de teste** se algum proof tiver persistido (os scripts usam ROLLBACK; conferir).

---

## 8. Pegadinhas / contexto operacional

- **Guardrail (auto-mode classifier):** bloqueia `apply_migration` em prod sem autorização explícita
  do Wallace POR migração. Nesta sessão cada migration foi liberada via pergunta direta ("Aplica?").
  A próxima IA vai precisar do "ok" dele de novo, OU ele adiciona uma regra de permissão.
- **`checar-naoregressao` roda SEM `--env-file`** → `.env` tem `FAREJADOR_ENV=test`, pode dar falso
  "regressão". (memória do projeto)
- **Não derrubar servidores/preview** em execução por conta própria (memória do projeto).
- **Banco compartilhado** (test+prod): toda DDL afeta os dois ambientes — por isso só aditivo + flag.
- **`source_tag` imutável**: qualquer UPDATE que tente mudar `source_tag` em `partner_orders` agora
  estoura erro. Nenhum fluxo legítimo muda source_tag (só INSERT na criação) — confirmado por grep.
- **Reserva vs baixa** (contrato): `register_partner_local_order` → delivery reserva, pickup baixa;
  com `p_reserve_for_pickup=true` → pickup reserva. `complete_partner_pickup` → reserva→baixa.
  `deliver_partner_local_order` → reserva→baixa (só delivery). `cancel_partner_local_order` →
  libera reserva (delivery pending/dispatched OU pickup awaiting) senão restaura on_hand.

---

## 9. Git

- Branch: `feat/pickup-to-partner` (criada de `feat/camada-geo-rede` que = `main` no início).
- Commit desta entrega: **`0a0cea7`** — "feat(rede): retirada vai pro parceiro mais perto e reserva o pneu (Etapa 1+2)" (11 arquivos).
- **NÃO está no `main`.** Há arquivos pré-existentes não-commitados na branch (docs/scripts de
  sessões antigas + `dashboard.html` + `src/app/preview-matriz-server.ts` + doc CONTRATO modificado)
  — NÃO fazem parte desta entrega; foram deixados de fora do commit de propósito.

---

## 10. Memória persistente relacionada (`.claude/.../memory/`)

- `project_pickup_to_partner.md` — este trabalho (atualizado).
- `project_camada_geo.md` — motor de proximidade (anéis).
- `project_fase2_motor_distribuicao.md` — régua de justiça.
- `project_regra_distribuicao_rede.md` / `project_config_loja_fase1.md` — regras da Rede.
- `project_estoque_reservado_0076.md` / `project_financeiro_0077.md` — contrato estoque/financeiro base.
- `parceiro_arquitetura.md` — DB é do parceiro; matriz agrega; prod = projeto Farejador.

— Escrito por Claude Opus 4.8 (sessão 2026-06-07). 🐽
