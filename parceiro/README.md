# Farejador — Portal Parceiro

Portal operacional da unidade parceira (borracheiro credenciado). Roda dentro do próprio Farejador, em paralelo ao painel admin (`/admin/painel`), em rota separada (`/parceiro/:slug`).

> **Status:** Reescrito visualmente em 2026-05-19. **Refatorado pra silo isolado da matriz no mesmo dia** — parceiro não enxerga mais `commerce.products` nem `commerce.orders`; opera sobre tabelas próprias (`partner_stock_levels`, `partner_orders`, `partner_purchases`, `partner_expenses`). Migrations 0038-0040 pendentes de aplicação em prod.

## Arquitetura: silo isolado

Decisão tomada por Wallace em 2026-05-19: **"matriz vê tudo do parceiro, parceiro não vê nada da matriz"**.

Tradução técnica:

| Recurso | Parceiro acessa? | Matriz (admin) acessa? |
|---|---|---|
| `commerce.products` (catálogo central) | ❌ Não enxerga | ✅ Lê/escreve |
| `commerce.stock_levels` (estoque matriz) | ❌ Não enxerga | ✅ Lê/escreve |
| `commerce.orders` + `order_items` (vendas matriz) | ❌ Não enxerga | ✅ Lê/escreve |
| `commerce.partner_stock_levels` (estoque do parceiro) | ✅ Lê/escreve (só sua unidade) | ✅ Lê (todas unidades) |
| `commerce.partner_orders` + `partner_order_items` (vendas do parceiro) | ✅ Lê/escreve (só sua unidade) | ✅ Lê (todas unidades) |
| `commerce.partner_purchases` + items | ✅ Lê/escreve (só sua unidade) | ✅ Lê (todas unidades) |
| `finance.partner_expenses` | ✅ Lê/escreve (só sua unidade) | ✅ Lê (todas unidades) |
| `commerce.network_orders_unified` (view) | ❌ Não usa | ✅ Lê vendas de tudo (UNION matriz + parceiros) |
| `commerce.network_stock_unified` (view) | ❌ Não usa | ✅ Lê estoque de tudo |

Consequências importantes:

- Parceiro **cadastra qualquer pneu livre** no estoque. Sem precisar do catálogo da matriz.
- Venda do parceiro **decrementa estoque local automaticamente** (function `commerce.register_partner_local_order` faz tudo dentro).
- Bot da Atendente **não enxerga vendas/estoque dos parceiros** ainda — futuramente vai consumir as views unificadas se quiser.
- Relatórios consolidados da rede usam views (`network_orders_unified`, `network_stock_unified`).
- Vendas antigas (em `commerce.orders` com `unit_id` apontando pra um parceiro) ficam como legado/histórico. Não foram migradas.

---

## Arquitetura

```
parceiro/
├── README.md              ← este arquivo
└── public/
    ├── index.html         ← SPA Alpine + Tailwind
    ├── app.js             ← Estado reativo + máscaras + Chart.js
    └── style.css          ← Mínimo (só fontes + x-cloak)

src/parceiro/
├── auth.ts                ← Token sha256 hash + timing-safe compare
├── queries.ts             ← Reads + writes (filtro por unit_id)
└── route.ts               ← Fastify endpoints + Zod
```

### Stack

| Camada | Escolha | Mesmo padrão do painel admin? |
|---|---|---|
| HTML/UI | Tailwind CSS via CDN | ✅ |
| Reatividade | Alpine.js via CDN | ✅ |
| Ícones | Lucide via CDN | ✅ |
| Gráficos | Chart.js via CDN | ✅ |
| Tipografia | Inter via Google Fonts | ✅ |
| Build step | **Nenhum** | ✅ |
| Auth | Token por parceiro + sha256 hash + comparação timing-safe | Padrão próprio (admin usa `ADMIN_AUTH_TOKEN`) |

### Histórico da reescrita 2026-05-19

