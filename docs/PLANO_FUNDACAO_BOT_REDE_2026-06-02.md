# Plano Profundo — Fundação Bot → Rede (matriz + parceiros)

**Data:** 2026-06-02 · **Autor:** Claude (Opus 4.8) sob direção do Wallace
**Status:** PLANO (pré-implementação) — análise verificada na fonte, antes de qualquer código.
**Branch:** `feat/fundacao-bot-partner-orders`
**Companheiro:** `docs/SISTEMA_ANTIFRAUDE_REDE_2026-06-02.md` (estratégia/anti-fraude).

> **Nível de certeza:** tudo abaixo foi **verificado no banco e no código de prod** (não de
> memória). Cada afirmação crítica tem citação de arquivo/linha ou nome de função/view.

---

## 0. Objetivo e princípio-mestre

Fazer o bot, ao fechar uma venda, **registrar no lugar certo, atribuído à loja certa**, sem
quebrar (a) o analytics do bot, (b) a máquina operacional do parceiro, (c) a cobrança da matriz.

**LEI da fundação (a trava contra "números brigando"):**
> **Cada número tem UM dono. O outro lado só APONTA — nunca guarda uma cópia que pode divergir.**

---

## 1. Estado atual — VERIFICADO (o mapa real)

### 1.1 Dois mundos de pedido (uma DB, tabelas diferentes)

| | `commerce.orders` (matriz/bot hoje) | `commerce.partner_orders` (parceiro) |
|---|---|---|
| `unit_id` | existe, mas **NULL** nos pedidos do bot (verificado: `com unit_id=0`) | **NOT NULL** |
| Máquina | nenhuma (só registro) | COD: `pending→dispatched→delivered`, reserva, recebível |
| Quem escreve | bot `criar_pedido` (`src/atendente-v2/tools.ts:368`) | Portal Parceiro + função SQL |
| Origem/atribuição | `source='chatwoot_com_bot'` | `source_tag` ∈ `porta\|2w\|walkin_*\|outro` |
| Ponte entre elas | **NÃO existe FK** ligando as duas | — |

### 1.2 Acoplamento ANALYTICS → `commerce.orders` (NÃO PODE QUEBRAR)

`analytics.v_conversation_summary` (verificado):
```sql
LEFT JOIN commerce.orders o ON o.source_conversation_id = c.id
-- resultado: CASE WHEN o.id IS NOT NULL THEN 'fechou' ...
-- pedido_total: o.total_amount
```
→ **"fechou venda" e "faturamento via bot" vêm de `commerce.orders` ligado pela conversa.**
Se um pedido do bot NÃO criar linha em `commerce.orders` com `source_conversation_id`, o analytics
marca a conversa como **"abandonou" e R$ 0**. `v_daily_metrics` (cockpit) deriva disso.
**Consequência: `commerce.orders` é obrigatório pra TODA venda do bot.** Matar/migrar = quebrar o
analytics (= intocável V2).

### 1.3 Acoplamento COBRANÇA → `commerce.partner_orders.source_tag` (JÁ PRONTO)

`getPainelRede` (`src/admin/painel/queries.ts:225-226`, verificado):
```sql
count(*)       FILTER (WHERE po.source_tag = '2w') AS orders_2w,
sum(total_amount) FILTER (WHERE po.source_tag = '2w') AS sales_2w
```
E `network.partner_unit_summary.sales_month` soma `partner_orders` (por `unit_id`, não-cancelado,
entregue-se-delivery, por `delivered_at`/`created_at`).
→ **A comissão 2w já lê `partner_orders.source_tag='2w'`.** Basta o bot **gravar `source_tag='2w'`**
no partner_order que a cobrança da matriz conta **sozinha**. Nenhuma mudança na leitura.

### 1.4 A máquina do parceiro — REUSÁVEL (verificada, corpo lido)

- `commerce.register_partner_local_order(env, unit_id, customer_name, customer_phone, items jsonb,
  payment_method, fulfillment_mode, delivery_address, actor_label, idempotency_key, source_tag,
  discount, freight)` → cria `partner_order` (status `confirmed`), **reserva** estoque se delivery
  / **baixa** se pickup, cria `partner_order_items`, audita. **Idempotente** (key ≥ 8 chars; retorna
  existente se repetir). Item com `partner_stock_id` NULL vira **"Item livre"** (sem controle de
  estoque).
- `commerce.deliver_partner_local_order(order_id, actor)` → na entrega, **reserva → baixa física**.
- `commerce.cancel_partner_local_order(order_id, actor, reason)` → **libera reserva** (se
  pending/dispatched) ou devolve estoque; **cancela o recebível**; audita.
- Wrapper TS `registerPartnerSale()` (`src/parceiro/queries.ts:527`) faz: upsert de
  `partner_customers` + chama a função + (se `payment_status='receivable'`/COD) cria
  `finance.partner_receivables`. Roda em `withPartnerContext` (pool do parceiro, RLS).

### 1.5 Os 2 BLOQUEIOS reais (verificados)

1. **Estoque do parceiro SEM vínculo com catálogo.** Todas as 7 linhas de
   `commerce.partner_stock_levels` têm **`product_id = NULL`** (nomes livres "Traseiro","Pneu").
   → Hoje é **impossível** perguntar "o parceiro tem o produto X do catálogo?". Sem isso, o
   roteamento-por-estoque e a reserva correta **não funcionam** (cairia em "Item livre", sem
   controle de estoque). **Pré-requisito: ligar o estoque do parceiro ao catálogo.**
2. **Zonas de entrega GLOBAIS.** `commerce.delivery_zones` **não tem `unit_id`** (verificado). O
   sistema sabe "entrega em Itaboraí, frete X", mas **não sabe qual loja cobre Itaboraí**. A regra
   "parceiro cobre Itaboraí, matriz o resto" **não existe nos dados** → precisa de um modelo de
   **cobertura por unidade**.

   *(Nota: `commerce.stock_levels` da matriz também é global, sem `unit_id`, mas tem `product_id`
   — então o estoque da matriz É ligado ao catálogo; só o do parceiro que não é.)*

### 1.6 Unidades reais (verificado)

| unit_id | nome | é parceiro? | papel |
|---|---|---|---|
| `1742c95e…` | Loja Principal (`main`) | NÃO | **a matriz** (loja do Wallace) |
| `36203e18…` | Borracharia Rio do Ouro | SIM (`active`) | parceiro-teste |

