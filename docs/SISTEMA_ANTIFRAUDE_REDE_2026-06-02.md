# Sistema Anti-Fraude da Rede — especificação

**Data:** 2026-06-02 · **Autor:** Claude (Opus 4.8) sob direção do Wallace
**Status:** especificação (pré-implementação) · **Origem:** discussão estratégica sobre modelo
comercial da rede + ideia do código de confirmação de entrega (Wallace).

> Objetivo: garantir que **toda venda que o bot/tráfego gerou seja registrada e atribuída**,
> num modelo de **comissão sobre vendas 2w** — sem depender da honestidade voluntária do
> borracheiro. O anti-fraude não é uma trava: é o sistema fazendo um trabalho que o parceiro
> **e o cliente** já precisam, com a atribuição pegando carona.

---

## 1. Decisão estratégica que isto sustenta

> **DECISÃO DE SEQUÊNCIA (Wallace, 2026-06-02):** a fundação (§3.5) vem **antes** de polir a
> matriz. Motivo: a matriz é a camada de medição/cobrança; a fundação é o que está sendo medido.
> A comissão 2w que a matriz exibe hoje é ficção até o pedido do bot virar `partner_order`
> atribuído. **Wallace confirmou que vai escalar tráfego/parceiros no lançamento — e que ESTE
> fluxo (bot traz lead → parceiro entrega → tudo rastreado/comissão) É o apelo do produto.**
> Logo: encarar o risco do bot agora se justifica; a fundação é o portão do lançamento.

**Comissão-só agora, mensalidade depois (como graduação).** No estágio beta, cobrar
mensalidade trava o crescimento (menos parceiros) e cria compromisso de entregar lead todo mês.
Comissão sobre vendas 2w tem fricção zero pra entrar e alinha incentivo (você só ganha quando
entrega venda). **Mas** comissão-só só funciona se a atribuição for à prova de burla — senão
você banca o tráfego e a venda fecha por fora. Este documento é a defesa dessa atribuição.

O sistema já suporta modelo **por parceiro** (`network.partners.commercial_model` ∈
`commission|monthly|hybrid`). Default = `commission`; flipar parceiro pra `hybrid` quando o
valor estiver provado é o que o **Increment 2 (editor do modelo comercial)** destrava.

---

## 2. As burlas mapeadas (defender o alvo certo)

| # | Burla | Descrição |
|---|---|---|
| B1 | **Fechar por fora** | Bot manda o lead; parceiro vende e **não registra**. Comissão = 0. |
| B2 | **Trocar a origem** | Registra, mas marca `walkin`/`manual` em vez de `chatwoot_com_bot`/2w. |
| B3 | **Subfaturar** | Registra com preço/total **menor** que o real. |
| B4 | **Negar a conversão** | "Esse cliente não fechou" — quando fechou. |
| B5 | **Vazamento no tempo** | Cliente pega o contato direto da loja e, na próxima, fala direto. Some da atribuição. |

B1 e B5 são as mais perigosas: silenciosas e cumulativas.

---

## 3. Arquitetura anti-fraude — 3 camadas + a peça central

A verdade dura: **não se vence burla por vigilância.** A defesa durável é estrutural + usar o
lead como alavanca. Vigiar é o complemento.

### Camada 1 — Estrutural: o sistema é o trilho que o parceiro PRECISA
Faça o registro ser o **caminho mais fácil**, não uma obrigação chata. O pedido tem que passar
pelo sistema porque concluir a venda (despachar, baixar estoque, fechar o caixa, quitar o
recebível COD) **depende** disso. Pular o sistema dói no parceiro, não em você.

### Camada 2 — O cliente como testemunha neutra (a peça central, ver §4)
O cliente é o único que **não tem interesse** em ajudar o parceiro a sonegar a sua comissão.
Use isso — mas dando ao cliente um **motivo próprio** pra validar (não boa vontade).

