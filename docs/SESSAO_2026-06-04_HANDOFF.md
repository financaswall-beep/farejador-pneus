# Handoff — Sessão 2026-06-04 (Rede em prod, fixes tela Pedidos + SEC-001)

**Pra quem vai continuar (outra LLM/sessão).** Este doc é auto-contido: não depende do histórico
do chat. Plano-mestre da Fundação Bot→Rede: `docs/PLANO_FUNDACAO_BOT_REDE_2026-06-02.md`.

> ⚠️ **Este handoff SUPERA o de 2026-06-03.** Aquele dizia "NADA deployado" — isso está superado.
> A Fundação Bot→Rede está em produção desde 2026-06-03 (validada pelo dono com testes reais no
> WhatsApp). Os commits descritos lá (1db2afc, 6697443, 7eeb191) já estão no ar.

- **Repo:** `C:\Farejador agente` · **Branch:** `feat/fundacao-bot-partner-orders`
- **HEAD atual:** `1d79735` · **Remote de deploy:** `pneus` (github.com/financaswall-beep/farejador-pneus)
- **Deploy:** Coolify deploya o branch `main`; hoje `main == feat` (mesmo commit).
- **Supabase prod (projeto "Farejador"):** `aoqtgwzeyznycuakrdhp` (us-west-2). NÃO confundir com
  `vyxdquwxmgibpkoswxut` ("betaAgente").
- **Data:** 2026-06-04.

---

## 0. TL;DR (o estado em 5 linhas)

A Fundação Bot→Rede está **no ar e funcionando**. Nesta sessão foram entregues 4 commits de
manutenção/fix em cima dessa base: cartão Conversão do Bot no painel da Rede, fix do feed de
lançamentos (status real do pedido, não "Venda" prematura), fix da tela Pedidos (migration 0082,
view genérica multi-parceiro), e **SEC-001** (furo de segurança — consultar_pedido sem amarrar
contato). **O último deploy que entrou foi `fe79047`.** Os commits `f103331` e `1d79735` ainda não
foram deployados — **Redeploy no Coolify é o próximo passo crítico.** Migrations (0081, 0082) já
estão aplicadas em prod.

---

## 1. A LEI e a arquitetura (não quebrar)

> **Cada número tem UM dono. O outro lado só APONTA — nunca guarda uma cópia que pode divergir.**

- **Toda** venda do bot grava em `commerce.orders` (espelho). Analytics EXIGE isso
  (`analytics.v_conversation_summary` liga conversa→pedido por `source_conversation_id`).
- Venda roteada a parceiro **também** grava em `commerce.partner_orders` com `source_tag='2w'`
  (o dono operacional: estoque/COD/recebível). Cobrança 2w da matriz lê `source_tag='2w'` via
  `getPainelRede`.
- Espelho e dono ligados por `commerce.orders.partner_order_id` (FK da migration `0081`, já em
  prod).
- **Roteamento:** `decideStoreForItems(municipio, items)` em `src/atendente-v2/fulfillment.ts`.
  Só vai pro parceiro se TODOS os itens caem no MESMO parceiro com estoque rastreado+disponível;
  senão matriz (backstop). Só `delivery` roteia (pickup→matriz). Frete do parceiro = **R$ 9,90
  fixo** (`FRETE_PADRAO_BRL`).
- Cobertura de região hoje é config hardcoded: `PARTNER_COVERAGE` em `fulfillment.ts`
  (Borracharia = Itaboraí). Vira tabela `network.unit_coverage` quando houver vários parceiros.

**IDs fixos:**
- Matriz `unit_id` = `1742c95e-727b-4bb8-8dff-c419e3e21297`
- Borracharia Rio do Ouro `unit_id` = `36203e18-c3fb-4201-bca1-b15c605faa37` · `slug` =
  `borracharia-rio-do-ouro` · `environment` = `prod` · status `active`

---

## 2. O que foi feito nesta sessão (4 commits)

### `cc89fe5` — Cartão Conversão do Bot + venda conta só na entrega (getRedeFunnel)