→ A **matriz é uma unidade também** (`main`), mas **não** é `partner_unit`. Venda da matriz vive em
`commerce.orders`; venda de parceiro na máquina `partner_orders`.

---

## 2. Arquitetura: a PONTE (decisão, com a razão verificada)

Convergir tudo num só = **proibido** (quebra §1.2 analytics + as 4 tools do bot). Logo:

```
                 ┌─────────────────── TODA venda do bot ───────────────────┐
                 │                                                          │
   resolveUnitForOrder()  →  unit é a MATRIZ?                unit é PARCEIRO?
                 │                  │                                │
                 │     commerce.orders (unit_id=main)   commerce.orders (unit_id=parceiro)  ← ESPELHO p/ analytics
                 │     [como hoje + unit_id]            +  partner_order (source_tag='2w')   ← DONO operacional
                 │                                          via register_partner_local_order
                 ▼                                          (reserva estoque + COD + recebível)
        analytics lê commerce.orders (igual)        Rede/cobrança lê partner_orders.source_tag='2w'
```

- **Venda da MATRIZ:** só `commerce.orders` (com `unit_id=main`). **Igual a hoje** + o `unit_id`.
  Sem partner_order. Menor mudança, menor risco.
- **Venda de PARCEIRO:** `commerce.orders` (espelho p/ analytics, `source_conversation_id` + total)
  **+** `partner_order` (o DONO — reserva, COD, recebível, `source_tag='2w'`).

### 2.1 Tabela de DONO por número (a LEI aplicada)

| Número | DONO (fonte única) | Quem só aponta/espelha |
|---|---|---|
| Venda fechou? (conversão do bot) | `commerce.orders.id` (via conversa) | — |
| Faturamento via bot (cockpit) | `commerce.orders.total_amount` | — |
| Venda do parceiro / 2w (Rede, cobrança) | `commerce.partner_orders` (`source_tag`,`total_amount`) | — |
| Status de entrega / COD | `partner_orders.delivery_status` + recebível | `commerce.orders` **não** tem status COD |
| Estoque do parceiro | `partner_stock_levels` (máquina) | — |

> Repare: o `commerce.orders` do espelho **não tem segunda carteira de status de entrega**. Ele
> guarda o total (igual ao do partner_order **no momento da criação**) só pro analytics. Quem manda
> em mudança de estado/dinheiro do parceiro é **sempre** o partner_order. **Nada pra brigar.**
> Regra de drift: se o partner_order for cancelado/editado, o espelho `commerce.orders` é
> propagado junto (ver §4).

---

## 3. Pré-requisitos (têm que vir ANTES do rewrite)

### P1 — Vincular estoque do parceiro ao catálogo (bloqueio §1.5.1)
O parceiro precisa, ao cadastrar/receber estoque, **escolher o produto do catálogo** (preenche
`partner_stock_levels.product_id`). É a **mesma peça** da aba **Catálogo / recebimento** que o
Wallace já idealizou. Sem isso o bot não casa cotação↔estoque do parceiro.
- **Fase 0 (teste):** preencher `product_id` de 1+ itens do parceiro-teste (UPDATE de dado de
  teste) pra provar o fluxo.
- **Real:** UI de recebimento no Portal Parceiro que liga ao catálogo.

### P2 — Modelo de cobertura por unidade (bloqueio §1.5.2)
Precisa registrar "qual unidade cobre qual região". Opções:
- (a) adicionar `unit_id` a `delivery_zones` (zona por loja), ou
- (b) tabela nova `network.unit_coverage` (unit_id → municípios/bairros).
- **Fase 0 (teste):** regra de cobertura **só no teste** (parceiro=Itaboraí, matriz=resto) pra
  provar o cérebro, sem mexer no schema.
- **Decisão de schema (P2) fica pro momento de tornar real** — não bloqueia o teste do cérebro.

### P3 — Regra do fallback (DECIDIDA)
Parceiro da região **sem o pneu** → **vai pra matriz** (a matriz é o backstop da rede).
⚠️ pressupõe que a matriz consiga atender a região (frete próprio ou retirada). Se não conseguir →
retirada ou "em falta". O teste vai expor esses casos.

---

## 4. Fluxos passo a passo (o que acontece em cada caso)

### 4.1 Bot fecha venda → MATRIZ
1. `resolveUnitForOrder` → unidade = `main`.
2. `criar_pedido` insere `commerce.orders` com `unit_id=main`, `source='chatwoot_com_bot'`,
   `source_conversation_id`, total, itens. **(= hoje + unit_id)**
3. Analytics enxerga normalmente. Fim.

### 4.2 Bot fecha venda → PARCEIRO (o caminho novo)
1. `resolveUnitForOrder` → unidade = parceiro (região + estoque, §5).
2. Mapear cada item: catálogo `product_id` → `partner_stock_id` do parceiro + **preço central**
   (`mapProductToPartnerStock`, já feito). Se algum item não está no estoque do parceiro → fallback
   matriz (P3) ou indisponível.
3. Resolver `partner_customer` (upsert por nome+telefone do contato da conversa).
4. **Atomicamente** (uma transação no pool do bot, `SET LOCAL app.partner_unit_id`):
   - chamar `register_partner_local_order(... source_tag='2w', fulfillment_mode, freight ...)` →
     cria partner_order (`confirmed`, `pending`/Em separação), **reserva estoque**;
   - criar o **recebível COD** (`finance.partner_receivables`, espelhando `registerPartnerSale`);
   - inserir o **espelho** `commerce.orders` (`unit_id=parceiro`, `source_conversation_id`, total =
     total do partner_order) com link ao partner_order.
5. Resultado: parceiro vê card "Em separação"; analytics conta "fechou"+faturamento; cobrança conta
   2w. **Uma venda, três visões coerentes.**

### 4.3 Cliente cancela pelo bot (`cancelar_pedido`)
- Hoje: `commerce.cancel_manual_order` em `commerce.orders`.
- **Novo:** se o pedido tem partner_order vinculado → também `cancel_partner_local_order` (libera
  reserva + cancela recebível). **Propaga nos dois** (a LEI: o dono cancela, o espelho segue).

### 4.4 Cliente edita pelo bot (`editar_pedido`)
- Endereço/pagamento/itens refletem no partner_order vinculado. (Detalhar na implementação; menor
  prioridade que criar/cancelar.)

### 4.5 Parceiro finaliza entrega (no portal dele)
- `pending→dispatched→delivered` na máquina (intocada). Na entrega: reserva→baixa + recebível
  recebido (caixa). **O status volta pro espelho** `commerce.orders` (sync parceiro→centro) pra o
  bot responder "cadê meu pedido" certo. (sync de status = item de §6.)