### Camada 3 — Enforcement: o lead futuro como cenoura e porrete
Você controla a **demanda**. Parceiro com gap suspeito (muita cotação de alta intenção, poucos
pedidos; muitas finalizações "sem código"; divergências de valor) **cai no ranking** de
roteamento. Quem joga limpo ganha **mais** lead. É o oxigênio dele — mais forte que multa.

---

## 3.5 FUNDAÇÃO — roteamento bot→unidade + materialização em partner_orders (PRÉ-REQUISITO)

> ⚠️ **Sem esta seção, nada do anti-fraude funciona.** O código de entrega/retirada (§4) vive em
> `commerce.partner_orders`. Hoje o bot escreve em `commerce.orders` SEM `unit_id`. Os dois não se
> falam. O pedido do bot **nunca vira uma entrega do parceiro** — logo não há em que prender o código.

### 3.5.1 Diagnóstico (confirmado no banco em 2026-06-02)
1. **O pedido do bot nasce sem unidade.** A tool `criar_pedido` (`src/atendente-v2/tools.ts:368`)
   faz `INSERT INTO commerce.orders` **sem `unit_id`**. Dado real: `orders total=1, com unit_id=0`.
2. **Dois mundos de pedido desconectados:**

   | `commerce.orders` (bot escreve aqui) | `commerce.partner_orders` (a máquina real) |
   |---|---|
   | `unit_id` **NULL** | `unit_id` **NOT NULL** |
   | sem `delivery_status`, sem COD, sem baixa de estoque | `delivery_status` `pending→dispatched→delivered`, frete |
   | ligado a conversa/contato do bot (`source='chatwoot_com_bot'`) | ligado a `finance.partner_receivables` (COD) + `commerce.partner_stock_levels` |
   | é só **registro/ledger** | é o **trilho operacional** (onde o §4 atua) |

3. **Não há ponte.** Zero FK ligando `orders` ↔ `partner_orders` (verificado em `pg_constraint`).
   São universos paralelos.

**Consequência:** o borracheiro não consegue clicar "saiu pra entrega" num pedido do bot — ele não
está na máquina dele. Atribuição (comissão 2w) e anti-fraude ficam ambos sem chão.

### 3.5.2 O que precisa ser feito — duas peças

**(A) Resolver a unidade no momento do pedido (roteamento).**
Gancho que JÁ existe: `calcular_frete` usa `commerce.delivery_zones`, que são **por unidade**. Ou
seja, a cadeia *geo do cliente → zona de entrega → unidade* já está meio fiada (o frete já implica
uma unidade). Falta **aflorar esse `unit_id`** e passá-lo ao `criar_pedido`.

> **IMPORTANTE — a matriz é uma LOJA também (Wallace, 2026-06-02).** Wallace vende varejo
> direto. Logo a **própria matriz é uma unidade no pool de roteamento**, lado a lado com os
> parceiros. Diferença: venda da matriz = fica com tudo; venda do parceiro = fica a comissão.
> O bot escolhe **UMA** loja por pedido (o pedido pertence inteiro a ela).

**Critério de roteamento (decisão Wallace, 2026-06-02):**
- **CAMADA 1 — Região (já vale hoje):** o cliente é atendido pela loja que **cobre a região
  dele** (`delivery_zones`). Hoje há só matriz + 1 parceiro, áreas não-sobrepostas → trivial.
  Princípio: a matriz atende a área dela; parceiros **estendem o alcance** onde a matriz não
  chega bem (longe/frete caro). Ninguém compete pelo mesmo cliente.
- **CAMADA 2 — Distribuição justa entre pares (FASE 2, quando houver >1 parceiro na MESMA
  região):** o bot **não manda sempre pro mesmo** — distribui as vendas entre os parceiros da
  região pra "deixar todo mundo feliz", ponderando por métricas do parceiro:
  - **rodízio/fairness** (quem vendeu menos recentemente leva a próxima — ninguém fica na seca);
  - **desempenho** (conversão, tempo de resposta, reclamações);
  - **ranking de honestidade** (Camada 3 / §3 — quem registra a venda limpa sobe na fila).
  > Ou seja: **anti-burla e distribuição de venda são a MESMA régua** — quem joga limpo e
  > atende bem é recompensado com mais lead. O `resolveUnitForOrder()` (costura) já isola isso:
  > hoje devolve a loja da região; na Fase 2 troca a regra interna por região → scoring →
  > distribuição, sem mudar quem chama.
