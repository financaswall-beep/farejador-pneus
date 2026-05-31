# Handoff — Estoque com estado RESERVADO integrado à Entrega (COD)

> **Status:** plano aprovado pelo dono, **implementação NÃO iniciada**.
> Última base no Git: `main` = `c02a361` (auditoria do estoque + migration 0075),
> sincronizado em `origin` e `pneus`. Data: 2026-05-31.

## Como rodar / contexto de ambiente (pra próxima sessão)
- Banco de **produção** = Supabase projeto **Farejador** (`project_id = aoqtgwzeyznycuakrdhp`,
  host `db.aoqtgwzeyznycuakrdhp.supabase.co`). É o mesmo banco usado local e no deploy.
- Servidor completo aponta pra prod com `--env-file=.env.preview` (`FAREJADOR_ENV=prod`,
  porta 3000). Config de preview: `.claude/launch.json` → `farejador-prod`.
- Deploy: Coolify faz pull de **`pneus` (farejador-pneus.git) branch `main`**. `origin`
  (FarejaorV1) é espelho. Depois de mergear, push nos dois e o **dono** dispara o redeploy.
- Migrations: arquivos numerados em `db/migrations/`. Aplicar em prod via Supabase MCP
  `apply_migration` (project_id acima) **e** salvar o `.sql` no repo. Última: `0075`.
  Esta feature é a **`0076`**.
- Token de login do portal: gerar com
  `node scripts/gerar-token-parceiro.cjs --slug=borracharia-rio-do-ouro --env=prod`
  (o token só aparece uma vez; cola na tela `/parceiro/borracharia-rio-do-ouro/`).
  Unidade: `unit_id = 36203e18-c3fb-4201-bca1-b15c605faa37`.

## Fatos técnicos já levantados (não precisa re-investigar)
- Hoje `commerce.register_partner_local_order` **baixa `quantity_on_hand` na criação**
  do pedido pra TODOS os modos (pickup e delivery). Não existe coluna de reserva.
- Frente de caixa cria com `fulfillment_mode='pickup'` (baixa imediata, ok).
  Pedido internet cria com `fulfillment_mode='delivery'` + `payment_status='receivable'`
  (COD). Ver `saveSale`/`createOrder` em `parceiro/public/app.js` (l.~961, ~2011).
- COD financeiro já funciona: `updatePartnerDeliveryStatus` (`src/parceiro/queries.ts:738`)
  — `delivered` recebe a conta a receber (caixa) + status `paid`; `failed` chama
  `cancel_partner_local_order` + cancela a receber.
- `cancel_partner_local_order` **corpo atual** está em `db/migrations/0075_partner_stock_position.sql`
  (Parte B). O corpo de `register_partner_local_order` pode ser obtido com
  `SELECT pg_get_functiondef(...)` (era um arquivo dump temporário, já removido).
- `getPartnerEstoque` (`queries.ts:272`), `getPartnerProdutos` (`queries.ts:290`),
  `upsertPartnerStock` (`queries.ts:1084`), `stockStatus` helper TS (`queries.ts:862`).
- Frontend Estoque: `parceiro/public/index.html` (tabela `pos-stock-grid`, card
  `pos-detail-*`, modais) e `parceiro/public/app.js` (`stockStatusLabel`, `posAddProduct`,
  `stockItemValue`, `_persistStockQuantity`, `openStockEntry/Adjust`).
- Manual da seção: `SECOES/ESTOQUE.md` (precisa atualizar no fim) e criar `SECOES/ENTREGA.md`.

## Decisões do dono (fechadas)
1. **Reservar na CRIAÇÃO** do pedido de internet (não no despacho).
2. **Proteger o reservado**: disponível nunca negativo; ajuste manual não pode baixar
   `quantity_on_hand` abaixo do `quantity_reserved` (CHECK no banco).

---

## As 3 nuances do estoque (requisito)
1. **Frente de caixa (pickup):** baixa imediata. _(já é assim)_
2. **Internet (delivery/COD):** ao criar → **RESERVADO** (sai do disponível, segue no
   físico). Só em **ENTREGUE** baixa no estoque **e** no financeiro. _(financeiro ok; estoque não)_
3. **Entrega falhou:** volta de reservado pro disponível; nada no caixa. _(financeiro ok)_

## Modelo de dados (migration 0076)
- Nova coluna `commerce.partner_stock_levels.quantity_reserved integer NOT NULL DEFAULT 0`.
- **CHECK** `quantity_reserved >= 0 AND (quantity_on_hand IS NULL OR quantity_on_hand >= quantity_reserved)`.
- Conceitos: `quantity_on_hand` = físico (baixa só quando o pneu sai de fato);
  `quantity_reserved` = comprometido com entregas em aberto; **`disponível` = on_hand − reserved**.
- Helper SQL `commerce.partner_stock_status(on_hand, reserved, minimum, is_tracked)`:
  `not_tracked` · `unknown` (on_hand null) · `out_of_stock` (on_hand≤0) ·
  **`reserved`** (on_hand>0 mas disponível≤0) · `low_stock` (disponível≤minimum) · `in_stock`.

## Funções SQL (migration 0076)
1. **`register_partner_local_order`** (reescrever fiel + branch por `p_fulfillment_mode`):
   - `'delivery'` → `quantity_reserved += qty` (on_hand intacto); evento `stock_reserved`.
   - outro → `quantity_on_hand -= qty` (como hoje); evento `stock_decrement_sale`.
   - checagem de saldo passa a ser contra **disponível** (`on_hand − reserved ≥ qty`); status via helper.
