# Farejador — Portal Parceiro

Portal operacional da unidade parceira (borracheiro credenciado). Roda dentro do próprio Farejador, em paralelo ao painel admin (`/admin/painel`), em rota separada (`/parceiro/:slug`).

> **Status:** Reescrito visualmente em 2026-05-19. **Refatorado pra silo isolado da matriz no mesmo dia** — parceiro não enxerga mais `commerce.products` nem `commerce.orders`; opera sobre tabelas próprias (`partner_stock_levels`, `partner_orders`, `partner_purchases`, `partner_expenses`). Migrations 0038-0040 pendentes de aplicação em prod.

---

## 🧰 2026-05-29 — Insumos + serviços no PDV, layout do checkout e gauge do score (Claude Opus 4.8)

Reclamação dos borracheiros: só dava pra cadastrar/vender **pneu**. Não havia como cadastrar **insumo** (câmara de ar, bico, macarrão) nem **serviço** (mão de obra) pra usar no frente de caixa. Resolvido com **uma coluna nova** (`item_type`), sem tabela nova — o banco já era genérico o bastante.

### Tipo de item: `pneu` | `insumo` | `servico` (migration `0067`)

- **Por que coluna, não dedução:** `partner_stock_levels` já tinha `item_name` livre, `tire_size` opcional e `is_tracked`. Insumo e serviço já "cabiam". Mas deduzir o tipo (tire_size NULL? is_tracked false?) é frágil — insumo e serviço ambos ficam sem medida, e `is_tracked` quer dizer "controla quantidade?", não "é serviço?". São conceitos **ortogonais**. Coluna explícita dá filtro/relatório limpos (faturamento produto × serviço) sem acoplar os dois.
- **Migration `0067_partner_item_type`**:
  - `item_type` em `commerce.partner_stock_levels` (`DEFAULT 'pneu'`, CHECK nos 3 valores) — todo registro existente vira `pneu`.
  - `item_type` (snapshot, nullable) em `commerce.partner_order_items`.
  - Índice parcial `(environment, unit_id, item_type) WHERE deleted_at IS NULL`.
  - `CREATE OR REPLACE commerce.register_partner_local_order` (base 0065) — única mudança: grava `item_type` no snapshot do item vendido. Assinatura inalterada.
- **Convenção app-layer:** `item_type = 'servico'` ⇒ `is_tracked = false` (não baixa estoque, vendido sem limite); `pneu`/`insumo` ⇒ `is_tracked = true` (baixam estoque normal). O **tipo dirige o `is_tracked`** no `saveStock()` — não há toggle manual. A função de venda já respeitava `is_tracked` (decremento só `IF is_tracked AND quantity_on_hand IS NOT NULL`), então serviço entrar na venda sem mexer no estoque **já funcionava** no banco; faltava só a UI.
- **Backend:** `stockSchema` (Zod) ganhou `item_type: z.enum(['pneu','insumo','servico']).default('pneu')`; `UpsertPartnerStockInput`, o INSERT/upsert de `upsertPartnerStock` e as listagens `getPartnerEstoque`/`getPartnerProdutos` passaram a carregar `item_type`.
- **Frontend — form de Estoque:** abas **Pneu / Insumo / Serviço** no topo. Pneu mostra a Medida; **insumo/serviço escondem a Medida**; **serviço esconde Marca + Qtd + Mín** (serviço não tem marca nem estoque). Título/placeholder/rodapé do form adaptam ao tipo. `saveStock()` zera medida em não-pneu e marca em serviço.
- **Frontend — PDV:** lista e cards adaptam por tipo (helpers `itemTypeLabel`/`itemPrimaryLabel` + selo `.pos-type-badge`). Pneu mostra medida; insumo/serviço mostram o nome. O carrinho já aceitava item sem controle de estoque (`available = Infinity`), então serviço/insumo vendem sem fricção.
- **Ponta solta conhecida:** o fluxo de **Compras** ainda cria item novo como `pneu` por padrão (coluna tem default, não quebra); atualizar quando mexermos naquele form. A view admin `network_stock_unified` não expõe `item_type` (leitura cruzada da rede).