- **Retirada:** unidade escolhida / mais próxima do cliente.

**MODELO DE ESTOQUE/PREÇO — RESOLVIDO (Wallace, 2026-06-02):**
- **Estoque = da loja (parceiro).** O bot vende o que a unidade roteada **fisicamente tem**
  (`commerce.partner_stock_levels`), reserva e baixa **na loja**. Coerente com a máquina COD atual.
- **Preço = tabelado central.** Igual pra todas as unidades — vem da tabela central
  (`commerce.product_prices`/`commerce.products`), **NÃO** do `partner_stock_levels.sale_price`.
- **Consequência:** o bot precisa (a) ofertar só o que a unidade tem em estoque e (b) cotar pelo
  **preço central**. O item do pedido casa `commerce.products.product_id` → o
  `partner_stock_levels.id` (`partner_stock_id`) daquela unidade; `unit_price` = preço central.
- **Atribuição (correção):** a venda 2w é marcada por **`partner_orders.source_tag='2w'`**
  (enum existente), **não** por `commerce.orders.source='chatwoot_com_bot'`. A cobrança da matriz
  deve ler `source_tag='2w'`.

**(B) Materializar o pedido na máquina do parceiro.**
O pedido do bot tem que **nascer como `partner_order`** da unidade roteada (ou ser promovido na
hora), com:
- `unit_id` = unidade roteada;
- `delivery_status = 'pending'`;
- `source_tag = 'chatwoot_com_bot'` ← **é isto que marca como venda 2w pra comissão**;
- `customer_phone` / `customer_id` vinculados (resolver/crear `partner_customers`);
- **reserva** em `commerce.partner_stock_levels`.

Aí o card aparece pro parceiro → "saiu pra entrega" → dispara o código (§4) → finaliza com o código
→ baixa estoque + recebe COD. O anti-fraude se conecta.

### 3.5.3 Arquitetura — PONTE (não convergência) — CORRIGIDO 2026-06-02

> ⚠️ **Correção:** a ideia inicial de "convergir tudo pra `partner_orders`" **viola o contrato V2.**
> Motivo descoberto na investigação do código:
> 1. **`analytics` lê `commerce.orders`** (`v_conversation_summary` join por `source_conversation_id`)
>    pra medir conversão/faturamento da conversa. Matar `commerce.orders` quebraria o analytics
>    (intocável).
> 2. **O bot tem 4 tools sobre `commerce.orders`** (`criar/consultar/cancelar/editar_pedido`).
>    Migrar só a criação quebra as outras três.

**Decisão: PONTE.** `commerce.orders` **permanece** (analytics + tools de consulta/cancel/edit do
bot) e, na criação, nasce **junto** um `partner_order` **vinculado** — o registro de fulfillment
(COD + entrega + anti-fraude + comissão `source_tag='2w'`). Os dois ligados por FK; o `partner_order`
é o "braço operacional" do `commerce.orders`.

**Regras de sincronia (a disciplina que evita o bug de duplicação):**
- **Criar:** `commerce.orders` (com `unit_id` agora) + `partner_order` vinculado (reserva estoque,
  COD, `source_tag='2w'`).
- **Cancelar/editar pelo bot:** propaga ao `partner_order` (cancelar **libera a reserva**;
  editar item/endereço reflete nos dois).
- **Finalizar entrega:** acontece no `partner_order` (máquina COD), com o código (§4); o
  `commerce.orders` é só espelho de conversão.
- **Comissão:** `getPainelRede`/cobrança da matriz lê **`partner_orders.source_tag='2w'`**.

### 3.5.4 Decisão de produto — RESOLVIDA (Wallace, 2026-06-02)