| Métrica | Antes (Codex) | Agora (Claude Opus 4.7) |
|---|---|---|
| `index.html` | 278 linhas | 580 linhas Tailwind + Alpine |
| `app.js` | 832 linhas imperativas | 670 linhas reativas + helpers |
| `style.css` | 748 linhas vanilla CSS custom | 19 linhas (Inter + `x-cloak`) |
| **Total** | 1.858 linhas | 1.269 linhas (−32%) |
| Charts | Canvas API à mão (`ctx.fillRect`, `ctx.arc`, gradiente manual, ~200 linhas) | 3× `new Chart()` (~80 linhas total) |
| Stack | CSS vanilla próprio + JS imperativo + reinvenção de Chart.js | **Igual ao painel admin** |

---

## Como o portal é servido

Rotas Fastify ([src/parceiro/route.ts](../src/parceiro/route.ts)):

```
GET  /parceiro/:slug            → redirect pra /parceiro/:slug/
GET  /parceiro/:slug/           → SPA (index.html)
GET  /parceiro/:slug/app.js     → JS
GET  /parceiro/:slug/style.css  → CSS

GET  /parceiro/:slug/api/resumo
GET  /parceiro/:slug/api/vendas
GET  /parceiro/:slug/api/estoque
GET  /parceiro/:slug/api/produtos
GET  /parceiro/:slug/api/despesas
GET  /parceiro/:slug/api/compras
POST /parceiro/:slug/api/vendas
DELETE /parceiro/:slug/api/vendas/:orderId
POST /parceiro/:slug/api/estoque
DELETE /parceiro/:slug/api/estoque/:stockId
POST /parceiro/:slug/api/compras
DELETE /parceiro/:slug/api/compras/:purchaseId
POST /parceiro/:slug/api/despesas
DELETE /parceiro/:slug/api/despesas/:expenseId
```

Todos os `/api/*` passam por `requirePartnerAuth` ([src/parceiro/auth.ts](../src/parceiro/auth.ts)).

---

## Auth — como funciona

1. Borracheiro acessa `/parceiro/<slug>` (ex: `/parceiro/borracharia-rio-do-ouro`).
2. Tela de login pede o **token do parceiro**.
3. Token vai pra `localStorage` como `farejador_partner_token_<slug>` e em todo request como `Authorization: Bearer <token>`.
4. Backend:
   - Busca `network.partner_units WHERE slug = :slug AND status = 'active' AND deleted_at IS NULL`
   - Lista até 10 tokens ativos (`network.partner_access_tokens WHERE revoked_at IS NULL`) pra essa unidade
   - Compara `sha256(received_token)` contra cada `token_hash` armazenado, via `timingSafeEqual`
   - Achou match → injeta `request.partnerContext = { partnerId, unitId, slug, ... }`
   - Não achou → 401

Auth é por **token físico**, não usuário. Múltiplos tokens por unidade permitem revogar um borracheiro específico sem derrubar a unidade inteira.

---

## Convenções de formato (frontend → banco)

Decisão arquitetural: **forçar o formato canônico no momento do input**, não tentar adivinhar/normalizar depois.

### Telefone

| Onde | Formato |
|---|---|
| Estado interno (Alpine) | Só dígitos, ex: `"21999999999"` (max 11) |
| Display visual | `(21) 99999-9999` (auto-formata enquanto digita) |
| **O que vai pro banco** | **E.164: `+5521999999999`** (via `toE164Phone()` no submit) |

Helpers: `onPhoneInput()`, `formatPhoneDisplay()`, `toE164Phone()`.

### Moeda BRL

| Onde | Formato |
|---|---|
| Estado interno (Alpine) | Number JS (ex: `1234.50`) |
| Display visual | `1.234,50` (separador pt-BR) com `R$` como prefixo overlay absoluto |
| Input do usuário | Só dígitos, tratados como centavos (`Math.round(digits) / 100`) |
| **O que vai pro banco** | **Number** (ex: `1234.50`) |