### Layout do checkout (PDV)

- **KPIs encolhidos pra esquerda + Resumo da venda em coluna cheia.** Os 4 cards do topo agora ocupam só as 2 colunas da esquerda e o card "Resumo da venda" sobe até o topo, ganhando ~88px de altura. Feito fundindo a linha de KPIs e o grid de 3 colunas num único grid (`.pos-checkout`, `grid-row: 2 / 4`, summary com `grid-row: 1 / 3`).
- **Observação removida** do resumo (a pedido), o que dispensou a barra de rolagem que tinha surgido; espaçamentos verticais enxugados pra tudo caber nos modos Retirada e Entrega.
- **Botões Finalizar/Cancelar** ganharam `flex: 0 0 auto` (não achatam mais se o conteúdo crescer).
- **Card "Buscar produtos" alargado** (360 → 400px) e **filtros reequilibrados** (`1.1fr 1fr 1fr`, padding menor, rótulos "Marcas"/"Aros") — não cortam mais o texto.

### Score financeiro vira gauge

- O "Score financeiro" (0–1000, lógica intacta) virou um **arco minimalista** (SVG, `stroke-dashoffset = 100 − score/10`) com o número no centro, em vez do número solto.
- **Cor por faixa** (getter `financialScoreColor`): 🟢 ≥800 / 🟢 ≥650 / 🟡 ≥500 / 🔴 <500 — mesmas faixas do `financialScoreLevel` (Ótimo/Bom/Regular/Ruim). Transição suave no arco e na cor.

**Migration `0067_partner_item_type`: ✅ aplicada em prod em 2026-05-29 (via MCP).** Antes disso, como o código no ar já lia/gravava `item_type`, a coluna ausente derrubava `getPartnerEstoque`/`getPartnerProdutos` → o `Promise.all` do `loadData()` rejeitava → **todas** as telas ficavam vazias e os saves "não funcionavam". Aplicar a migration destravou tudo. As demais mudanças são frontend/app-layer. Cache-bust recomendado ao publicar.

---

## 🧹 2026-05-28 — Backlog da auditoria zerado (5 itens) (Claude Opus 4.7)

Resolução do backlog levantado na auditoria de UX/arquitetura do silo parceiro. Cinco itens, dois migrations novos (`0065`, `0066`), ambos aplicados em prod via MCP Supabase. Zero mudança em bot/matriz (silo isolado preservado).

1. **Editar + excluir cliente** — antes só dava pra cadastrar. Agora:
   - Clicar numa linha da tabela de Clientes carrega o cadastro no form (`editCustomer()`), com destaque verde na linha em edição. O form troca título/botão pra modo edição.
   - `PUT /clientes/:id` (`updatePartnerCustomer`) faz `SET` direto (permite **trocar telefone** e **limpar campos** — não usa COALESCE). Conflito de telefone/CPF (Postgres 23505) vira `409 customer_phone_conflict`/`customer_cpf_conflict` com mensagem clara.
   - `DELETE /clientes/:id` (`deletePartnerCustomer`) é **soft-delete** (`deleted_at = now()`). Pede `window.confirm()` antes. Índices únicos de telefone/CPF são parciais (`WHERE deleted_at IS NULL`), então telefone de cliente excluído fica livre pra reuso.

2. **HTML morto removido** — `index.html` tinha ~1.100 linhas de um bloco Tailwind antigo (o portal pré-redesign) que nunca renderizava. Deletado. O toast (preso dentro do bloco morto) foi realocado pra UI viva. Arquivo: 2.245 → ~1.010 linhas.

3. **Dualidade do VIP resolvida** — VIP **automático por nº de compras** (`customerIsVip()`, hoje 3) é a **única** fonte da verdade. Removidos todos os caminhos de escrita mortos: a coluna `is_vip` não é mais escrita (upsert), o endpoint `PATCH /clientes/:id/vip`, o schema e a query `updatePartnerCustomerVip`. A coluna `is_vip` (migration 0062) fica morta no banco; sem dropar pra não arriscar.

