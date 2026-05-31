# Implementação 0076 — backend + front + verificação (companheiro do SQL)

> SQL aplicado em prod em 2026-05-31: `db/migrations/0076_partner_stock_reserved.sql`.
> Contrato: seção 12 de `docs/PLANO_ESTOQUE_INTEGRADO_SECOES_2026-05-31.md`.
> Snapshot/rollback: `docs/SNAPSHOT_FUNCOES_PRE_0076_2026-05-31.sql`.

## A. Backend — `src/parceiro/queries.ts`

### A1. `updatePartnerDeliveryStatus` (l.738) — chamar `deliver` no delivered (P2)
**ORDEM OBRIGATÓRIA (Codex #3): `deliver_partner_local_order` vem ANTES do
`UPDATE commerce.partner_orders SET delivery_status='delivered'`.** Não é "antes ou
junto" — a função SQL levanta erro se o pedido já estiver `delivered`, então se o UPDATE
rodar primeiro o deliver falha sempre. Sequência no branch `delivered`:

```ts
// 1º) P2: baixa física da reserva — SÓ na transição (ainda não estava delivered).
if (existing.rows[0]!.delivery_status !== 'delivered') {
  await client.query('SELECT commerce.deliver_partner_local_order($1, $2)', [
    orderId, `partner:${ctx.slug}`,
  ]);
}
// 2º) só DEPOIS: UPDATE partner_orders SET delivery_status='delivered', status='paid', ...
// 3º) e o recebimento da conta a receber (COD).
```
O guard `delivery_status !== 'delivered'` no TS evita que um duplo-clique inocente vire
erro 500; a exceção na função SQL é o backstop se algo escapar do guard.

### A2. `getPartnerEstoque` (l.273) e `getPartnerProdutos` (l.291) — incluir reserved
Adicionar `quantity_reserved` no SELECT dos **dois** (o produtos alimenta Frente de caixa
e pedido). Opcional: expor `available` calculado, mas o front já consegue derivar.

### A3. `upsertPartnerStock` (l.1085) — status pelo banco, não pelo helper TS (P3)
- Não escrever `quantity_reserved` (não está no INSERT/UPDATE — manter assim).
- Trocar `stockStatus(input)` por recálculo que conheça o `reserved` ATUAL da linha.
  Como o upsert é um INSERT…ON CONFLICT, a forma limpa é deixar o `stock_status` ser
  recalculado por trigger OU, mais simples, num `UPDATE … SET stock_status =
  commerce.partner_stock_status(quantity_on_hand, quantity_reserved, minimum_quantity,
  is_tracked)` logo após o upsert (mesma transação). Decisão de forma fica pro Codex;
  **invariante:** o valor gravado tem que vir do helper SQL com o reserved real.
- Capturar erro do CHECK (`23514`/`23xxx`) e devolver `saldo_below_reserved` amigável.

### A4. `deletePartnerStock` (l.1186) — bloquear reserved > 0 (P3b)
Antes do soft-delete, checar `quantity_reserved`:
```ts
// bloqueia inativar item com reserva aberta
... WHERE id=$1 ... AND deleted_at IS NULL AND COALESCE(quantity_reserved,0) = 0
```
Se não atualizou linha mas o item existe com reserved>0 → lançar
`StockReservedCannotDeleteError` (novo) → route 409/422.

### A5. `registerPartnerPurchase` (l.~1316) e `deletePartnerPurchase` (l.~1515) — helper (P3 ampliado)
Trocar o `stock_status = CASE … END` inline pelos respectivos
`commerce.partner_stock_status(novo_on_hand, quantity_reserved, minimum_quantity, is_tracked)`.
- Compra em item reservado: sai de `reserved` só se disponível voltar a superar mínimo.
- Estorno de compra que zera disponível: **volta** para `reserved` (não out_of_stock).

## B. Route — `src/parceiro/route.ts`
- Mapear erros novos: `saldo_below_reserved` → 409/422; `stock_reserved_cannot_delete`
  → 409/422; `Entrega ja finalizada` (do `deliver`) → reaproveitar
  `DeliveryAlreadyFinalizedError` (409). Mensagens em pt-BR.

## C. Front — `parceiro/public/app.js` + `index.html`
- Helper `stockAvailable(item) = item.is_tracked ? num(on_hand) - num(quantity_reserved) : Infinity`.
- `posAddProduct` / lista de vendáveis / bloqueio de carrinho: usar **disponível**.
- `stockStatusLabel`: adicionar `reserved: 'Reservado'` (senão "Sem status").
- Tabela e card de detalhe: mostrar **Físico / Reservado / Disponível**; valor em estoque
  continua pelo físico.
- **`soldUnitsMonth` (app.js:507 e :737):** hoje usa `activeSales` que inclui delivery não
  entregue. Mudar para contar só `pickup` + delivery `delivered` (reserva NÃO é saída).
- Guard de UI: desabilitar botão "Entregue" após o primeiro clique.

## D. Verificação (preview/prod controlado — restaurar saldo no fim)
0. `npm run typecheck`.
1. **Gate P1** (rechecar = 0 no momento do deploy).
2. Balcão pickup: vende 1 → on_hand −1, reserved 0, evento `stock_decrement_sale`.
3. Internet delivery: cria 1 → on_hand intacto, reserved +1, disponível −1, a receber aberta,
   evento `stock_reserved`, status `reserved` se zerou disponível.
4. Pickup de item com reserva pendente → bloqueado com mensagem (não erro cru de CHECK).
5. Ajuste manual abaixo do reservado → bloqueado, mensagem amigável.
6. Editar preço de item com reserved>0 → status continua `reserved`.
7. Inativar item com reserved>0 → bloqueado (P3b).
8. Entregue: on_hand −1, reserved 0, `stock_decrement_sale (delivery_delivered)`, a receber recebida.
9. **Entregue 2x** (duplo clique/retry) → baixa **uma vez só**; 2ª não rebaixa (P2).
10. Novo pedido delivery → `failed` → reserved 0, on_hand intacto, a receber cancelada,
    evento `stock_reservation_released`.
11. Cancelar (botão cancelar venda) delivery em `pending` → libera reserva, on_hand intacto.
12. Compra em item reservado / estorno de compra → status correto pelo helper.
13. Conferir `audit.events` + restaurar saldo.

## E0. Correções aplicadas no SQL após review do Codex (2026-05-31)
1. **CHECK de `stock_status` recriado** para aceitar `'reserved'` (parte 1b da migration).
   Original 0035: `unknown|in_stock|low_stock|out_of_stock|not_tracked`. Verificado em prod
   o nome `partner_stock_levels_stock_status_check`.
2. **`deliver_partner_local_order` falha alto** se `quantity_reserved < quantity` do item
   (RAISE `23514`), em vez de `GREATEST` mascarar. Itens que não reservaram (não rastreado
   / `on_hand` NULL) são pulados sem erro. `FOR UPDATE` por linha antes de decidir.
3. **Ordem ANTES** documentada em A1 (deliver antes do UPDATE delivery_status).
4. **`cancel`**: branch de liberação só atualiza/gera evento `stock_reservation_released`
   quando `quantity_reserved > 0` (guard no WHERE). `GREATEST` mantido no cancel como piso.

## E. Decisões que NÃO tomei sozinho (Codex/dono decidem)
1. **`upsertPartnerStock`: trigger vs UPDATE pós-upsert** para recalcular status — escolhi
   deixar em aberto; o rascunho não mexeu no upsert ainda (só descreve a invariante).
2. **Expor `available` no JSON da API** ou derivar no front. Rascunho não expõe.
3. **`failed` de um delivery JÁ `delivered`:** hoje o `DeliveryAlreadyFinalizedError`
   barra no TS antes de qualquer SQL. Mantido. (Dívida conhecida §12.5: cancelar delivery
   já recebida não estorna caixa — fora do escopo da 0076.)
4. **Item `unknown` (on_hand NULL):** o rascunho NÃO reserva nem baixa (simétrico com hoje).
   Se o dono quiser permitir reservar unknown, é outra decisão.

## F. Pendências de aplicação (bloqueios §12.8)
- [x] (1) Inconsistência de números dos docs.
- [x] (2) 0076 SQL + backend (A1–A5) + route + front (C) implementados. `npm run typecheck` = exit 0.
- [ ] (3) Re-review do Codex no código runtime + 12 testes (seção D) em preview/prod, **depois** apply.

### Status da implementação (2026-05-31, Opus)
Implementado e com typecheck OK:
- queries.ts: A1 (deliver ANTES do update delivered), A2 (quantity_reserved nos 2 selects),
  A3 (upsert recalcula status pelo helper SQL + captura CHECK → StockBelowReservedError),
  A4 (deletePartnerStock bloqueia reserved>0 → StockReservedCannotDeleteError),
  A5 (registerPartnerPurchase update+insert e deletePartnerPurchase usam o helper SQL).
- route.ts: POST /estoque → 409 saldo_below_reserved; DELETE /estoque → 409
  stock_reserved_cannot_delete; PATCH entrega → 409 reserva_insuficiente / delivery_already_finalized.
- app.js: stockAvailable(item); posAddProduct/addOrderItem usam disponível; posIncrementItem
  usa cartItem.available (já vem de stockAvailable); stockStatusLabel/Class + 'reserved';
  soldUnitsMonth e gráfico semanal de saídas só contam pickup + delivery delivered
  (isPhysicalExitSale); stockQtyDisplay(item) = físico + "(N disp.)" quando reserved>0.
- index.html: tabela de estoque usa stockQtyDisplay(item) (linha ~873); card de detalhe
  (stockDetail, pos-detail-figures) mostra Físico, e Reservado + Disponível só quando
  num(quantity_reserved)>0; Valor em estoque segue pelo físico (stockItemValue).
  NOTA: este front NÃO tem `stockHint`/`stockQuantityLabel`/`posDetailItem` — as funções/
  campos reais são `stockDetail`, `stockItemValue`, `selectStock`. Edições foram nesses.

**Aplicado em prod (2026-05-31, Codex):** migration 0076 com commit via
`scripts/apply-migration-file.cjs`.

Verificação pós-apply:
- `quantity_reserved` existe em `commerce.partner_stock_levels` como `integer NOT NULL DEFAULT 0`.
- `commerce.partner_stock_status(...)` existe.
- `partner_stock_levels_reserved_check` existe.
- `partner_stock_levels_stock_status_check` aceita `reserved`.
- Gate P1 ativo = `delivery_em_aberto: 0`.

### Re-review Codex complementar (2026-05-31)
O Codex encontrou e corrigiu as lacunas restantes do runtime:
- `deletePartnerStock` agora faz `SELECT ... FOR UPDATE`, bloqueia
  `quantity_reserved > 0` com `StockReservedCannotDeleteError` e so entao inativa.
- POST `/estoque` mapeia `StockBelowReservedError` para 409 amigavel.
- DELETE `/estoque/:stockId` mapeia `StockReservedCannotDeleteError` para 409 amigavel.
- `registerPartnerPurchase` usa `commerce.partner_stock_status(...)` tanto no UPDATE de item
  existente quanto no INSERT de item novo; `deletePartnerPurchase` ja estava no helper.

Verificacao local:
- `npm run typecheck` = OK.
- `node --check parceiro/public/app.js` = OK.

Ainda nao aplicado: testes manuais completos do roteiro D e deploy.