Helpers: `formatBRLDisplay()`, `onCurrencyInput()`. Aplicado em: `saleForm.unit_price`, `stockForm.average_cost`, `stockForm.sale_price`, `purchaseForm.unit_cost`, `expenseForm.amount`.

### Medida do pneu

Três inputs numéricos separados (Largura / Perfil / Aro) com slash e traço fixos entre eles. Banco recebe sempre `"WIDTH/ASPECT-RIM"`.

| Onde | Formato |
|---|---|
| Estado interno (Alpine) | 3 Numbers separados: `tire_width=90`, `tire_aspect=90`, `tire_rim=18` |
| Display visual | Três inputs `w-16` numéricos + `/` + `/` + `-` visuais fixos. Preview do formato canônico ao lado do label (`90/90-18` ou `—`). |
| Validação | Ou os 3 preenchidos, ou os 3 vazios. Preenchimento parcial bloqueia o save. |
| **O que vai pro banco** | **`tire_size: "90/90-18"`** + **`tire_width_mm: 90`, `tire_aspect_ratio: 90`, `tire_rim_diameter: 18`** (depois da migration 0038) |

Round-trip (`editStock`) prefere as colunas dimensionais do banco; cai pro parse da string só pra registros legados (`parseTireSize()` aceita também variantes `150/60R17` e `150/60ZR17`).

Helpers: `composeTireSize()`, `parseTireSize()`, `tireSizePreview()`.

### Demais campos

| Campo | Formato |
|---|---|
| Quantidade, Mínimo (estoque) | Number inteiro, alinhado à direita |
| Cliente, Item, Fornecedor, Descrição | Texto livre com `.trim()` no submit |
| Categoria (despesa) | Enum: `employee_payment`, `rent`, `utilities`, `maintenance`, `delivery`, `tax`, `other` |

---

## Estrutura visual

```
┌─ Sidebar (w-64) ──┐ ┌─ Main ───────────────────────────────────────┐
│ Logo F            │ │ Top bar: nome unidade, status, Atualizar     │
│ Resumo            │ ├──────────────────────────────────────────────┤
│ Lançamentos       │ │ Saúde da unidade (score + barra)             │
│ Registros         │ │ 4 KPIs (Vendas, Pedidos, Estoque, Resultado) │
│                   │ │ 3 charts (Vendas 7d, Resultado mês, Estoque) │
│ Status conectado  │ │ ───                                          │
│ Sair              │ │ Tabs lançamentos: Venda/Estoque/Compra/Desp. │
└───────────────────┘ │ Checklist saúde (5 items)                    │
                      │ ───                                          │
                      │ 4 listas: vendas, estoque, compras, despesas │
                      │ Toast inferior direito (auto-dismiss 3.5s)   │
                      └──────────────────────────────────────────────┘
```

---

## Backlog (não bloqueia uso operacional, mas dívida real)

| Item | Severidade | Por quê |
|---|---|---|
| **Backend setar `app.partner_unit_id` + conectar com role sem BYPASSRLS** | Alta antes de credenciar 2º parceiro | RLS estrutural está aplicado (migration 0041, 7 tabelas) mas service role do Supabase ignora policies. Pra enforcement real: queries.ts precisa wrappar cada operação em transação com `SET LOCAL app.partner_unit_id = ctx.unitId`, e o Fastify do parceiro precisa conectar com role separada. |
| **Token via httpOnly cookie** ao invés de `localStorage` | Baixa enquanto for MVP | XSS = token leak. Pra Fase 2 vale migrar. |
| **Rate limit** em `/parceiro/:slug/api/*` | Média se expor publicamente | Sem `@fastify/rate-limit` hoje. Brute force de token é viável. |
| **CRUD de mais itens por venda** | Baixa (cancelar+recriar funciona) | Hoje 1 item por venda. Adicionar carrinho exige mudança de UI + Zod (`items` já é array no schema). |