4. **Desconto / frete / observação no PDV ativo** — antes o desconto só existia por item. Agora a aside de resumo do PDV tem inputs de **Desconto** e **Frete** (máscara BRL) + textarea de **Observação**. Persistidos no banco (migration `0065`): `partner_orders.discount_amount`/`freight_amount`, e `commerce.register_partner_local_order` recalcula `total := GREATEST(subtotal - desconto + frete, 0)`. **O total exibido = o total gravado** — sem divergência entre tela e contabilidade.

5. **`customer_id` em contas a receber manuais** — antes `customer_name` era texto livre, desvinculado do cadastro. Migration `0066` adiciona `finance.partner_receivables.customer_id` (FK → `commerce.partner_customers` `ON DELETE SET NULL` — excluir cliente desvincula, não apaga a conta). O form de conta a receber agora tem busca de cliente com vínculo/desvínculo, igual ao PDV. `customer_name` continua como rótulo livre/fallback. A venda a prazo já vincula o `customer_id` automaticamente.

Cache-bust → `v=20260528-dark-portal-2`. Migrations aplicadas em prod: `0065_partner_orders_discount_freight`, `0066_partner_receivables_customer_id`.

---

## 👥 2026-05-28 — Tela Clientes + cadastro de cliente no PDV (Claude Opus 4.7)

Trabalho focado no cadastro de clientes e no vínculo cliente↔venda no frente de caixa. Dois migrations novos: `0063_partner_customers_address_parts` (colunas `address_street`, `address_neighborhood`, `address_city`) e `0064_partner_customers_address_number` (coluna `address_number`). Ambos aplicados em prod via MCP Supabase.

### Cadastro de cliente
- **CPF removido** do cadastro e do frente de caixa. Decisão do Wallace: "ninguém confia em passar CPF pra uma borracharia". Backend ainda aceita `cpf` opcional (não enviado pelo frontend); coluna preservada pra dados legados.
- **Endereço em campos separados**: Rua, Número, Bairro, Município (antes era um campo "Rua" único). `customerAddressLine()` monta a linha de exibição (`rua, número - bairro - município`), com fallback pro campo `address` legado.
- **VIP automático**: cliente vira VIP ao atingir `vipMinPurchases` compras (hoje **3**). É calculado no frontend (`customerIsVip()` conta `customerSales()`), não mais um toggle manual. A coluna VIP da lista virou indicador read-only. _(Atualizado 2026-05-28: o endpoint `PATCH /clientes/:id/vip` e a coluna-fonte foram removidos — VIP automático é a única fonte da verdade. Ver seção "Backlog da auditoria zerado".)_

### Vínculo cliente ↔ venda no frente de caixa
- **Busca + vínculo**: digitar nome/telefone no painel "Dados do cliente" → clicar no resultado → `selectPartnerCustomer()` grava `saleForm.customer_id`. A venda vai com `customer_id` preenchido. (já existia)
- **Cadastro inline no PDV** (`openPosCustomerForm()`): quando a busca não acha ninguém (2+ caracteres, zero resultados), aparece um botão **"+ Cadastrar '<texto buscado>'"** pré-preenchido. Abre um mini-form (nome, telefone, rua, nº, bairro, município) ali mesmo; ao salvar, `createPosCustomer()` cria o cliente **e já vincula à venda em andamento** (`selectPartnerCustomer` no branch fora da aba clientes). Ninguém troca de tela. Se o texto buscado for só dígitos, pré-preenche Telefone em vez de Nome.
- Cliente continua **opcional** — venda avulsa finaliza como "Consumidor Final".

### Endereço de entrega (fulfillment_mode = delivery)
- Backend exige `delivery_address` não-vazio quando `fulfillment_mode = 'delivery'` (Zod refine em `route.ts`). Sem endereço, não há pra onde entregar.
- **UX antes**: a regra bloqueava com um toast discreto e parecia que "a venda não efetuava". **Agora**:
  - Ao escolher **Entrega** (`onFulfillmentChange()`), o campo ganha **foco automático**, placeholder "(obrigatório)".
  - Clicar finalizar com endereço vazio acende o campo em **vermelho** (`.pos-input-error`) + foca + toast.
  - **Auto-preenchimento**: se o cliente selecionado tem endereço cadastrado, o endereço dele entra sozinho no campo de entrega (ao selecionar o cliente com Entrega já ativa, ou ao trocar pra Entrega depois). Editável — dá pra entregar num endereço diferente naquele dia. Estado guardado em `posSelectedCustomerAddress`, limpo ao trocar de cliente e ao finalizar a venda.