---

## 5. Roteamento (o "cérebro") — região → disponibilidade

`resolveUnitForOrder()` (hoje devolve a única ativa; **costura** pronta). Regra completa:
1. **Região:** unidades cuja **cobertura** (P2) inclui o local do cliente.
2. **Disponibilidade:** dessas, as que **têm o item** (`partner_stock_levels` p/ parceiro;
   `stock_levels` p/ matriz).
3. **Escolha:** a que passa nos dois. Se a regional não tem → **matriz (P3)**.
4. **FASE 2 (vários parceiros na MESMA região):** distribuição justa ponderada por métricas do
   parceiro (rodízio + desempenho + **ranking de honestidade** do anti-fraude). Mesma função, só a
   regra interna muda. (Ver anti-fraude §3.5.2.)

---

## 6. Dados novos a capturar (estatística por parceiro) — "uma fonte, duas telas"

- **Venda por loja / 2w:** já sai de `partner_orders` + `commerce.orders.unit_id`. (Rede já lê.)
- **NOVO — log de roteamento:** registrar a **indicação** ("bot mandou pro parceiro X"), o
  resultado (fechou?) e o **fallback** ("parceiro sem estoque → matriz"). Não cabe no pedido
  sozinho. Mora num **log na camada Rede/ops** (ex.: `ops.routing_decisions` ou `audit.events`),
  **fora do analytics do bot** (sagrado).
- **Princípio:** analytics = ângulo do **bot** (conversa→conversão); Rede = ângulo do **parceiro**
  (lead→fechou→comissão). Ambas leem a **mesma venda**. **Uma fonte de verdade, duas telas.**

---

## 6b. ROADMAP POR ETAPAS (a ordem de execução)

> Consolidado após o cross-check (§10b). Cada etapa entrega valor e é testável sozinha.

### ETAPA 0 — Provar o cérebro (risco ZERO) ← EM EXECUÇÃO
- Ligar **1 item** do estoque do parceiro-teste ao catálogo (dado de teste).
- Regra de cobertura **de teste**: parceiro = Itaboraí, matriz = resto.
- Função `decideStoreForOrder` (região → estoque → fallback matriz) + script que imprime a decisão.
- **Entregável:** ver o bot escolhendo a loja certa na tela. **Não toca no bot real.**

### ETAPA 1 — Fase 0a: Matriz ganha `unit_id` (risco BAIXO, ganho já)
- Migration **aditiva**: link `orders.partner_order_id` + uso de `unit_id`. Sem DROP.
- `criar_pedido` grava `unit_id` (venda da matriz = `main`). **Cliente não vê diferença.**
- Verifica analytics intacto. Ganho: os dados passam a saber **de qual loja** é a venda.

### ETAPA 2 — Encher o parceiro (pré-requisitos P1 + P2)
- **P1:** estoque do parceiro ligado ao catálogo (o "recebimento" — sua ideia do Catálogo).
- **P2:** cobertura por unidade (modelo: `unit_id` em `delivery_zones` OU tabela `unit_coverage`)
  + frete do parceiro.
- Endereço/identidade do parceiro disponíveis ao bot.

### ETAPA 3 — Fase 0b: Bot fala certo sobre o parceiro (o serviço pesado)
- Roteamento **cedo** (turno 2-3, quando sabe bairro+produto).
- Tools de busca/frete/política com **contexto de unidade** (corrige C2/C3/C5).
- Prompt **sem identidade fixa** (corrige C4).
- `criar_pedido`: **ponte** → `partner_order` (`register_partner_local_order`, `source_tag='2w'`, COD).
- `consultar`/`cancelar`/`editar` sincronizados (C6/C7) + suavizar resumo (C8).

### ETAPA 4 — Estatística por parceiro + distribuição (futuro)
- Log de roteamento (indicação / fechou / fallback).
- Estatística por parceiro na Rede (lê `commerce.network_orders_unified`, que já existe).
- Distribuição justa + ranking de honestidade (quando houver vários parceiros/região).

### ETAPA 5 — Validação + deploy (gate do Wallace)
- Teste ponta-a-ponta no ambiente de teste (loop de limpeza já validado).
- **Apply migration em prod + Redeploy no Coolify** — manual, decisão do Wallace.

---

## 7. Passos de implementação (com âncoras verificadas)

| # | Passo | Onde | Risco |
|---|---|---|---|
| P1 | Vincular estoque parceiro↔catálogo (teste: UPDATE product_id) | dado de teste | baixo |
| 0 | **Provar o cérebro** (região+estoque+fallback) — script de teste, sem tocar no bot | novo script | **ZERO** |
| 1 | Migration aditiva: link `commerce.orders ↔ partner_order` (ex.: `orders.partner_order_id`), `unit_id` no fluxo. Sem DROP. | `db/migrations` | médio (schema prod) |
| 2 | `resolveUnitForOrder()` evoluir p/ região+disponibilidade | `src/atendente-v2/fulfillment.ts` (✅ esqueleto) | baixo |
| 3 | `mapProductToPartnerStock` (✅ feito) | idem | baixo |
| 4 | Resolver `partner_customer` do contato | reusa `upsertPartnerCustomerWithClient` | baixo |
| 5 | **Rewrite `criarPedido`** → ponte (matriz=orders / parceiro=orders espelho+partner_order COD), atômico, `source_tag='2w'`, preço central | `src/atendente-v2/tools.ts:335` | **alto (sagrado)** |
| 6 | Sync `cancelar`/`editar_pedido` + status parceiro→espelho | `tools.ts` | médio |
| 7 | Cobrança 2w — **NADA a mudar na leitura** (já lê `source_tag='2w'`); só garantir o bot gravar | — | mínimo |
| 8 | Verificação ponta-a-ponta (loop de teste) | — | — |

> **Prompt do bot (`prompt.ts`): NÃO muda na Fase 0.** Unidade é resolvida no servidor; o bot não
> sabe de loja. Blast radius do "sagrado" fica contido ao executor `criar_pedido`.

---

## 8. Riscos e mitigação

1. **Números brigando (drift do espelho).** → LEI do "um dono" (§2.1) + propagação no cancel/edit
   (§4.3/4.4). O espelho `commerce.orders` nunca tem status COD próprio.