**Fase 0 (lançamento):** **auto-reserva** + **uma única loja**.
- O bot fecha e **já reserva** o estoque da loja na hora (`delivery_status='pending'` + reserva).
- Roteamento trivial: toda venda do bot vai pra única unidade ativa.

**Fase 2 (documentada p/ depois, NÃO implementar agora):**
- **Parceiro confirma antes:** pedido nasce `aguardando_aceite`; parceiro aceita em X min ou o bot
  reroteia. Robusto contra loja sobrecarregada.
- **Multi-loja:** o bot escolhe entre lojas por geo (zona de entrega) ∩ estoque ∩ ranking de honestidade.

**Custo de fazer a Fase 2 depois ≈ baixo, SE a Fase 0 deixar duas costuras prontas:**
1. **Reserva disparada por ESTADO, não inline na criação.** A reserva de estoque é acionada por
   *entrar no estado que compromete o estoque* — não chamada direto no "criar pedido". Auto-reserva =
   o pedido nasce já nesse estado. "Parceiro confirma" = só **atrasa** o disparo (nasce em
   `aguardando_aceite`, reserva no aceite). Adicionar o estado novo vira aditivo, não reescrita.
2. **Escolha da unidade isolada em `resolveUnitForOrder()`.** Hoje retorna a única loja ativa; amanhã
   faz geo ∩ estoque ∩ ranking. Quem chama (o `criarPedido`) **não muda**.

> Regra: a Fase 0 entrega o caminho simples, mas **com a porta aberta**. Custo de deixar a porta
> aberta agora ≈ zero; custo de não deixar = cirurgia na Fase 2.

### 3.5.5 Pontos de inserção (código)
- **`src/atendente-v2/tools.ts` — `calcular_frete`:** retornar também o `unit_id` da zona resolvida
  (ou expor uma resolução geo→unidade reutilizável).
- **`src/atendente-v2/tools.ts:335` — `criarPedido`:** receber/resolver `unit_id`; em vez de (ou
  além de) `commerce.orders`, gravar `commerce.partner_orders` com `unit_id` + `delivery_status='pending'`
  + `source_tag='chatwoot_com_bot'` + reserva de estoque; vincular `partner_customers`.
- **`src/atendente-v2/prompt.ts`:** garantir que o fluxo capture a unidade (na entrega vem do frete;
  na retirada, perguntar/derivar) antes do `criar_pedido`.
- **Migration (se promoção, não convergência):** FK `partner_orders.source_order_id`/conversa +
  índice. Se convergência: nenhuma tabela nova, só passar a escrever em `partner_orders`.

---

## 4. Peça central — Código de confirmação (entrega + retirada)

**Ideia (Wallace):** quando o bot cria o card de entrega e o parceiro clica "saiu pra entrega",
chega uma mensagem ao cliente com um **número**; a entrega **só finaliza com esse número**.

É o modelo iFood/Uber: o cliente vira um **portão obrigatório**. O parceiro não consegue fechar
a entrega (= dar baixa no estoque + receber o COD no caixa) sem o cliente. A venda **tem que**
estar no sistema pra concluir.

### 4.1 Por que o parceiro ADOTA (não resiste)
O código **protege o parceiro também**: contra o cliente caloteiro que diz "não recebi". Com
código usado, o parceiro tem prova de entrega. **Venda-se assim** — "esse número é a sua
segurança contra cliente que dá calote" — e ele usa de boa vontade. Controle que só vigia é
sabotado; controle que também protege é abraçado.

### 4.2 Fluxo ENTREGA (COD) — onde o código entra na máquina de estados

Máquina atual (real): `updatePartnerDeliveryStatus()` em `src/parceiro/queries.ts:772`.
Estados `pending → dispatched → delivered`; `failed` cancela e devolve estoque.