- Cartão "Conversão do Bot" (tentou/pediu/efetivou) adicionado ao painel da Rede.
- `getRedeFunnel`: venda de parceiro passa a contar **só na entrega** (alinhado com a decisão do
  financeiro; o commit anterior contava na criação).

### `f1fd7f2` — (incluído no cc89fe5 — ver acima)

### `fe79047` — FIX feed da Rede: status real do pedido (DEPLOYADO)

- **Problema:** `getPainelRede` (`recent_events` + `top_items` em
  `src/admin/painel/queries.ts`) carimbava `"Venda"` em todo pedido desde a criação.
- **Fix:** pedido em curso → status real (`Em separação / Saiu pra entrega / Entregue`); venda
  realizada = `"Venda"` datada na entrega.
- Front: `painel/public/app.js`.
- **JÁ DEPLOYADO em prod.**

### `f103331` — FIX tela Pedidos: view 0082 multi-parceiro (MIGRATION OK, FRONT PENDENTE)

- Migration `0082` (`db/migrations/0082_painel_orders_reflect_partner_status.sql`): adiciona
  colunas aditivas (`is_partner`, `partner_status`, `delivery_status`, `payment_status`) na view
  `dashboard.pedidos_recentes` lidas de `partner_orders` via `partner_order_id`. View é
  **genérica** — vale pra todos os parceiros atuais e futuros.
- Fix em `commerce.network_orders_unified` pra não duplicar pedido de parceiro.
- Front `painel/public/app.js` (`applyPedidos`) traduz os novos campos.
- **Migration 0082 JÁ APLICADA em prod via MCP. O front AINDA NÃO foi deployado.**

### `1d79735` — FIX SEC-001: consultar_pedido amarra ao contato (PENDENTE DEPLOY)

- **Furo:** `consultar_pedido` (`src/atendente-v2/tools.ts`) buscava por `order_number` SEM
  verificar `contact_id` → qualquer cliente lia pedido alheio (nome/endereço/itens/valor) chutando
  o número.
- **Fix:** query agora exige `o.contact_id = <contato da conversa>`. Pedido de outro contato
  retorna "não encontrado".
- **O fix SÓ PROTEGE DEPOIS DO DEPLOY.** Enquanto `1d79735` não for deployado, o furo persiste
  em prod.

---

## 3. Deploy: o que está em cada commit

| Commit | Conteúdo | Status em prod |
|---|---|---|
| `7eeb191` e anteriores | Fundação Bot→Rede inteira (migrations 0078–0081) | ✅ Deployado (2026-06-03) |
| `cc89fe5`, `f1fd7f2` | Cartão Conversão + getRedeFunnel corrigido | ✅ Deployado |
| `fe79047` | Fix feed status real | ✅ Deployado |
| `f103331` | Fix tela Pedidos front (0082 já no banco) | ❌ **Pendente deploy** |
| `1d79735` | SEC-001 fix (consultar_pedido) | ❌ **Pendente deploy — CRÍTICO** |

**Ação imediata:** Redeploy no Coolify (main está no `1d79735`). Não há risco de regressão —
typecheck e testes passando, migrations já no banco.

---

## 4. Limpeza de pedidos de teste (feita hoje em prod)

Os 2 pedidos de teste criados durante a validação foram cancelados com sucesso:

| Pedido | partner_order | Unidade | Ação |
|---|---|---|---|
| PED-0022 (dono/Wallace) | `0498caab-...` | — | `cancel_partner_local_order` + `cancel_manual_order` |
| PED-0023 (Rodrigo) | `4c4d8af7-...` | Borracharia Rio do Ouro | idem |

Resultado verificado: estoque restaurado (reservas zeradas, `on_hand` voltou a 9 e 10),
recebíveis estornados (cancelados + deletados). Eles aparecem como `"Cancelado"` na tela Pedidos
e somem do feed da Rede.

---

## 5. Pendências / decisões em aberto