2. **Atomicidade cross-pool.** O bot (pool global, BYPASSRLS) precisa criar partner_order +
   recebível + espelho **na MESMA transação** (`SET LOCAL app.partner_unit_id` no client do bot,
   chamar a função SQL direto). Senão, risco de órfão (partner_order sem espelho). Idempotency_key
   protege retries. **Decisão de implementação: transação única no pool do bot.**
3. **Estoque parceiro sem catálogo (P1).** Sem resolver, item vira "Item livre" (sem reserva) →
   anti-fraude/estoque furado. **P1 é pré-requisito duro.**
4. **Cobertura inexistente (P2).** Sem modelo de cobertura, roteamento por região não é real (só
   teste). Decidir schema antes de produção.
5. **Matriz não alcança a região do fallback (P3).** Tratar "ninguém atende" (retirada/falta).

---

## 9. Plano de teste (risco zero primeiro)

1. **Passo 0 — cérebro isolado:** script que, dado (bairro, produto), imprime a loja escolhida.
   Casos: Itaboraí+tem→parceiro; Itaboraí+não tem→matriz; outro lugar→matriz. **Não toca no bot.**
2. **Ponta-a-ponta (após #5):** no ambiente de teste (que já sabemos limpar): manda mensagem →
   confere: venda de parceiro vira `commerce.orders` (espelho) **+** `partner_order` (`pending`,
   `source_tag='2w'`, estoque reservado, recebível aberto); analytics conta "fechou"+faturamento;
   cobrança 2w aparece. Venda fora de Itaboraí → só `commerce.orders` (matriz).
3. **Sync:** cancelar pelo bot → reserva liberada no parceiro + espelho cancelado.

---

## 10. Decisões ainda em aberto (pra Wallace)

1. **P2 — como guardar cobertura:** `unit_id` em `delivery_zones` vs tabela `unit_coverage`.
2. **Formato do link orders↔partner_order:** coluna em `orders` (`partner_order_id`) — recomendado.
3. **Log de roteamento:** `audit.events` (rápido) vs tabela dedicada `ops.routing_decisions`
   (melhor pra estatística). Recomendo tabela dedicada quando for medir distribuição.
4. **Matriz alcança Itaboraí no fallback?** (frete próprio / só retirada / em falta).

---

## 10b. CROSS-CHECK (prompt + tools + consumidores) — pontos a melhorar

> Feito a pedido do Wallace: ler o **prompt inteiro**, traçar as **5 tools** do bot contra o fluxo
> de parceiro, e varrer **todos os consumidores** de `commerce.orders`. Resultado: o plano da
> espinha está certo, mas o cross-check **achou conflitos** — e **corrige uma afirmação minha**.

### ⚠️ CORREÇÃO ao §7: "o prompt NÃO muda na Fase 0" estava ERRADO.
O prompt tem **identidade da matriz embutida** e todo o fluxo de cotação assume **estoque/frete da
matriz**. Rotear pra parceiro **exige** mexer no prompt e nas tools de busca/frete. Detalhes abaixo.

### O nó central (CRÍTICO): o bot cota MATRIZ antes de decidir a loja
Fluxo atual: saudação → cota preço **+ estoque** → frete → fecha → `criar_pedido`. O roteamento
estava planejado **só no `criar_pedido`** (no fim). Mas tudo que o bot fala ANTES é **da matriz**:

| Tool | Lê (verificado) | Problema p/ venda de parceiro |
|---|---|---|
| `buscar_produto` | `commerce.product_full` (estoque matriz, global) | bot diz "tenho sim" com base no estoque da MATRIZ — o parceiro que vai entregar pode **não ter** |
| `verificar_estoque` | `commerce.stock_levels` (matriz, global) | idem |
| `calcular_frete` | `commerce.delivery_zones` (GLOBAL, sem unit_id) | frete cotado pode **não bater** com o da loja roteada |
| `buscar_politica` | `commerce.store_policies` (GLOBAL, **sem unit_id** — verificado) | endereço de **retirada** = sempre o da matriz, errado p/ parceiro |
| prompt (linha 171) | hardcoded *"A loja fica em São Gonçalo… entrego no Rio inteiro"* | identidade/cobertura da MATRIZ — **mentira** se o parceiro atende |

→ **Conclusão:** o roteamento **não pode** acontecer só no `criar_pedido`. Tem que decidir a loja
**assim que tiver bairro + produto** (turno 2-3), e a partir daí o bot cota **estoque, frete e
identidade DA LOJA ROTEADA**. Senão o bot promete matriz e entrega parceiro (estoque/frete/endereço
divergentes). **Isso amplia o escopo da Fase 0**: além do `criar_pedido`, entram as tools de
busca/frete/política (precisam de contexto de unidade) e o prompt (identidade não-hardcoded).

### Lista priorizada de pontos a melhorar

| # | Severidade | Ponto | Correção |
|---|---|---|---|
| C1 | 🔴 CRÍTICO | Roteamento tarde demais (só no criar_pedido) | mover decisão p/ turno 2-3 (bairro+produto); cotar a partir da loja roteada |
| C2 | 🔴 CRÍTICO | Estoque cotado = matriz, não da loja que entrega | `buscar_produto`/`verificar_estoque` precisam de **contexto de unidade** (estoque do parceiro p/ venda de parceiro) — depende do **P1** (estoque parceiro ligado ao catálogo) |
| C3 | 🔴 CRÍTICO | Frete global, não da loja roteada | `calcular_frete` por unidade — depende do **P2** (cobertura/zona por loja) |
| C4 | 🟠 ALTO | Prompt hardcoda "São Gonçalo / entrego no Rio inteiro" | tirar identidade fixa; "de onde vocês são / cobertura" vem da **loja roteada** |
| C5 | 🟠 ALTO | Retirada usa endereço da matriz (`store_policies` global) | endereço de retirada **por unidade** (store_policies por loja ou fonte da unidade) |
| C6 | 🟠 ALTO | `consultar_pedido` lê status de `commerce.orders` | sincronizar status do parceiro→espelho (já em §6; **confirmado essencial**) |
| C7 | 🟡 MÉDIO | `editar_pedido` mexe só em `commerce.orders` (tools.ts:682/689/743) | propagar ao partner_order vinculado |
| C8 | 🟢 BAIXO | Resumo: "Já separamos e sai pra entrega" | p/ parceiro, quem despacha é a loja; suavizar ("já tá separado, sai pra entrega") |

### ✅ Boas notícias do cross-check (de-riscam)
- **`commerce.network_orders_unified` JÁ EXISTE** (verificado): `UNION ALL` de `commerce.orders`
  (rótulo 'Matriz') + `partner_orders` (slug/nome do parceiro), com `source_tag` normalizado e
  `unit_id`. **É a leitura unificada pronta pra ponte** — a matriz lê "todos os pedidos da rede"
  daqui. Ainda **não usada no código** (esperando). Encaixa perfeito no §2.
- **`commerce.customer_profile`** (memória do cliente) agrega `commerce.orders` por `contact_id`.
  Como o espelho central nasce em TODA venda (matriz e parceiro), a **memória do cliente fica
  completa** — reforça que o espelho é obrigatório (partner_orders não tem `contact_id`).
- **Consumidores de `commerce.orders` mapeados e contidos:** `analytics.v_conversation_summary`,
  `analytics.customer_journey_mv`, `analytics.v_clientes_pra_recuperar`, `commerce.customer_profile`,
  `commerce.network_orders_unified`, `dashboard.pedidos_recentes`, e as tools do bot. **Adicionar
  `unit_id`/espelho não quebra nenhum** (nenhum exige `unit_id` NULL). Sem landmine escondido.

### Implicação no escopo (honesta)
A Fase 0 "de verdade" (venda de parceiro ponta-a-ponta **sem o cliente perceber divergência**) é
**maior** do que "rewrite do criar_pedido": inclui **roteamento cedo** + **tools de busca/frete/
política com contexto de unidade** + **prompt sem identidade fixa**. Os pré-requisitos **P1
(estoque↔catálogo)** e **P2 (cobertura por unidade)** deixam de ser "depois" e viram **parte do
caminho crítico** — sem eles, C2 e C3 não têm como ser corretos.

**Alternativa de faseamento (reduzir risco):** Fase 0a = só **matriz** (resolve `unit_id`, espelho,
não muda nada do fluxo atual — risco baixo, já melhora os dados). Fase 0b = **parceiro** (exige
C1-C5 + P1 + P2). Assim a parte seamless de parceiro não atrasa o ganho da matriz.

---

## 12. REGISTRO DE EXECUÇÃO (log por etapa)

### ✅ ETAPA 0 — Provar o cérebro — CONCLUÍDA (2026-06-02)
- **Feito:** `decideStoreForOrder()` em `src/atendente-v2/fulfillment.ts` (região → estoque →
  fallback matriz); cobertura de teste (`partnerCoversRegion_TEST` = Itaboraí); item de estoque do
  parceiro-teste `4e6899e7` ("Pneu", 9un) ligado ao catálogo `4252423b` (100/80-17 Dianteiro, R$99).
- **Prova (3/3 OK), rodada na base real de teste:**
  | Caso | Decisão | ✓ |
  |---|---|---|
  | Itaboraí + pneu que o parceiro TEM | **PARTNER** (Borracharia) + preço central R$99 | ✅ |
  | Itaboraí + pneu que o parceiro NÃO tem | **MATRIZ** (fallback) | ✅ |
  | Niterói + pneu (fora da região) | **MATRIZ** | ✅ |
- **Risco:** zero — bot real intocado; `decideStoreForOrder` ainda **não é importado** por ninguém.
  1 UPDATE em dado de teste (reversível: `product_id=NULL` em `4e6899e7`).
- **typecheck:** ✅. **Branch:** `feat/fundacao-bot-partner-orders` (não commitado, não deployado).
- **Aprendizado:** a costura de cobertura (`partnerCoversRegion_TEST`) e o estoque-matriz vs
  estoque-parceiro funcionam como previsto. P1 (estoque↔catálogo) confirmado como pré-requisito real.

### ✅ ETAPA 1 — Matriz ganha `unit_id` (Fase 0a) — CONCLUÍDA (2026-06-02)
- **Feito:** `resolveMatrizUnitId()` em `fulfillment.ts`; `criar_pedido` (`tools.ts`) agora resolve
  a unidade da matriz e grava `commerce.orders.unit_id` em toda venda do bot. **Sem migration** (a
  coluna `unit_id` já existia, vinha NULL). Sem mudança visível pro cliente.
- **Descoberta:** a migration do link `orders.partner_order_id` **não pertence à Etapa 1** — ela só
  é usada quando existe `partner_order` (Etapa 3). Movida pra Etapa 3.
- **Prova (end-to-end, com rollback):** `executeTool('criar_pedido')` numa conversa de teste criou
  `PED-0016` com **`unit_id` = "Loja Principal"** (antes: NULL). Rollback — sem deixar pedido.
- **Regressão:** `npm run typecheck` ✅ · `npm test` ✅ **245/245**.
- **Risco:** baixo — só adiciona `unit_id` (coluna existente, nullable); analytics/painel intactos
  (nenhum consumidor exige `unit_id` NULL). Bot real ainda **não deployado** (gate Etapa 5).
- **Estado:** branch `feat/fundacao-bot-partner-orders`, não commitado, não no ar.

### ✅ ETAPA 2 — Encher o parceiro (cobertura + frete) — CONCLUÍDA (2026-06-02)
- **Decisão Wallace:** matriz cobre **tudo** (fallback universal); parceiro cobre **áreas
  específicas** (Borracharia = Itaboraí); parceiro pega a venda só se **cobre a área E tem o pneu**,
  senão matriz; **frete fixo R$ 9,90** pra todos. *(Frete fixo aplicado no caminho do parceiro; o
  frete variável atual da MATRIZ ficou inalterado — mudança global a confirmar à parte.)*
- **Feito:** `decideStoreForOrder` deixou de usar regra chumbada e passou a ler **cobertura por
  loja** de `PARTNER_COVERAGE` (config, com normalização de acento/maiúscula) + constante
  `FRETE_PADRAO_BRL = 9.9`. Frete fixo simplificou: **não precisou** mexer na tabela de zonas nem
  amarrar frete por loja (a discussão Opção A vs B ficou sem objeto).
- **Prova (4/4 OK):** Itaboraí (com/sem acento, maiúsc) + parceiro tem → PARTNER; parceiro sem o
  pneu → MATRIZ (fallback); Niterói → MATRIZ.
- **P1 (estoque↔catálogo):** o **mecanismo** existe e é lido (`mapProductToPartnerStock`); 1 item de
  teste ligado. A **UI de recebimento** (parceiro escolhendo do catálogo ao receber pneu) é feature
  própria = a "aba Catálogo" idealizada — fica pra produtizar depois; não bloqueia a fundação.
- **Regressão:** `typecheck` ✅ · `npm test` ✅ **245/245**.
- **Costura futura:** `PARTNER_COVERAGE` (config) → tabela `network.unit_coverage` quando houver
  vários parceiros. Assinatura de `decideStoreForOrder` não muda.
- **Estado:** branch `feat/fundacao-bot-partner-orders`, não commitado, não no ar.

### 🔨 ETAPA 3 — Bot fala certo do parceiro — EM ANDAMENTO (tijolo a tijolo)

**Tijolo 3.1 — `materializePartnerOrder` (o coração da ponte) — FEITO (2026-06-02)**
- **O quê:** helper em `fulfillment.ts` que cria o pedido do bot **na máquina do parceiro**,
  **atômico no client do bot** (mesma transação → rollback desfaz tudo). Reusa, **sem alterar** a
  máquina do parceiro: `upsertPartnerCustomerWithClient` (exportado) + `register_partner_local_order`
  (recebe `unit_id` explícito, sem GUC/RLS) + INSERT em `finance.partner_receivables` (COD).
- **Prova (na máquina real, com rollback):** partner_order nasceu `status=confirmed`,
  `delivery_status=pending` ("Em separação"), **`source_tag='2w'`**, total R$ 108,90 (99 + frete 9,90),
  cliente vinculado; **estoque reservado 0→1**; **recebível COD aberto** R$ 108,90 / 2w. Rollback
  limpou tudo (prova da atomicidade).
- **Regressão:** `typecheck` ✅ · `npm test` ✅ **245/245**.
- **Risco:** baixo — helper **inerte** (ainda não chamado pelo `criar_pedido`); 1 `export` add em
  `parceiro/queries.ts` (sem mudar lógica). Não toca a máquina do parceiro.

**Tijolo 3.2 — wire do `criar_pedido` + espelho + travas — FEITO e PROVADO (2026-06-03)**
- **Feito:** garfo de roteamento no `criar_pedido` (decideStoreForOrder por item; agrega: só vai ao
  parceiro se TODOS os itens caem no MESMO parceiro com estoque). Caminho parceiro materializa
  partner_order (2w + reserva + COD) **+** espelho `commerce.orders` (unit_id=parceiro, link
  `partner_order_id`). Helper `insertCommerceOrderMirror` compartilhado pelos 2 caminhos. Travas da
  revisão multi-agente, todas implementadas: **H1** total lido de volta do dono + itens a preço
  central; **H2** idempotência (`bot:order:{conv}:{hash}` + ON CONFLICT); **H3** bloqueio de
  cancelar/editar pedido de parceiro (escala humano); **H4** só delivery roteia; **H5** estoque
  rastreado+disponível. Migration `0081_orders_partner_order_link.sql` escrita (**NÃO aplicada em prod**).
- **Auditoria (2 agentes) + consertos:** lógica das 5 travas + regra multi-item confirmada correta;
  o único 🔴 era **operacional** (aplicar 0081 antes do deploy — é o gate, código+migration sobem
  juntos). Consertos aplicados: `logger.warn` nos fallbacks silenciosos (geo órfão / sem preço
  central) e recebível `ON CONFLICT DO NOTHING`. Bug **PRÉ-EXISTENTE** em `editar_pedido` (perde o
  frete no recálculo do total) flagado como **tarefa separada** — não é da rede.
- **Prova ponta-a-ponta** (`scripts/prova-3.2-fundacao.ts`, base real, transação que aplica a 0081 +
  **ROLLBACK** → nada persistiu): **TUDO VERDE.** (A) Itaboraí → PED-0017 no PARCEIRO; espelho ligado;
  total **108,90** (99 central + 9,90; frete cotado 25 **ignorado**); itens a 99; payment 'A receber';
  partner_order **2w pending**; estoque **reservou 0→1**; recebível COD aberto 108,90. (A2) retry →
  **mesmo** pedido, sem duplicar reserva/espelho. (C) cancelar pedido de parceiro → **bloqueado**
  (escala humano), pedido segue aberto. (B) pickup → **MATRIZ** (PED-0019), sem `partner_order_id`,
  total 99.
- **Regressão:** `typecheck` ✅ · `npm test` ✅ **245/245**.
- **Estado:** branch `feat/fundacao-bot-partner-orders`, **não commitado, não deployado**. Falta só
  (gate Wallace, Etapa 5): **aplicar 0081 em prod + deploy** — código e migration sobem JUNTOS.

**Tijolo 3.3 — Bot COTA a loja certa na conversa — NÚCLEO FEITO e PROVADO (2026-06-03)**
- **Keystone (pré-requisito que faltava):** `calcular_frete` agora **devolve `geo_resolution_id`** (a
  função já o calculava internamente mas não o expunha em `FreteResultado`). Sem isso o bot nunca
  conseguia repassar o id ao `criar_pedido` → na prática **o roteamento do 3.2 era INALCANÇÁVEL numa
  conversa real** (só passava na prova porque o id era injetado à mão). Campo aditivo e neutro.
- **C3a — fonte única da decisão (DRY):** extraído `decideStoreForItems(municipio, items)` em
  `fulfillment.ts` (encapsula "roteia cada item → só parceiro se TODOS no MESMO parceiro com estoque").
  `criar_pedido` passou a chamá-lo (≈35 linhas → 6). Refactor **sem mudança de comportamento** (245/245).
- **C3b — frete honesto:** `calcular_frete` (camada V2) consulta o MESMO `decideStoreForItems` e,
  quando a entrega cai num parceiro, devolve **R$ 9,90** em vez do frete da matriz — pra a cotação
  BATER com o que o `criar_pedido` cobra. Sem produto / fora de cobertura / parceiro sem o pneu →
  frete da matriz (backstop). Tool ganhou `produtos` (opcional) + 1 linha de prompt (plumbing).
- **C2 — busca mostra a loja que ATENDE:** `buscar_produto`/`buscar_compatibilidade` (camada V2)
  sobrepõem o estoque do parceiro (helper `getPartnerStockMap`) nos pneus que ele tem, quando o
  `bairro` cai numa região de parceiro; resto = matriz. Evita dizer "acabou" quando o parceiro tem.
  Schemas ganharam `bairro`/`municipio` (opcionais) + 1 linha de prompt.
- **Arquitetura:** toda a "consciência de parceiro" ficou na camada V2 (`tools.ts`/`prompt.ts`) +
  `fulfillment.ts`; o módulo compartilhado `src/atendente/tools/commerce-tools.ts` ficou **intacto
  (matriz puro)** — só ganhou o campo neutro `geo_resolution_id`.
- **Provas só-leitura** (calcular_frete/buscas só fazem SELECT → sem rollback): `scripts/prova-3.3-c3b.ts`
  → Itaboraí com produto = frete **9,90**, decisão casa o município "Itaboraí", keystone fluindo.
  `scripts/prova-3.3-c2.ts` → **TUDO VERDE** com contraste limpo: busca em Itaboraí mostra **9**
  (parceiro) **vs 10** (matriz) sem bairro → o bairro realmente troca o estoque mostrado.
- **Regressão:** `typecheck` ✅ · `npm test` ✅ **245/245** (após cada tijolo).
- **Decisões de escopo (Wallace, 2026-06-03):** **C1 (rotear cedo) DESCARTADO** — redundante (busca,
  frete e pedido já chamam o mesmo cérebro determinístico, concordam sozinhos). **C5 (endereço/prazo
  do parceiro) NÃO feito** — sem ganho real (prazo já vem certo da zona; entrega usa o endereço do
  cliente). **C4 (prompt sem identidade fixa / voz) NÃO feito — decisão do Wallace de não mexer na voz
  agora** (cosmético; o bot ainda diz "loja em São Gonçalo", mas nenhum NÚMERO mente).
- **Estado:** branch `feat/fundacao-bot-partner-orders`, **não commitado, não deployado**. Núcleo do
  3.3 (fala = registro, honestos e provados) fechado. **Gate real restante NÃO é mais código:**
  parceiro operacional de verdade? + **P1** (hoje só 1 produto ligado ao catálogo). Depois: aplicar
  0081 + deploy (gate Wallace, Etapa 5).

**Tijolo 3.4 — propagação REAL de cancelamento + status do parceiro no consultar (C6) — FEITO e PROVADO (2026-06-03)**
- **cancelar_pedido (o coração):** pedido roteado a parceiro deixou de ser BLOQUEADO (o guard H3 do
  3.2) e passou a **cancelar de verdade, propagado nos dois lados, atômico**: `cancel_partner_local_order`
  (0080: libera reserva + estorna o recebível — `open`/`received`) no DONO **+** `cancel_manual_order`
  (0032: só marca `status='cancelled'`, **não toca estoque da matriz**) no ESPELHO. BEGIN/COMMIT próprio
  (cancelar roda FORA da transação do `agent.ts`, que só envolve `criar_pedido`). **Guard de segurança:**
  só cancela enquanto `delivery_status='pending'` (Em separação); **despachado/entregue/falhou → escala
  humano** (mercadoria em trânsito / disputa). Já cancelado → informa.
- **C6 `consultar_pedido`:** o espelho `commerce.orders.status` de pedido de parceiro fica eternamente
  `'open'` (quem avança o estado é a máquina do parceiro). Agora o consultar faz LEFT JOIN no DONO e
  devolve `eh_parceiro=true` + `situacao_parceiro` já em linguagem de cliente (em separação / saiu para
  entrega / entregue / cancelado / entrega não concluída). +1 linha de prompt mandando o bot usar
  `situacao_parceiro` em vez do `status` do espelho.
- **C7 `editar_pedido` — ADIADO de propósito:** mantém escala-humano (seguro, zero órfão). Não existe
  `edit_partner_local_order` (re-reserva de estoque) na máquina; editar só metade (endereço sim, itens
  não) faria espelho e dono divergirem → **viola a LEI**. Propagação real de edição = follow-up (precisa
  da função de re-reserva). **C8 (suavizar resumo)** segue adiado com o C4 (cosmético).
- **Prova ponta-a-ponta** (`scripts/prova-3.4-cancel.ts`, base real, transação que aplica a 0081 +
  **ROLLBACK** → nada persistiu): **TUDO VERDE.** (1) parceiro PED-0020, reserva 0→1. (2) C6 antes →
  `em separação`. (3) cancelar → partner_order `cancelled`, **reserva 1→0**, recebível `cancelled`,
  espelho `cancelled`. (4) C6 depois → `cancelado`. (5) pedido `dispatched` → cancelar **bloqueado**
  (escala humano), partner_order segue `confirmed`, espelho `open`, reserva intacta (2).
- **Regressão:** `typecheck` ✅ · `npm test` ✅ **245/245**.
- **Estado:** branch `feat/fundacao-bot-partner-orders`, **não deployado**. A propagação de cancel já
  não está mais bloqueada no código; ainda depende do gate Wallace (Etapa 5: aplicar 0081 + deploy).

**Tijolos restantes da Etapa 3 (próximos):**
- 3.3 (polimento, ADIADO por decisão do Wallace 2026-06-03) — C4 (voz / prompt sem identidade fixa) +
  C5 (prazo/endereço do parceiro). C1 descartado (redundante). Núcleo do 3.3 já feito+provado (acima).
- 3.4 — **núcleo FEITO** (cancel + C6, acima). Restam: **C7 (propagação real de edição)** — follow-up
  que precisa de uma função de re-reserva no parceiro; e **C8** (cosmético, com o C4). Sync de status
  parceiro→espelho na ENTREGA (quando o parceiro despacha no portal) segue como item futuro se o bot
  precisar refletir mudanças que ocorrem fora da conversa.

**🔬 Revisão multi-agente do 3.2 (2026-06-03) — desenho ENDURECIDO antes de codar**
3 agentes (arquiteto `Plan` / red-team / reuso) revisaram a planta do 3.2 na fonte (código + prod).
Veredito convergente: o desenho-base (espelho `commerce.orders` + `partner_order` dono, ligados por
FK, atômicos na transação que o `agent.ts` já abre) está **certo**, MAS era **pequeno demais** —
faltavam guards sem os quais o 3.2 criaria estado que se corrompe sozinho. Decisões tomadas (todas
entram no 3.2):

| # | Achado (consenso dos agentes) | Decisão no 3.2 |
|---|---|---|
| H1 🔴 | Total do espelho recalculado dos números do LLM **diverge** do total que `register_partner_local_order` recalcula sozinho (preço central ≠ cotado; frete 9,90 ≠ frete global) — "números brigando" | Espelho **LÊ `total_amount` DE VOLTA** do partner_order materializado; `order_items` do espelho a **preço central**. Uma fonte de número por venda. (`materializePartnerOrder` retorna o total — já lê em `fulfillment.ts:356`.) |
| H2 🔴 | `criar_pedido` não é idempotente; `commerce.orders.idempotency_key` (UNIQUE parcial) **nunca é setado** → retry duplica o espelho → `v_conversation_summary` faz fan-out e conta a venda 2x | Key estável `bot:order:{conversationId}` setada no espelho (`ON CONFLICT DO NOTHING`) e **reusada** no `materializePartnerOrder`. Aplica também ao caminho matriz (corrige furo latente de hoje). |
| H3 🔴 | Após 3.2, `cancelar_pedido`/`editar_pedido` mexem **só** em `commerce.orders` → `partner_order` + estoque reservado + recebível ficam **órfãos**; `getPainelRede` fatura venda cancelada (viola a LEI) | 3.2 **BLOQUEIA** cancelar/editar quando `partner_order_id` não-NULL → erro estruturado → escala humano. **Mudança de fronteira:** a propagação REAL de cancel/edit (usa `cancel_partner_local_order`, já pronta em 0080) é puxada do 3.4, mas o **bloqueio-guard** entra no 3.2. |
| H4 🔴 | Pickup roteado a parceiro cria recebível COD **fantasma** (dinheiro nunca entra no caixa) + baixa física | Caminho parceiro **só com `modalidade='delivery'`**. Pickup → matriz. |
| H5 🟠 | `mapProductToPartnerStock` (`fulfillment.ts:136`) não filtra `is_tracked`/disponível → a "reserva" pode ser fantasia (linha não-rastreada) | Exigir `is_tracked=true AND (on_hand − reserved) ≥ qtd`; senão fallback matriz. |
| H6 🟢 | Duplicação: INSERT do espelho (matriz vs parceiro) e do recebível (bot `fulfillment.ts:362` vs portal `queries.ts:627`); bot **não grava** `audit.events` que o portal grava | Extrair `insertCommerceOrderMirror` (usado pelos 2 caminhos). Recebível: adicionar `audit.events` no bot agora; consolidação DRY com `registerPartnerSale` = **follow-up dedicado** (não incha o 3.2, e não mexe no caminho provado do portal). |

**Regra multi-item (decidida):** roteia cada item; o pedido vai ao parceiro SÓ se o conjunto-alvo
for `{1 único parceiro}` com estoque em todos os itens; misto / qualquer-item-matriz → pedido
inteiro na **matriz** (backstop). `partner_orders.unit_id` é NOT NULL → um pedido não pode ser meio
e meio; a regra é obrigatória, não só simplicidade.

**Fronteira final do 3.2:** roteamento no `criar_pedido` + espelho (total lido de volta) +
idempotência + restrição a delivery + guard de bloqueio de cancel/edit + estoque rastreado +
`insertCommerceOrderMirror`. → **3.3** = cotar a loja certa cedo (C1–C5) + prompt sem identidade
fixa. → **3.4** = propagação REAL de cancel/edit + sync de status (C6).

**Migration 0081** confirmada **NÃO aplicada em prod** (red-team checou `information_schema`) —
aplicar antes do wire (gate Etapa 5). Bot roda como `postgres` BYPASSRLS → `materializePartnerOrder`
roda direto no client do bot (sem RLS); corretude depende de passar `unit_id` certo (verificado).

---

### ✅ P1 — UI de recebimento: estoque do parceiro ↔ catálogo central — FEITO e PROVADO (2026-06-03)
Fecha o último pré-requisito da Etapa 2 que faltava produtizar (a "aba de recebimento"): o parceiro
agora **vincula cada item de estoque a um produto do catálogo central** (preenche
`partner_stock_levels.product_id`) — o ponteiro que o bot usa pra casar cotação↔estoque e rotear a 2w.

- **Tensão resolvida (silo isolado):** a VENDA do parceiro continua silo (aponta pra
  `partner_stock_levels.id` — decisão 2026-05-19, intacta). O vínculo é só **metadado de leitura** no
  cadastro de estoque. Verificado no banco: o role `farejador_partner_app` **já** tem SELECT em
  `commerce.products` (sem RLS) — o "silo" era de PRODUTO (endpoint removido), não trava técnica.
- **Backend:** `searchPartnerCatalog` (queries.ts) — busca read-only em `commerce.products` por
  nome/código/marca; rota `GET /parceiro/:slug/api/catalogo/busca`. `getPartnerEstoque` ganhou
  `LEFT JOIN commerce.products` → `catalog_product_name` (mostra o vínculo na lista/edição).
  `upsertPartnerStock`/`stockSchema` **já** aceitavam `product_id` — só faltava o front passar.
- **Front (Portal Parceiro):** campo "Vincular ao catálogo (pro robô achar esse pneu)" no modal de
  estoque (só pneu) — busca com dropdown (nome+código) → seleciona → chip verde com "Trocar". Vínculo
  **opcional** (item sem vínculo = "livre"; o bot só não roteia). **Bug evitado:** "Dar entrada"/
  "Ajustar saldo" (`_persistStockQuantity`) remontava o payload sem `product_id` → **apagaria o
  vínculo**; agora preserva.
- **Prova:** backend — `searchPartnerCatalog` e o JOIN rodados contra prod (item ligado mostra
  "Pneu Moto 100/80-17 Dianteiro Diagonal", livres = null). Front — `parceiro-static` (4599): Alpine
  boota sem erro de console, o campo renderiza nos 2 estados (busca com dropdown + chip vinculado,
  screenshots), e a interação busca→seleciona→chip→limpar funciona. typecheck ✅.
- **Escopo:** vínculo só pra `item_type='pneu'` (o que o bot roteia) e **opcional** (reversível);
  estende a outros tipos depois se precisar.
- **Estado:** branch `feat/fundacao-bot-partner-orders`, **não deployado**. Com o P1, a Etapa 2 fecha
  de verdade; faltam o parceiro real ligar o estoque dele + o gate Wallace (Etapa 5: aplicar 0081 + deploy).

---

## 11. Resumo executivo (1 parágrafo)

Toda venda do bot grava em `commerce.orders` (o analytics exige — verificado). Quando roteada a um
parceiro, **além disso** nasce um `partner_order` via a máquina pronta (`register_partner_local_order`)
com `source_tag='2w'` — e a cobrança da matriz **já conta isso sozinha** (verificado em
`getPainelRede`). O partner_order é o **dono** do dinheiro/estoque/entrega; o `commerce.orders` é
**espelho** pro analytics — **um dono por número, zero briga**. Dois pré-requisitos duros antes de
produção: **ligar o estoque do parceiro ao catálogo (P1)** e **criar cobertura por unidade (P2)**.
O prompt do bot não muda; o risco "sagrado" fica contido no `criar_pedido`. Começa pelo **Passo 0**
(provar o cérebro, risco zero).