- Lógica final: **endereço de entrega = o do cadastro por padrão, editável quando precisar, obrigatório só quando não há nenhum.**

### Telas que a aba Clientes toca
- **Frente de caixa**: busca (`/clientes/buscar`), vínculo e cadastro inline; a venda faz upsert/link via `customer_id`.
- **Resumo / vendas recentes**: exibem `customer_name`.
- **Histórico do cliente**: `customerSales` / `customerTotalSpent` / `customerLastSaleLabel` casam `this.vendas` por `customer_id` (e por telefone/cpf legado).
- ~~**Gap conhecido**: em Financeiro → contas a receber, `customer_name` é texto livre, **não** vinculado ao cadastro.~~ _Resolvido 2026-05-28 (migration 0066): contas a receber têm `customer_id` com busca/vínculo. Ver "Backlog da auditoria zerado"._

---

## 🩹 Fix 2026-05-24 — venda "a receber" (pós-review do commit 522bf86)

Três correções aplicadas em `src/parceiro/queries.ts` (função `registerPartnerSale`):

1. `idempotency_key` da receivable agora deriva do `order_id` (era `"undefined:receivable"` quando o frontend omitia a chave — colidia entre vendas).
2. Se o SELECT do pedido recém-criado vier vazio, lança erro e faz rollback da venda inteira (antes ficava venda sem receivable, em silêncio).
3. Receivable criada automaticamente agora emite `audit.events` com tipo `partner_receivable_auto_created` (antes só os fluxos manuais auditavam).

Detalhes: `docs/FIX_PARCEIRO_VENDA_RECEBER_2026-05-24.md`.

## 🧯 Etapa 1 de reconciliação 2026-05-24 — 3 bugs vermelhos do financeiro

Plano de 6 etapas descrito em `docs/PLANO_RECONCILIACAO_FINANCEIRO_PARCEIRO_2026-05-24.md`. Esta Etapa 1 resolve os bugs que vazam dinheiro/quebram trilha contábil:

1. **Cancelar venda agora cancela a conta a receber vinculada** (cascade) — migration `0050` recria `commerce.cancel_partner_local_order` para também marcar a receivable como `cancelled` + emitir audit event. Antes ficava órfã `'open'`, podia ser "recebida" depois.
2. **Categoria fornecedor não vira mais "manutenção"** — nova categoria `supplier_payment` em `partner_expenses` (migration `0050`) + mapeamento corrigido em `payableCategoryToExpenseCategory`. Antes pagamento a fornecedor sumia do relatório de despesas com fornecedor.
3. **Trava de duplicidade no `settlePartnerPayable`** — antes de criar a despesa automática, busca despesa parecida (mesma descrição, mesmo valor, ±7 dias) que não tenha sido gerada por este mesmo payable. Se achar, devolve `409 duplicate_expense` com a lista. Frontend mostra `confirm()` com as duplicatas e pede pra confirmar; usuário pode forçar com `force_duplicate: true`.

Detalhes técnicos: `docs/FIX_PARCEIRO_RECONCILIACAO_ETAPA1_2026-05-24.md`.

## 🔗 Etapa 2 de reconciliação 2026-05-24 — FKs reais

Migration `0051` substitui a "ligação por string `idempotency_key`" por foreign keys formais:

- `partner_receivables.source_order_id → partner_orders(id)`
- `partner_payables.source_purchase_id → partner_purchases(id)` (preparada pra Etapa 3)
- `partner_expenses.source_payable_id → partner_payables(id)`