```
pending
  │  parceiro clica "Saiu pra entrega"  ──► transição p/ dispatched
  │      ►► NOVO: gera codigo (4–6 dígitos, single-use, atrelado ao order_id)
  │      ►► NOVO: bot envia ao cliente: "Pedido #1234 · Pneu X · R$ 99 ·
  │              seu código de entrega: 4821 · guarde, é a sua garantia"
  ▼
dispatched
  │  motoboy chega; cliente DITA o código; parceiro digita pra finalizar
  │      ►► NOVO: transição p/ delivered SÓ é permitida se codigo confere
  ▼
delivered  (hoje, em src/parceiro/queries.ts:841-885 — INTOCADO, só gateado pelo código):
     • commerce.deliver_partner_local_order() → reserva vira baixa física de estoque
     • partner_orders.status = 'paid', delivered_at = now()
     • finance.partner_receivables → 'received' (entra no CAIXA do dia, COD)
     • audit.events: partner_delivery_status_changed
```

**Ponto de inserção exato:** o guard do código entra **antes** do bloco
`if (input.delivery_status === 'delivered' ...)` em `queries.ts:841`. Sem código válido →
rejeita a transição (erro `delivery_code_required` / `delivery_code_invalid`), e **nada** do
delivered roda (estoque e caixa intocados).

### 4.3 Fluxo BALCÃO / RETIRADA — o mesmo truque, gatilho diferente
A entrega cobre só venda **com entrega**. No balcão (cliente busca) não há "saiu pra entrega"
pra disparar o código — e é onde o vazamento é mais fácil.

Correção: quando o bot cria um pedido de **retirada**, gera um **código de retirada** que o
cliente mostra/fala no balcão; o parceiro só fecha o pedido (e baixa o estoque) com esse código.
Mesma lógica, gatilho na criação do pedido em vez do "dispatched".

### 4.4 O valor no código → mata o subfaturamento (B3)
A mensagem ao cliente inclui o **valor** ("Pneu X por R$ 99"). Quando o cliente dita o código,
ele já viu o valor. Cruzar com o que o parceiro registrou: divergência → flag. Opcional: o bot
pergunta "foi esse valor?" no follow-up.

### 4.5 Saída de emergência auditada (não travar entrega legítima)
Casos reais: cliente sem WhatsApp, não viu a mensagem, motoboy não alcançou. Tem que existir
**"finalizar sem código"** com **motivo obrigatório**, que:
- fica logado em `audit.events` (event_type novo, ex: `delivery_finalized_without_code`),
- **conta contra o ranking de honestidade** do parceiro (Camada 3).

Assim o escape existe (entrega legítima nunca trava), mas é raro, visível e caro de abusar.
Parceiro que usa "sem código" toda hora → bandeira vermelha.

### 4.6 Detalhes de segurança do código
- 4–6 dígitos, **single-use**, atrelado só àquele `order_id`, expira/regenera.
- **Rate limit** de tentativas na finalização (não dá pra chutar na tela).
- Reenvio fácil: botão "cliente não recebeu o código" → bot reenvia (entrega legítima nunca
  presa por falha de mensagem).
- Conluio cliente+parceiro: teórico; o cliente não ganha nada ajudando a sonegar a SUA
  comissão. Risco baixo — ignorar por ora.

---

## 5. Validação pelo cliente — camadas complementares (além do código)

Pro que **não** tem entrega/retirada com código (ou como reforço):

1. **Garantia atrelada ao código/pedido** — cliente quer o registro pra acionar garantia depois.
   Vira aliado que **cobra** o registro do parceiro. (Mata B1, B4.)
2. **Confirmação de valor no follow-up** — bot pergunta "recebeu o pneu X por R$ 99?". (Mata B3, B4.)
3. **Recompensa por confirmar** — "confirme e ganhe balanceamento grátis / 5% no próximo".
   Liga a torneira de resposta + abre recompra direto pelo bot (combate B5). 

---

## 6. Matriz burla × defesa