### 5.1 ACHADO 2 — cockpit do dono conta faturamento antes da entrega (decisão pendente)

`analytics.v_daily_metrics` ← `analytics.v_conversation_summary`: conta faturamento e "fechou"
de pedido de parceiro pela **data da conversa**, antes da entrega, e não filtra cancelado (usa
`o.id IS NOT NULL` sem checar status). Inconsistente com a regra "venda conta na entrega"
adotada no `getRedeFunnel`.

**Decisão pendente do dono:** faturamento do bot conta na criação do pedido ou só na entrega?
NÃO corrigido.

### 5.2 ACHADO 4 — getRedeFunnel conta cancelados no funil (baixa prioridade)

- `"pediu"` conta pedido que foi depois cancelado.
- `"efetivou"` conta `delivery_status='delivered'` mesmo se o pedido foi cancelado.
NÃO corrigido.

### 5.3 Expansão multi-parceiro (aguardando 2º parceiro real)

Decisão do dono: NÃO começar até ter 2º parceiro real. Quando vier:
1. Trocar `PARTNER_COVERAGE` (config hardcoded em `src/atendente-v2/fulfillment.ts` ~linha 225)
   por tabela `network.unit_coverage`.
2. Tela de cadastro "Novo parceiro" no painel matriz (cria `network.partners` + `partner_units`
   + token).

Modelo é **multi-tenant** (mesmo banco/tabelas, isolado por `unit_id` + RLS) — NÃO criar
banco/tabela por parceiro.

### 5.4 Segurança backlog

44 tabelas com RLS desabilitado (dados centrais `core`/`commerce`/`analytics`; as `partner_*` já
têm RLS). Ver `docs/SEGURANCA.md`.

### 5.5 Pendências herdadas do handoff anterior (não resolvidas)

- **C7** propagação real de edição de pedido de parceiro (`editar_pedido` ainda escala humano)
  — precisa de `edit_partner_local_order` no banco antes.
- **Bug pré-existente** (não é da rede): `editar_pedido` perde frete no recálculo ao editar
  itens de entrega — tarefa separada.
- **2 arquivos soltos não-commitados:** `painel/public/app.js` (+sobra do commit cobrança
  `662c29f`) e `docs/CONTRATO_ESTOQUE_FINANCEIRO_0076_0077.md`.

---

## 6. Como rodar / comandos úteis

```bash
# typecheck + testes (gate de regressão)
npx tsc --noEmit -p tsconfig.json
npm test

# preview do portal parceiro (sem worker do bot — NÃO liga o atendente)
# ver .claude/launch.json: parceiro-static (4599) ou parceiro-preview (4100)
```

**Constantes de referência** (de scripts/provas existentes):
- Conversa de teste: `d08d4d61-8668-4ed7-8029-ebd9c4d66a6d`
- Geo Itaboraí: `d640c120-0b85-45ad-a0e1-0bc8ee0d0aa9`
- Token do parceiro: ver `scripts/gerar-token-parceiro.cjs`

---

## 7. Guards do desenho (não desfazer)

- **H1** total do espelho é LIDO do `partner_order` (nunca recalculado do LLM).
- **H2** idempotência: `bot:order:{conversationId}:{hash}` no espelho+materialize (`ON CONFLICT`).
- **H3** cancelar pedido de parceiro = propagação real (commit 3.4); editar segue bloqueado
  (escala humano) — sem `edit_partner_local_order`.
- **H4** caminho parceiro SÓ `delivery` (pickup→matriz; senão recebível COD fantasma).
- **H5** `mapProductToPartnerStock` exige `is_tracked` + disponível.
- **H6** `insertCommerceOrderMirror` compartilhado pelos 2 caminhos.

---

## 8. Próximo passo recomendado (1 frase)

Fazer o **Redeploy no Coolify** para subir `1d79735` (SEC-001) e `f103331` (tela Pedidos com
front da 0082); depois trazer o **Achado 2** pro dono decidir se o faturamento do bot conta na
criação ou só na entrega.