Inclui backfill via regex no `idempotency_key`, UNIQUE parcial (uma venda → 1 receivable auto), `env_match` nas novas FKs, e `cancel_partner_local_order` reescrita pra cancelar receivable via FK em vez de match por string. `idempotency_key` ainda existe pra idempotência HTTP — FK é a fonte da verdade pra reconciliação.

Detalhes: `docs/FIX_PARCEIRO_RECONCILIACAO_ETAPA2_2026-05-24.md`.

## 💳 Etapa 3 de reconciliação 2026-05-24 — Compra a prazo

Migration `0052` adiciona `payment_status` (`'paid_now'` | `'payable'`) e `payable_due_date` em `commerce.partner_purchases`. Quando o parceiro escolhe "A prazo" no form de compra:

- A compra é registrada (estoque sobe igual antes)
- Um `partner_payable` é criado automaticamente com `source_purchase_id` preenchido (UNIQUE garante 1 payable por compra)
- Quando o payable for marcado como pago, **não** cria expense duplicada (a compra já foi contabilizada)
- Cancelar a compra cancela o payable em cascade

Detalhes: `docs/FIX_PARCEIRO_RECONCILIACAO_ETAPA3_2026-05-24.md`.

## 📊 Etapa 4 de reconciliação 2026-05-24 — Resumo em 3 blocos

Migration `0053` reescreve `network.partner_unit_summary` separando 3 perguntas que antes vinham misturadas: **competência** (sales/purchases/expenses/result), **caixa realizado** (cash_in/cash_out/cash_net com regras anti-dupla-contagem), **posição futura** (open_receivables/open_payables/net_future). Campos antigos preservados. UI: fileira de 3 cards na aba financeiro.

Detalhes: `docs/FIX_PARCEIRO_RECONCILIACAO_ETAPA4_2026-05-24.md`.

## 📅 Etapa 5 de reconciliação 2026-05-24 — Fluxo de caixa projetado

Migration `0054` cria `network.partner_cash_flow_projection` agregando payables/receivables em aberto em 5 buckets de vencimento (vencido / hoje / 7d / 30d / depois). Endpoint `GET /api/fluxo-caixa`. UI: 4 cards no topo do financeiro com net + breakdown + contagem por bucket.

Detalhes: `docs/FIX_PARCEIRO_RECONCILIACAO_ETAPA5_2026-05-24.md`.

## 🔢 Etapa 6 de reconciliação 2026-05-24 — Parcelas

Migration `0055` adiciona `finance.partner_receivable_installments` (1-36 parcelas, +30d entre cada). Trigger fecha receivable mãe quando todas parcelas resolvem. View auxiliar `partner_receivables_effective` permite agregadores tratarem parcelas como linhas individuais. Endpoint `POST /api/contas-a-receber/:id/parcelas/:installmentId/receber`. UI: input "Parcelas" no form de venda + lista expandida de parcelas em cada receivable.

Detalhes: `docs/FIX_PARCEIRO_RECONCILIACAO_ETAPA6_2026-05-24.md`.

---

## 🔧 Fixes pós-revisão Codex 2026-05-24

Codex revisou o pacote 1-6 e apontou 4 problemas. 3 confirmados como bugs (deixavam número errado em prod), 1 reconhecido como dívida pré-existente (vira Etapa 7):

1. `registerPartnerPayable` com `status='paid'` criava expense sem `source_payable_id` → dupla contagem em `cash_out_month`. Helper interno `_settlePartnerPayableWithClient` agora é compartilhado entre `register` e `settle`, na mesma transação.
2. Parcelas com valor menor que N centavos quebravam (`CHECK amount > 0`) e retry HTTP estourava `UNIQUE`. Validação `InstallmentsTooSmallError` (→ 400) + `ON CONFLICT DO NOTHING`.
3. `deletePartnerPurchase` apagava compra com payable já pago → pagamento órfão. `PaidPurchaseLockedError` (→ 409) bloqueia.
4. (mini-trava) Estorno de estoque incompleto agora aborta o delete (`PartialStockReversalError` → 409) em vez de apagar a compra deixando estoque inconsistente. Fix estrutural em Etapa 7.