### Fechados em 2026-05-19 (mesma sessão)

- ✅ **Aplicar migrations 0038/0039/0040 no banco real** — feito via MCP Supabase.
- ✅ **RLS estrutural** — migration 0041 ativa policies em 7 tabelas via `network.current_partner_unit()`. Enforcement depende dos itens listados acima no backlog.
- ✅ **Integração admin↔parceiro** — já existia uma função `getPainelRede` no painel admin (lê `network.partner_unit_summary`). View `network_orders_unified` agora disponível pra consumo futuro mais granular.

### Hotfixes pós-auditoria 2026-05-20 (Claude Opus 4.7)

Auditoria sistemática dos fluxos de venda/compra/estoque/despesa identificou 7 problemas. Todos resolvidos na mesma sessão. Detalhamento em `docs/PAINEL_PLANO.md` seção "Hotfixes 2026-05-20".

| Bug | Impacto | Solução |
|---|---|---|
| **#1 — Idempotência compra furada** (alta) | Double-click no "Salvar compra" duplicava items e incrementava estoque 2x | Guard de `SELECT COUNT(*) FROM partner_purchase_items WHERE purchase_id = X` antes do INSERT. Se já tem items, pula. |
| **#2 — Venda sem saldo passava silenciosa** (alta) | Vendia 11 do estoque com 10. Não dava erro. | Function SQL agora levanta `EXCEPTION 'Estoque insuficiente...'`. Route retorna 422 com mensagem clara. Frontend mostra no toast. |
| **#3 — `average_cost` virava last_cost** (médio) | Comprou 10 a R$50 + 5 a R$60 → average ficava R$60 em vez de R$53,33. Margem mentirosa. | Cálculo de média ponderada de verdade: `(avg_prev*qty_prev + custo_novo*qty_nova) / (qty_total)`. |
| **#4 — Items duplicados por typo** (médio) | "michellim" vs "Michellin" criava entradas separadas. Estoque fragmentado. | Match com `lower(trim(...))` em `brand` e `supplier_name`. Typos casam. |
| **#5 — Audit perdia `stock_decrement_sale`** (médio) | Audit só registrava `partner_order_created`. Movimento de estoque ficava implícito no payload. | Function SQL agora grava `stock_decrement_sale` separado com payload `{moves: [{stock_id, item_name, delta, new_qty, new_status}]}`. |
| **#6 — Ausência de audit em estoque manual/despesas** (médio) | Borracheiro podia mexer em qty/custo/preço sem trilha. | Audit em `upsertPartnerStock` (`stock_item_created`/`stock_item_updated`), `deletePartnerStock` (`stock_item_inactivated`), `registerPartnerExpense` (`partner_expense_created`), `deletePartnerExpense` (`partner_expense_deleted`). |
| **#7 — 6 vendas legadas órfãs em `commerce.orders`** (baixo) | Vendas antigas com `unit_id` da unidade ficam só em `commerce.orders`, não em `partner_orders`. Borracheiro não vê. | Aceito como histórico. Admin enxerga via `network_orders_unified`. Sem migração. |

### Polish visual leve 2026-05-20 (Claude Opus 4.7)

Toques de vida sem mexer em estrutura. Cenário desktop-only, Wallace pediu "uns toques pra dar vida sem perder o clean".

| Item | Mudança |
|---|---|
| 4 botões "Salvar venda/estoque/compra/despesa" | Preto → **verde emerald** com sombra suave que cresce no hover. Convenção: verde = ação positiva. |
| Login button | Mantido preto (entrada formal) |
| Logo "F" da sidebar | Quadrado preto → **gradient laranja brand** (`from-brand-500 to-brand-700`) |
| Bolinha "Unidade conectada" | Estática → **animate-ping** sutil |
| Toast (notificação inferior direita) | Sempre cinza → **tricolor automático** (verde sucesso, vermelho erro, cinza neutro) com ícone correspondente |
| Heurística do toast | Função `inferStatusKind(msg)` decide pela mensagem |
| Asset version | `?v=20260520-portal-22` (Cache-Control no-store no servidor também garante refresh) |

