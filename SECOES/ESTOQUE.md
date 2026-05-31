# Seção: Estoque

- **Status:** ✅ estável (auditado e corrigido — migration 0075)
- **Última auditoria:** 2026-05-31 (achados corrigidos na mesma data)
- **Responsável pela auditoria:** Claude (sessão dono)

## O que é / responsabilidade
Cadastro e saldo dos itens da unidade: **pneu**, **insumo** e **serviço**.
É a **fonte da verdade do saldo** (`quantity_on_hand`). Quem vende (Frente de
caixa) e quem compra (Compras) **mexem no saldo só pelos contratos abaixo**.

NÃO é responsabilidade do Estoque: registrar vendas, contas a pagar/receber.

## Tabelas que possui (owner)
| Tabela | Colunas-chave | Observação |
|---|---|---|
| `commerce.partner_stock_levels` | `id`, `environment`, `unit_id`, `item_name`, `item_type` (`pneu`/`insumo`/`servico`), `tire_size` + `tire_width_mm`/`tire_aspect_ratio`/`tire_rim_diameter`, `brand`, `supplier_name`, `tire_position` (Traseiro/Dianteiro, migration 0075), `quantity_on_hand`, `minimum_quantity`, `average_cost`, `sale_price`, `is_tracked`, `stock_status`, `tire_condition`, `shelf_location`, `deleted_at` | Soft-delete via `deleted_at`. Toda query filtra `environment` + `unit_id` + `deleted_at IS NULL`. |

**`stock_status`** é derivado (calculado no upsert e no cancelamento):
`not_tracked` (se `is_tracked=false`) · `unknown` (qtd nula) · `out_of_stock` (≤0) ·
`low_stock` (≤ `minimum_quantity`) · senão `in_stock`.

## Endpoints
Todos sob `/parceiro/:slug/api/...`, auth **`Authorization: Bearer <token>`**.

| Método | Rota | Body | Retorno |
|---|---|---|---|
| GET | `/estoque` | — | `{ rows: [...itens completos...] }` |
| GET | `/produtos` | — | `{ rows: [...] }` — versão enxuta p/ a Frente de caixa (usa `id AS stock_id`) |
| POST | `/estoque` | objeto do item (cria se sem `stock_id`, atualiza se com) | `{ stock_id }` |
| DELETE | `/estoque/:stockId` | — | `{ stock_id, deleted: true }` (inativa, soft-delete) |

## Como LER (outra seção consultando esta)
- **Listagem completa:** `GET /estoque`.
- **Para vender (Frente de caixa):** use `GET /produtos`. Cada linha traz
  `stock_id` = `partner_stock_levels.id`. A venda aponta o item por
  `partner_stock_id = stock_id` (decisão "silo isolado" 2026-05-19 — venda NÃO
  passa por `commerce.products`).
- **Saldo disponível:** `is_tracked ? quantity_on_hand : (sem limite)`.

## Como GRAVAR
- **Criar/editar item:** `POST /estoque`. Validação no servidor via Zod
  (`stockSchema`): `item_name` obrigatório; `item_type` ∈ {pneu, insumo, servico};
  medida do pneu vai **completa ou vazia** (largura+perfil+aro). `servico` força
  `is_tracked=false` (não controla saldo).
- **Baixar saldo por venda:** **não** escreva direto. A venda decrementa via o
  fluxo de venda (gera `audit.events` `stock_decrement_sale`).
- **Aumentar saldo por compra:** via Compras (gera `stock_increment_purchase`).
- **Inativar item:** `DELETE /estoque/:stockId` (soft-delete; gera
  `stock_item_inactivated`).
- **Dar entrada / Ajustar saldo** (botões do card): reusam `POST /estoque`
  remontando o payload COMPLETO do item e trocando só `quantity_on_hand`
  (entrada = saldo+delta; ajuste = saldo absoluto). **Nunca** mande payload
  parcial — o upsert sobrescreve todas as colunas.
- **Posição do pneu:** campo `tire_position` (não mais `supplier_name`).

## Invariantes (sempre valem)
- **Cancelar venda devolve o estoque.** `commerce.cancel_partner_local_order`
  re-incrementa `quantity_on_hand` de cada item, recalcula `stock_status` e
  (migration 0075) grava `audit.events` `stock_increment_sale_cancel` por item.
  ✔ Auditado: 8 baixas + 12 vendas canceladas → saldo restaurado corretamente.
- Todo write registra trilha em `audit.events` (domínio `stock`), com
  `actor_label = partner:<slug>`.
- Saldo e status sempre recalculados juntos — nunca grave `quantity_on_hand` sem
  recalcular `stock_status`.

## ⛔ NÃO faça
- **NÃO volte a gravar Posição em `supplier_name`.** Desde a migration 0075 a
  posição tem coluna própria (`tire_position`). `supplier_name` é só
  fornecedor/origem (2W vs Porta via `stockOriginKey`). Misturar de novo recria a
  dívida 🔴 (perda de fornecedor ao editar posição).
- **NÃO trate "Entradas no mês" como número contábil.** Já filtra o mês corrente,
  mas continua um `max(compras, criados)` proxy — não há ledger de movimentação.
  ("Saídas no mês" agora conta só vendas não-canceladas do mês.)
- **NÃO leia/escreva a tabela por fora dos endpoints** (RLS da Etapa 5 depende do
  contexto de `partner_unit_id`; acesso cru fura o isolamento).

## Arquivos-fonte
- Front (tela + modal): `parceiro/public/index.html` (`pos-stock-grid`, modal `stockModalOpen`)
- Front (lógica/KPIs): `parceiro/public/app.js` (`getPartnerEstoque`-consumers: `stockTotalUnits`, `stockCostValue`, `saveStock`, `editStock`, `deleteStock`, `stockStatusLabel`)
- Rotas: `src/parceiro/route.ts` (`/api/estoque`, `/api/produtos`)
- Queries: `src/parceiro/queries.ts` (`getPartnerEstoque`, `getPartnerProdutos`, `upsertPartnerStock`, `deletePartnerStock`, `stockStatus`)
- Cancelamento (devolve estoque): função SQL `commerce.cancel_partner_local_order`

## Ressalvas conhecidas / dívidas
Todos os achados da auditoria 2026-05-31 foram **corrigidos** (migration 0075 + front/back):
1. ✅ `supplier_name` sobrecarregado → coluna `tire_position` própria.
2. ✅ "Saídas no mês" agora filtra o mês corrente (`soldUnitsMonth` + `isCurrentMonth`).
3. ✅ "Entradas no mês" agora filtra o mês (segue proxy `max()` — sem ledger ainda).
4. ✅ Botões distintos: "Dar entrada" (soma), "Ajustar saldo" (absoluto), "Editar" (completo).
5. ✅ Card não duplica mais título/subtítulo (medida some quando = título).
6. ✅ Cancelamento gera `stock_increment_sale_cancel` por item.
7. ✅ Código morto removido (`skuFor`, `stockLocation`).

**Dívida remanescente (não-bloqueante):** falta um *ledger* de movimentação de
estoque pra "Entradas/Saídas no mês" virarem número contábil exato (hoje são proxy).