Zero migration nova — só app-layer. Cache-bust → `v=20260524-financeiro-parceiro-6`. Detalhes: `docs/FIX_PARCEIRO_RECONCILIACAO_POS_CODEX_2026-05-24.md`.

---

**Status do plano de reconciliação:** ✅ 100% implementado (etapas 1-6 + fixes pós-Codex). 6 migrations pendentes pra aplicar em prod: `0050`, `0051`, `0052`, `0053`, `0054`, `0055` (nessa ordem). Etapa 7 (FK direta em `partner_purchase_items`) no backlog. Plano-mãe: `docs/PLANO_RECONCILIACAO_FINANCEIRO_PARCEIRO_2026-05-24.md`.

---

## 🔒 Auditoria de segurança 2026-05-21 — RLS efetivo (Etapa 5)

A partir desta data, o Portal Parceiro opera com **RLS (Row Level Security) efetivo no Postgres** — não só app-layer.

### Mudanças aplicadas
- **Pool de conexão separado** (`src/parceiro/db.ts`) usando role `farejador_partner_app` (sem `BYPASSRLS`)
- **9 policies estritas** no Postgres (`IS NOT NULL AND unit_id = current_partner_core_unit()`) — sem `IS NULL OR`
- **Function `validate_partner_token`** com `SECURITY DEFINER` faz login sem expor `partner_access_tokens` à role restrita
- **2 views com `security_invoker = true`** (`partner_unit_summary`, `partner_orders_full`)
- **`SET LOCAL app.partner_unit_id`** em toda transação do portal (`withPartnerContext`)
- **Defesa em profundidade:** se TypeScript esquecer filtro `unit_id`, RLS no banco bloqueia

### Trilha auditável
- `docs/AUDITORIA_PAINEL_PARCEIRO_2026-05-21.md` — auditoria original (21 problemas)
- `docs/EXECUCAO_AUDITORIA_2026-05-21.md` — execução das 5 etapas
- `docs/PLANO_ETAPA5_RLS_2026-05-21_V2.md` — plano técnico V2 aprovado por Codex
- `docs/REVISAO_CODEX_PLANO_ETAPA5_RLS_2026-05-21.md` — revisão Codex
- `docs/RUNBOOK_ETAPA5_RLS_2026-05-21.md` — runbook operacional
- `db/migrations/0044_partner_rls_policies.sql` — migration aplicada
- `tests/integration/partner-rls-enforcement.integration.test.ts` — 10 testes de isolamento real

### Nota geral pós-auditoria
**6,4/10 → 8,8/10**. Os 3 problemas críticos (RLS inerte, `partner_access_tokens` sem RLS, `partners` sem RLS) foram resolvidos.

### Trade-offs aceitos
A role restrita ganhou `SELECT` em `core.units` e `commerce.products` (necessário pelos triggers `env_match`). Significa: parceiro pode descobrir slug/nome/endereço/telefone de outras unidades da rede, mas **não vê** vendas/estoque/despesas (RLS estrita protege). Documentado em `docs/RUNBOOK_ETAPA5_RLS_2026-05-21.md` seção 4.5.

---

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
GET  /parceiro/:slug/api/contas-a-pagar
GET  /parceiro/:slug/api/contas-a-receber
POST /parceiro/:slug/api/vendas
DELETE /parceiro/:slug/api/vendas/:orderId
POST /parceiro/:slug/api/estoque
DELETE /parceiro/:slug/api/estoque/:stockId
POST /parceiro/:slug/api/compras
DELETE /parceiro/:slug/api/compras/:purchaseId
POST /parceiro/:slug/api/despesas
DELETE /parceiro/:slug/api/despesas/:expenseId
POST /parceiro/:slug/api/contas-a-pagar
POST /parceiro/:slug/api/contas-a-pagar/:payableId/pagar
DELETE /parceiro/:slug/api/contas-a-pagar/:payableId
POST /parceiro/:slug/api/contas-a-receber
POST /parceiro/:slug/api/contas-a-receber/:receivableId/receber
DELETE /parceiro/:slug/api/contas-a-receber/:receivableId
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