Cores reservadas:
- **Brand laranja**: identidade (logo) + destaques pontuais (chips/badges importantes). Não usar em botões cotidianos.
- **Verde emerald**: ações positivas de salvar/confirmar. Botões de salvar = verde universal.
- **Cinza preto**: botões raros/solenes (login). Hierarquia.
- **Vermelho rose**: ações destrutivas (Inativar) + estados de erro no toast.

### 2ª rodada hardening 2026-05-20 (Claude Opus 4.7)

Migration `0043_partner_hardening` cobre o que ficou superficial na auditoria de bugs:

| Mudança | Por quê |
|---|---|
| Trigger `partner_orders_set_updated_at` | Coluna `updated_at` existia mas ninguém atualizava — agora atualiza automático |
| 3 FKs viraram `ON DELETE SET NULL` | Hard-delete de `partner_stock_levels`, `commerce.products` não trava mais vendas/compras históricas |
| `UNIQUE INDEX partner_stock_natural_key_uniq` | Previne race condition em compras concorrentes que criariam item duplicado no estoque |
| 2 novos triggers `env_match_*` | Coerência de environment entre `partner_orders` e `unit_id` + `partner_order_items` e `order_id` |
| Comentários em `partner_orders.deleted_at`/`status` | Define convenção clara: cancel = status, soft-delete = LGPD/exclusão definitiva |

Mais detalhes em `docs/PAINEL_PLANO.md` seção "2ª rodada de hardening".

**Confirmações positivas da auditoria** (não foram bugs):
- ✅ Estoque nunca foi negativo nos dados reais.
- ✅ `stock_status` sempre coerente com `quantity_on_hand` real (recompute em todo UPDATE).
- ✅ `FOR UPDATE` no estoque previne race entre vendas concorrentes.
- ✅ Cancel idempotente: erro se venda já cancelada.
- ✅ Cancel restaura estoque corretamente para items existentes.
- ✅ `Cache-Control: no-store` matou o cache hell do navegador (mudança do Codex).
- ✅ `partner_unit_summary` agrega de `partner_orders` (não mais `commerce.orders` legado).
- ✅ RLS estrutural cobre 7 tabelas (enforcement = dívida documentada).

### Hotfixes / features fechados em 2026-05-19 (Claude Opus 4.7)