2. **NOVA `commerce.deliver_partner_local_order(p_order_id, p_actor)`**: por item,
   `on_hand -= qty; reserved -= qty` + status via helper + evento `stock_decrement_sale`.
3. **`cancel_partner_local_order`** (branch): se `fulfillment_mode='delivery'` E
   `delivery_status IN ('pending','dispatched')` → libera reserva (`reserved -= qty`,
   evento `stock_reservation_released`); senão → restaura físico (`on_hand += qty`,
   evento `stock_increment_sale_cancel`). Mantém cancelamento da conta a receber.

## Backend TS (`src/parceiro/queries.ts`)
- `updatePartnerDeliveryStatus`: no `'delivered'` **chamar `deliver_partner_local_order`**
  (baixa física) junto do recebimento da conta a receber; no `'failed'` segue chamando
  `cancel_partner_local_order` (agora libera reserva).
- `getPartnerEstoque` e `getPartnerProdutos`: adicionar `quantity_reserved` no SELECT.
- `upsertPartnerStock`: não toca `quantity_reserved`; capturar erro do CHECK e devolver
  mensagem amigável ("saldo abaixo do reservado").

## Frontend (`parceiro/public/app.js` + `index.html`)
- Helper `stockAvailable(item) = num(on_hand) − num(quantity_reserved)`.
- `posAddProduct`: usar **disponível**.
- `stockStatusLabel`: + `reserved: 'Reservado'`.
- Tabela e card: mostrar **Disponível** e **Reservado** (linha extra quando reserved>0).
  Valor em estoque continua pelo físico (`on_hand`).
- Surfacar a mensagem de erro do ajuste (saldo < reservado).

## Backfill / dados
- `quantity_reserved` default 0 → linhas atuais consistentes. **Não há entregas em
  aberto** (número canônico reconciliado em 2026-05-31: entre os delivery não-deletados
  existem só 3, todos `status='cancelled'` — `delivery_status` 2 `delivered`, 1
  `dispatched`; o resto, 11 no bruto, é soft-deleted). `delivered` antigas já têm on_hand
  baixado. Migration é segura, sem re-reserva. (Correção: versões anteriores deste doc
  diziam "12 ordens, todas cancelled" — impreciso, ver seção 12 do plano mestre.)

## Verificação end-to-end (preview prod, restaurar saldo ao fim)
1. `npm run typecheck`.
2. Balcão (pickup): vender 1 → on_hand −1, reserved 0.
3. Internet (delivery): criar pedido 1 → on_hand intacto, reserved 1, disponível −1, a receber aberta.
4. Proteção: "Ajustar saldo" abaixo do reservado → bloqueado.
5. Entregue: on_hand −1, reserved 0, `stock_decrement_sale`, a receber **recebida**.
6. Falhou: novo pedido (reserva) → failed → reserved 0, on_hand intacto, a receber
   **cancelada**, `stock_reservation_released`.
7. Conferir no banco + `audit.events`; restaurar saldo.

## Ordem de execução / deploy
1. Branch `feat/estoque-reservado-entrega`.
2. Implementar migration 0076 (SQL) + backend + front.
3. Aplicar 0076 em prod (MCP `apply_migration`) + salvar `.sql` em `db/migrations/`.
4. `typecheck` + roteiro de verificação.
5. Atualizar `SECOES/ESTOQUE.md` + criar `SECOES/ENTREGA.md`.
6. Merge → `main`; push `pneus` + `origin`; **dono** redeploya no Coolify.

## Riscos
- Mexe em 3 funções de produção (venda/cancelamento/entrega) — núcleo dinheiro+estoque.
  Reescrever fiel ao corpo atual, só adicionar a ramificação; CHECK como rede; rodar o
  roteiro dos 3 fluxos antes do deploy.
- Status novo `reserved` precisa do label no front (senão "Sem status").
- "Entradas/Saídas no mês" seguem proxy (dívida do *ledger* de movimentação, fora deste escopo).

## Adendo de auditoria (Opus, 2026-05-31) — LER ANTES DE IMPLEMENTAR
A auditoria crítica desta feature está na **seção 12** de
`docs/PLANO_ESTOQUE_INTEGRADO_SECOES_2026-05-31.md`. Pontos que ESTE handoff não cobria
e são obrigatórios:
- **P1 (bloqueante):** gate pré-deploy "zero entregas em aberto" — a reescrita causa
  **dupla baixa** em qualquer delivery `pending`/`dispatched` no momento do deploy.
- **P2:** `delivered → delivered` repetido baixa estoque de novo — `deliver` só pode
  rodar na transição (`existing.delivery_status !== 'delivered'`).
- **P3:** `upsertPartnerStock` regrava `stock_status` ignorando `reserved` — status
  passa a ser dono do banco (helper SQL), nunca do `stockStatus` TS.
- **Snapshot de rollback** das funções `register`/`cancel` ANTES da 0076 (faltava aqui).
- **`getPartnerProdutos` também** precisa de `quantity_reserved` (não só `getPartnerEstoque`).
- **Pickup desconta `reserved`**; `is_tracked=false`/`servico` e `on_hand IS NULL` não reservam.
- **Pular E2.5** (ponte por `audit.events`): ir E1 → E2(docs) → E3 direto.