| Burla | Camada 1 (trilho) | Código (§4) | Cliente (§5) | Camada 3 (lead) |
|---|---|---|---|---|
| B1 fechar por fora | ✅ concluir exige sistema | ✅ não fecha sem cliente | ✅ garantia cobra registro | ✅ down-rank |
| B2 trocar origem | parcial | — | match por telefone (SEC-001) | ✅ |
| B3 subfaturar | — | ✅ valor no código | ✅ confirma valor | ✅ |
| B4 negar conversão | — | ✅ delivered exige código | ✅ cliente confirma | ✅ |
| B5 vazamento no tempo | — | — | ✅ recompra pelo bot/recompensa | ✅ priorizar quem retém no canal |

---

## 7. Escopo técnico (pontos de inserção)

- **Migration nova:** coluna(s) de código no `commerce.partner_orders` (ex: `delivery_code`,
  `delivery_code_attempts`, `code_confirmed_at`) — ou tabela `commerce.delivery_codes` 1:1.
  Novo `event_type` em `audit.events` pro "sem código". **Sem DROP**; aditivo.
- **`src/parceiro/queries.ts:772` (`updatePartnerDeliveryStatus`):**
  - transição `→ dispatched`: gerar código + disparar envio ao cliente.
  - transição `→ delivered`: **gate** do código antes de `queries.ts:841`. Novo input
    `delivery_code` + caminho `finalize_without_code` (motivo obrigatório, auditado).
- **`src/parceiro/route.ts`:** receber `delivery_code` no PATCH de status; rate-limit; erros
  `delivery_code_required|invalid`.
- **Bot / canal (atendente-v2 ou worker de notificação):** enviar a mensagem do código ao
  cliente via WhatsApp (telefone já está em `core.contacts` / `commerce.partner_customers`).
- **Front Portal Parceiro:** campo "código de entrega" no botão Finalizar; botão "reenviar
  código"; botão "finalizar sem código (com motivo)".
- **Ranking de honestidade (Camada 3):** view/score que penaliza `finalize_without_code`,
  divergência de valor e gap cotação→pedido. Alimenta o roteamento do bot (futuro multi-loja).

> **Contrato V2:** nada disso toca `agent/analytics/core/raw` de forma destrutiva. A leitura de
> `core.contacts` (telefone) é read-only. A escrita é só no domínio do parceiro
> (`commerce.partner_orders`, `finance.partner_receivables` já é escrito hoje) + `audit.events`.

---

## 8. Sequência sugerida (incrementos)

0. **FUNDAÇÃO (§3.5) — roteamento bot→unidade + materializar em `partner_orders`.**
   **Pré-requisito de tudo.** Sem isso o pedido do bot não vira entrega do parceiro e o código
   (passo 1) não tem onde se prender. Inclui: resolver `unit_id` no `criar_pedido`, gravar
   `partner_orders` com `source_tag='chatwoot_com_bot'` + reserva de estoque, e garantir que a
   cobrança 2w da matriz leia esse `source_tag`.
1. **Código de entrega (COD)** — trilho já existe (0068/0069). Migration aditiva + gate em
   `updatePartnerDeliveryStatus` + envio pelo bot + campo no front.
2. **Código de retirada (balcão)** — mesmo mecanismo, gatilho na criação.
3. **Confirmação de valor + garantia** no follow-up do bot.
4. **Ranking de honestidade** → alimenta roteamento (depende do multi-loja do bot).

---

## 9. Decisões em aberto

1. **Tamanho/formato do código:** 4 ou 6 dígitos? Numérico (fácil de ditar) — recomendado 4.
2. **Onde guardar:** coluna em `partner_orders` vs tabela `delivery_codes`. (Tabela = histórico
   de tentativas/reenvio mais limpo.)
3. **Canal de envio:** mesmo número do bot ou número transacional separado?
4. **Catálogo central vs por loja** (decisão paralela, afeta atribuição de produto) — ver
   handoff da matriz §8b.
5. **Match por telefone p/ reatribuir walk-in (B2)** depende de resolver o **SEC-001**
   (identidade por número) com cuidado — ver `seguranca_backlog`.