- **Consistência de estoque** (#10): sale/cancel/purchase/cancel-purchase movimentam `partner_stock_levels` atomicamente, com audit em `audit.events`.
- **Autocomplete do catálogo no form de Estoque** (#11): **REVERTIDO em #14**. A feature foi temporariamente útil enquanto o parceiro dependia de `commerce.products`; com a refatoração de silo isolado, deixou de fazer sentido.
- **Toggle delivery/pickup no form de Venda** (#12): select "Retirar / Entregar" preservado entre vendas. Campo de endereço aparece condicionalmente quando `delivery`. Tag colorida no header do form muda entre "balcão" (cinza) e "entrega" (azul).
- **View `commerce.network_stock_unified`** (#13, migration 0039): consolida `stock_levels` (matriz) + `partner_stock_levels` (parceiros) com schema padronizado. Read-only. Usada pela matriz pra ler estoque da rede toda.
- **Silo isolado do parceiro** (#14-16, migration 0040): novas tabelas `commerce.partner_orders` + `partner_order_items` apontando direto pra `partner_stock_levels.id`. Functions `commerce.register_partner_local_order` (cria venda + decrementa estoque atomicamente) e `commerce.cancel_partner_local_order` (cancela + restaura estoque). View `commerce.partner_orders_full` agrega items em JSONB pro portal listar. View `commerce.network_orders_unified` faz UNION de vendas matriz + parceiros pra admin consumir. Frontend perdeu todo o autocomplete de catálogo, chips "sem vínculo", e bloqueio de venda — parceiro vende qualquer item do próprio estoque sem fricção.

### Consistência de estoque (corrigido em 2026-05-19)

Bug encontrado em teste real: borracheiro cadastrou 10 unidades de 90/90-18, vendeu 1, estoque continuou em 10.

Causa: `registerPartnerSale` (e simétricos) só inseriam em `commerce.orders`/`order_items`/`partner_purchases`. Nunca tocavam `partner_stock_levels.quantity_on_hand`.

Correção: as 4 mutações (sale, cancel-sale, purchase, cancel-purchase) agora rodam dentro de transação, usam o fragmento SQL compartilhado `STOCK_MOVE_SQL` (CTE com `FOR UPDATE` + recálculo de `stock_status`) e gravam audit em `audit.events`:

| Operação | Movimento no estoque | Event type no audit |
|---|---|---|
| `registerPartnerSale` | Decrementa por cada item com `product_id` | `stock_decrement_sale` |
| `cancelPartnerSale` | Restaura por cada item dos `order_items` | `stock_increment_sale_cancel` |
| `registerPartnerPurchase` | Incrementa por cada item com `product_id` | `stock_increment_purchase` |
| `deletePartnerPurchase` | Decrementa por cada item dos `purchase_items` (se saldo permitir) | `stock_decrement_purchase_cancel` |

Regras de pulamento silencioso (não bloqueia a operação principal):
- Item sem `product_id` linkado → não mexe em estoque (venda completa mesmo assim, registrada).
- Estoque com `is_tracked=false` → não mexe (não-controlado).
- Estoque inativado (`deleted_at IS NOT NULL`) → ignora.
- Decremento maior que saldo disponível → não negativa (movimento é pulado, audit registra a tentativa).

Quando há duplicatas (mesmo `product_id` em duas linhas de `partner_stock_levels` da mesma unidade — `partner_stock_levels` não tem `UNIQUE (unit_id, product_id)`), a CTE seleciona a linha com **maior `quantity_on_hand`** primeiro (`ORDER BY quantity_on_hand DESC LIMIT 1 FOR UPDATE`).

`stock_status` é recomputado dentro da própria `UPDATE` (não confia em valor antigo) — `in_stock` / `low_stock` / `out_of_stock` / `not_tracked` sempre coerente com `quantity_on_hand` e `minimum_quantity` correntes.

### Bug corrigido em 2026-05-19: dropdown da Venda

Antes: `getPartnerProdutos` lia de `commerce.product_full` (catálogo da **matriz**), então o dropdown da tela de Venda listava produtos que o parceiro nem tinha em estoque.

Depois: lê `commerce.partner_stock_levels` da unidade, com LEFT JOIN no catálogo pra detectar items vinculados. Items com `product_id` linkado ficam no topo, vendáveis. Items sem link aparecem cinzas, com tag "⚠ linkar ao catálogo" e bloqueados pra seleção. Preço unitário auto-preenchido com `sale_price` do estoque local (não com `price_amount` da matriz). Veja [src/parceiro/queries.ts:102](../src/parceiro/queries.ts) (função `getPartnerProdutos`).

---

## Como abrir o portal localmente

```bash
# servidor Fastify do Farejador rodando em :3000
# adicionar um parceiro de teste (ver migration 0035) com token conhecido
http://localhost:3000/parceiro/<slug>/
```

Login pede o token. Após inserir, ele fica em `localStorage.farejador_partner_token_<slug>`.

---

## Assinatura

Reescrita do frontend, máscaras de campo e migration `0038` por **Claude (Opus 4.7), 2026-05-19**. Sob direção do Wallace. Backend (`src/parceiro/*`) é trabalho original do Codex e foi mantido por estar sólido.

Detalhamento completo no `docs/PAINEL_PLANO.md`, seção "Continuação 2026-05-19 — visual + Rede + portal parceiro + dimensões de pneu".
