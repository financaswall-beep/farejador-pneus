# Plano mestre — Estoque integrado às seções do parceiro

> Status: planejamento. Não implementado.
> Objetivo: deixar o Estoque como fonte confiável para Frente de caixa, Pedidos,
> Entrega, Compras, Financeiro, Clientes, Bate-papo e futuro Atendente.

## 1. Norte do desenho

O Estoque precisa responder três perguntas sem ambiguidade:

1. **Quanto existe fisicamente?**
   `quantity_on_hand`.
2. **Quanto está comprometido, mas ainda na loja ou em rota?**
   `quantity_reserved`.
3. **Quanto pode vender agora?**
   `available = quantity_on_hand - quantity_reserved`.

Depois, numa etapa separada, ele também precisa responder:

4. **Por que o saldo mudou?**
   Ledger de movimentação (`partner_stock_movements`).

Essas responsabilidades não devem ficar espalhadas no front. Cada seção deve usar
contratos claros, com regras no banco e mensagens amigáveis no backend.

## 2. Escopo por fase

### Fase E1 — Reservado para entrega COD

Migration alvo: `0076_partner_stock_reserved.sql`.

Finalidade: corrigir o fluxo de pedido internet/pago na entrega.

Entram nesta fase:

- `quantity_reserved` em `commerce.partner_stock_levels`.
- `available = quantity_on_hand - quantity_reserved`.
- Status novo `reserved`.
- Pedido delivery reserva na criação.
- Entrega `delivered` converte reserva em baixa física.
- Entrega `failed` libera reserva.
- Ajuste manual bloqueado abaixo do reservado.
- Front mostra físico, reservado e disponível.

Não entram nesta fase:

- Ledger completo de movimentações.
- Relatório contábil exato de entradas/saídas.
- Refactor grande de compras, vendas e ajustes para derivar saldo por ledger.

### Fase E2 — Contratos entre seções

Finalidade: fazer cada seção consumir o estoque sem improvisar regra própria.

Entram nesta fase:

- Atualizar `SECOES/ESTOQUE.md`.
- Criar `SECOES/ENTREGA.md`.
- Criar `SECOES/FRENTE_CAIXA.md`.
- Criar `SECOES/COMPRAS.md`.
- Documentar quais campos cada seção pode ler e quais funções/endpoints pode chamar.
- Padronizar mensagens de erro:
  - estoque insuficiente;
  - saldo abaixo do reservado;
  - item reservado não pode ser inativado;
  - entrega já finalizada.

### Fase E3 — Ledger de movimentação

Migration futura: `0077_partner_stock_movements.sql` ou posterior.

Finalidade: parar de calcular "Entradas no mês" e "Saídas no mês" por chute.

Entram nesta fase:

- Nova tabela `commerce.partner_stock_movements`.
- Uma linha para cada movimento:
  - compra;
  - venda balcão;
  - reserva;
  - liberação de reserva;
  - entrega concluída;
  - cancelamento;
  - entrada manual;
  - ajuste por contagem;
  - perda/quebra.
- KPIs de entradas/saídas passam a somar o ledger.
- `audit.events` continua existindo como trilha ampla; o ledger vira fonte operacional
  dos números de estoque.

Não fazer junto com E1 para não misturar duas mudanças críticas.

### Fase E2.5 — Ponte barata para KPIs por `audit.events`

Finalidade: melhorar os KPIs de entradas/saídas antes do ledger completo, se o dono
quiser uma correção intermediária.

Contexto:

- Hoje já existem eventos em `audit.events` para parte das movimentações:
  - `stock_decrement_sale`;
  - `stock_increment_purchase`;
  - `stock_increment_sale_cancel`;
  - após E1, também `stock_reserved` e `stock_reservation_released`.
- Isso permite somar algumas entradas/saídas reais sem criar tabela nova.

Limite:

- `audit.events` é trilha de auditoria, não uma tabela operacional feita para KPI.
- Payloads podem variar por evento.
- Consultas tendem a ficar mais frágeis e menos performáticas que um ledger dedicado.

Uso recomendado:

- Só como ponte temporária.
- Não transformar `audit.events` na fonte definitiva do estoque.
- Se o KPI virar número contábil ou gerencial importante, avançar para E3.

### Fase E4 — Inteligência operacional

Finalidade: usar o estoque integrado para sugestões e decisões.

Entram nesta fase:

- Alertas reais:
  - disponível baixo;
  - reservado parado há muito tempo;
  - item com alta saída;
  - item com perda/ajuste frequente.
- Bate-papo e futuro Atendente podem consultar disponibilidade, mas não mexem direto
  no estoque.
- Reservas feitas por agente, se existirem no futuro, passam por action handler validado.

## 3. Modelo alvo do estoque

Tabela principal:

`commerce.partner_stock_levels`

Campos centrais:

- `quantity_on_hand`: saldo físico.
- `quantity_reserved`: saldo comprometido com entrega em aberto.
- `minimum_quantity`: mínimo operacional.
- `stock_status`: status derivado.
- `is_tracked`: controla ou não saldo.

Status alvo:

- `not_tracked`: serviço ou item sem controle de saldo.
- `unknown`: item rastreado, mas saldo desconhecido.
- `out_of_stock`: físico menor ou igual a zero.
- `reserved`: físico positivo, mas disponível menor ou igual a zero.
- `low_stock`: disponível positivo, mas abaixo ou igual ao mínimo.
- `in_stock`: disponível acima do mínimo.

Regra de proteção:

```sql
quantity_reserved >= 0
AND (quantity_on_hand IS NULL OR quantity_on_hand >= quantity_reserved)
```

## 4. Contratos por seção

### Estoque

Dono de:

- cadastro do item;
- saldo físico;
- saldo reservado;
- status derivado;
- valor físico em estoque.

Pode gravar:

- criação/edição do item;
- entrada manual;
- ajuste manual;
- inativação, desde que não tenha reserva.

Não deve gravar:

- venda;
- pedido;
- conta a receber;
- entrega.

### Frente de caixa

Fluxo: retirada/pickup, cliente leva na hora.

Contrato:

- lê `available`.
- bloqueia venda acima do disponível.
- ao vender, chama `commerce.register_partner_local_order`.
- para `fulfillment_mode='pickup'`, a função baixa `quantity_on_hand`.

Resultado esperado:

- físico cai imediatamente;
- reservado não muda;
- financeiro entra conforme forma de pagamento.

### Pedidos internet

Fluxo: pedido delivery/COD.

Contrato:

- lê `available`.
- bloqueia pedido acima do disponível.
- ao criar, chama `commerce.register_partner_local_order`.
- para `fulfillment_mode='delivery'`, a função aumenta `quantity_reserved`.

Resultado esperado:

- físico não cai;
- reservado sobe;
- disponível cai;
- conta a receber fica aberta.

### Entrega

Fluxos:

- `pending`: separado/reservado.
- `dispatched`: saiu para entrega, ainda reservado.
- `delivered`: venda realizada.
- `failed`: não entregue/devolvido.

Contrato:

- `delivered` chama `commerce.deliver_partner_local_order`.
- `failed` chama `commerce.cancel_partner_local_order`.
- entrega finalizada não pode baixar estoque duas vezes.

Resultado esperado:

- entregue: `on_hand -= qty`, `reserved -= qty`, conta recebida.
- falhou: `reserved -= qty`, `on_hand` intacto, conta cancelada.

### Compras

Fluxo: entrada de mercadoria.

Contrato atual:

- compra aumenta `quantity_on_hand`.
- recalcula status.

Contrato futuro com ledger:

- compra grava movimento `stock_increment_purchase`.
- KPI de entradas lê o ledger, não o cadastro atual.

### Financeiro

Fluxo: caixa, contas a receber/pagar, resultado.

Contrato:

- não decide saldo.
- recebe sinais do fluxo de venda/entrega.
- COD só entra no caixa quando entrega vira `delivered`.
- `failed` cancela a receber.

Separação importante:

- Estoque responde unidades.
- Financeiro responde dinheiro.
- Entrega COD é o ponto de encontro, mas cada lado escreve no seu domínio.

### Clientes

Contrato:

- pode aparecer como contexto de venda/pedido.
- não mexe no estoque.
- ajuda a preencher endereço e histórico.

### Bate-papo e Atendente futuro

Contrato:

- podem consultar disponibilidade.
- não podem escrever direto em `commerce.partner_stock_levels`.
- qualquer ação futura de reserva/carrinho deve passar por action handler validado.

Regra:

- LLM nunca decide coluna/tabela.
- LLM sugere; backend determinístico executa se passar validação.

## 5. Funções SQL alvo da Fase E1

### `commerce.partner_stock_status(...)`

Helper único para evitar status divergente.

Usar em:

- venda;
- reserva;
- entrega concluída;
- cancelamento;
- compra;
- cancelamento de compra;
- ajuste manual via backend.

### `commerce.register_partner_local_order(...)`

Branch por modalidade:

- `pickup`: baixa físico.
- `delivery`: reserva.

Deve checar saldo contra disponível.

### `commerce.deliver_partner_local_order(...)`

Converte reserva em saída física.

Regras:

- só para pedido delivery;
- só para item rastreado;
- não pode rodar duas vezes para o mesmo pedido;
- se reserva insuficiente, falha com erro claro.

### `commerce.cancel_partner_local_order(...)`

Branch por estado:

- delivery pendente/a caminho: libera reserva.
- delivery já entregue ou pickup: restaura físico.

Mantém cancelamento da conta a receber.

## 6. Backend alvo

Arquivo principal:

- `src/parceiro/queries.ts`

Mudanças:

- selects de estoque e produtos incluem `quantity_reserved`.
- helper TS `stockStatus` precisa considerar reservado ou delegar status ao banco.
- `updatePartnerDeliveryStatus` chama `deliver_partner_local_order` em `delivered`.
- `upsertPartnerStock` não altera `quantity_reserved`.
- erros de check viram mensagem amigável.
- `deletePartnerStock` bloqueia item com `quantity_reserved > 0`.

Arquivo de rotas:

- `src/parceiro/route.ts`

Mudanças:

- tratar erro `saldo_below_reserved` como 409 ou 422.
- tratar `stock_reserved_cannot_delete`.
- tratar `delivery_already_finalized`.

## 7. Frontend alvo

Arquivos:

- `parceiro/public/app.js`
- `parceiro/public/index.html`

Helper:

```js
stockAvailable(item) = item.is_tracked
  ? num(item.quantity_on_hand) - num(item.quantity_reserved)
  : Infinity
```

Onde usar disponível:

- card de produto da Frente de caixa;
- criação de pedido internet;
- dropdown/lista de produtos vendáveis;
- bloqueio de adicionar ao carrinho;
- labels de estoque vendável.

Onde manter físico:

- valor em estoque;
- quantidade física no detalhe;
- contagem de unidade física.

UI mínima:

- tabela mostra físico/disponível/reservado.
- detalhe mostra:
  - Físico;
  - Reservado;
  - Disponível;
  - Valor em estoque.
- status `reserved` vira "Reservado".

## 8. Ledger futuro

Tabela sugerida:

`commerce.partner_stock_movements`

Campos:

- `id`
- `environment`
- `unit_id`
- `stock_id`
- `movement_type`
- `quantity_delta`
- `quantity_on_hand_after`
- `quantity_reserved_after`
- `reason`
- `source_table`
- `source_id`
- `actor_label`
- `created_at`

Tipos iniciais:

- `purchase_increment`
- `purchase_cancel_decrement`
- `sale_pickup_decrement`
- `delivery_reserved`
- `delivery_delivered_decrement`
- `delivery_reservation_released`
- `sale_cancel_increment`
- `manual_entry`
- `manual_adjustment`
- `loss_adjustment`

KPIs após ledger:

- Entradas no mês: soma `quantity_delta > 0`.
- Saídas no mês: soma `quantity_delta < 0`.
- Reservas abertas: soma por `movement_type='delivery_reserved'` ainda não liberada/entregue.

## 8.1. Situação atual dos KPIs de entrada/saída

Hoje o sistema sabe bem o saldo atual, mas não tem um "caderninho" próprio de cada
movimento.

Por isso:

- `quantity_on_hand` é a fonte do saldo físico atual.
- "Entradas no mês" é proxy calculado por compras/itens criados.
- "Saídas no mês" é proxy calculado por vendas não canceladas do mês.

Isso pode estar correto com os dados atuais e ainda assim ser frágil para o futuro.

Casos em que o proxy começa a mentir:

- botão "Dar entrada" manual aumenta saldo, mas pode não aparecer em "Entradas";
- venda cancelada some de "Saídas", mesmo tendo havido baixa e estorno;
- ajuste por quebra, perda ou contagem altera saldo, mas não aparece como saída;
- compra e cadastro do mesmo item podem forçar uso de `max()` para evitar duplicidade,
  contando menos do que o movimento real.

Conclusão:

- saldo atual: deve ser confiável;
- KPIs mensais de entrada/saída: servem como ordem de grandeza enquanto não há ledger;
- quando forem usados para fechamento mensal, perda/quebra ou comparação entre lojas,
  precisam sair do proxy e ir para E3.

## 9. Ordem recomendada

1. Implementar E1 (`0076`) sem ledger.
2. Rodar typecheck.
3. Testar os três fluxos:
   - pickup;
   - delivery entregue;
   - delivery falhou.
4. Testar proteção:
   - ajuste abaixo do reservado;
   - venda acima do disponível;
   - inativação com reserva.
5. Atualizar docs de seções.
6. Só depois planejar E3 ledger.

## 10. Critérios de pronto

E1 só está pronto quando:

- pedido delivery criado não reduz físico;
- pedido delivery criado aumenta reservado;
- disponível cai corretamente;
- entrega concluída baixa físico e zera reservado;
- entrega falhada zera reservado e mantém físico;
- pickup continua baixando físico na hora;
- ajuste manual abaixo do reservado falha;
- front mostra físico, reservado e disponível;
- `npm run typecheck` passa;
- roteiro manual em preview prod foi executado e o saldo foi restaurado.

## 11. Decisão de arquitetura

Não fazer ledger junto com reservado.

Motivo:

- reservado corrige um erro operacional atual;
- ledger corrige precisão histórica/contábil;
- misturar os dois aumenta risco em venda, entrega, compra e financeiro ao mesmo tempo.

Sequência segura:

1. primeiro: estoque disponível correto;
2. depois: histórico exato de movimentação.

---

## 12. Adendo de auditoria crítica (Opus, para Codex)

> **Autor:** Claude (Opus 4.8). **Data:** 2026-05-31.
> **Base verificada no código** (não só no plano): `db/migrations/0067` (corpo atual
> de `register_partner_local_order`), `0069` (COD + view), `0074` (CGV na view),
> `0075` (corpo atual de `cancel_partner_local_order`), e `src/parceiro/queries.ts`
> (`updatePartnerDeliveryStatus` l.738, `upsertPartnerStock` l.1085, `stockStatus`
> l.863, `getPartnerEstoque` l.273, `getPartnerProdutos` l.291).
> **Veredito:** plano aprovado com ajustes obrigatórios. A sequência (reservado
> antes do ledger, **pular E2.5**) está certa. Faltavam 3 guards e 1 snapshot.

### 12.1. Confirmação dos problemas (existem mesmo)
- ✔ `register_partner_local_order` (0067, l.142-164) baixa `quantity_on_hand` na
  **criação para todos os modos** — não há branch por `fulfillment_mode`. Delivery/COD
  tira o pneu do físico cedo demais.
- ✔ `updatePartnerDeliveryStatus` no `delivered` (queries.ts:830-839) **só mexe no
  financeiro**, não no estoque. Logo o net hoje é **uma baixa só** (na criação): a
  contagem está certa, **o erro é de tempo/semântica**.
- ✔ **Argumento extra a favor do E1 (o plano não destacou):** a view
  `network.partner_unit_summary` (0069 + 0074) **já exclui** delivery não-`delivered`
  de `sales_month` **e** de `cogs_month`. Hoje o físico cai na criação mas a venda/CGV
  só conta no `delivered` → descasamento. O modelo reservado **alinha** os dois.

### 12.2. 🔴 Perigos obrigatórios (corrigir na 0076 / backend)

**P1 — Dupla baixa na transição.** A 0076 muda `register` (delivery deixa de baixar
físico) **e** `deliver` (passa a baixar). Pedido delivery **aberto no deploy** já
baixou pela lógica velha; ao virar `delivered` depois, baixa de novo.
→ **Gate pré-deploy bloqueante:**
```sql
SELECT count(*) FROM commerce.partner_orders
WHERE fulfillment_mode='delivery'
  AND delivery_status IN ('pending','dispatched')
  AND status <> 'cancelled' AND deleted_at IS NULL;
```
Só aplicar se `= 0`. Se `> 0`: backfill (setar `quantity_reserved` e **não** re-baixar).

**P2 — `delivered → delivered` repetido baixa de novo.** O guard atual (queries.ts:758)
só bloqueia *sair* de delivered. Não bloqueia delivered repetido. Hoje é inofensivo;
com `deliver_partner_local_order` no branch, duplo clique/retry = **dupla baixa física**
(o financeiro está protegido por `WHERE status='open'`, o estoque não).
→ `deliver` só roda na **transição** para delivered: checar `existing.delivery_status
!== 'delivered'` antes de chamar. Idempotência por **estado da ordem**, nunca por reserva.

**P3 — Recálculo de `stock_status` ignorando `reserved` (em VÁRIOS pontos, não só o upsert).**
`upsertPartnerStock` (queries.ts:1146) usa `stockStatus(input)` (helper TS l.863) que só
olha `on_hand`. Editar um item com `reserved>0` regrava `in_stock`, escondendo a reserva.
→ Status passa a ser **dono do banco** (helper SQL `commerce.partner_stock_status`);
o upsert recalcula considerando o `reserved` **atual da linha**. Fonte única de status.

**P3 ampliado (acréscimo do Codex, 2026-05-31):** o mesmo CASE de `stock_status` aparece
inline e SEM `reserved` em mais lugares — **todos** têm que passar pelo helper SQL:
- `registerPartnerPurchase` — branch de UPDATE de item existente (CASE de status ~queries.ts:1316)
  e branch de INSERT de item novo (~queries.ts:1356). Se uma compra entra num item que estava
  `reserved`, o status tem que sair de `reserved`→`in_stock` **só se** disponível voltar a
  superar o mínimo — quem decide é o helper, não o CASE cru.
- **Cancelamento/estorno de compra** (`deletePartnerPurchase`, reversão de saldo ~queries.ts:1456+):
  ao reverter a entrada, se o disponível voltar a ≤0 o item tem que **voltar para `reserved`**
  (não para `out_of_stock`/`in_stock` por engano). Helper SQL aqui também.
- `cancel_partner_local_order` (SQL, migration 0075) já tem o CASE inline — na 0076 trocar
  pelo helper para não divergir.
Regra geral da 0076: **nenhum** UPDATE de saldo/status calcula `stock_status` à mão; todos
chamam `commerce.partner_stock_status(on_hand, reserved, minimum, is_tracked)`.

**P3b — `deletePartnerStock` (queries.ts:1186) inativa sem olhar reserva (acréscimo do Codex).**
Hoje o soft-delete não verifica `quantity_reserved`. O Opus colocou isso só nos testes; tem
que entrar no **backend**: bloquear inativação quando `quantity_reserved > 0` e devolver
mensagem amigável (`stock_reserved_cannot_delete` → 409/422 na route).

### 12.3. Regras que faltavam
1. **Pickup também desconta `reserved` na checagem** (`on_hand - reserved >= qty`),
   senão o balcão vende pneu já reservado. O CHECK barra com rollback, mas converta
   em mensagem amigável ("N unidade(s) reservada(s) para entrega").
2. **`is_tracked=false` / `servico` NUNCA reservam** (senão `deliver`, que só baixa
   rastreado, deixa **reserva órfã** presa).
3. **`on_hand IS NULL` (unknown): não reservar** (alinha com o `register` atual, que já
   não baixa quando `on_hand IS NULL`).
4. **Liberar reserva com guard por estado** (só libera se ainda estava reservada).
   `reserved -= qty` sem guard pode ir negativo → viola `CHECK reserved>=0` → **rollback
   de tudo, inclusive o cancelamento da conta a receber → ordem trava**.
5. **Manter `FOR UPDATE`** (já existe em `register`, queries.ts:133) nas novas `deliver`
   e `cancel` ao mexer em `reserved`/`on_hand` — proteção de corrida em pneu qtd=1.

### 12.4. Telas/funções fora do plano
- **`getPartnerProdutos` (queries.ts:291) também precisa trazer `quantity_reserved`** —
  o plano cita só `getPartnerEstoque`. A Frente de caixa usa `getPartnerProdutos`.
- **Métrica "Saídas no mês" / `soldUnitsMonth` (app.js):** confirmado pelo Codex que hoje
  usa `activeSales` (app.js:507 e :737), que **inclui delivery ainda não entregue**. Com a
  nova semântica do reservado, um delivery que só **reservou** apareceria como "saída"
  (físico não saiu). Tem que contar só `pickup` + delivery `delivered`. **Ajustar.**
- **Guard de UI** contra duplo clique em "Entregue" (reforço além do guard de estado).

### 12.5. Dívidas conhecidas (documentar no E2, não bloqueiam)
- **Cancelar venda delivery JÁ recebida não estorna o caixa:** `cancel` cancela a
  receber só `WHERE status='open'`; após `delivered` ela está `received`. Devolve o
  estoque mas deixa o dinheiro. **Já é assim hoje** (furo pré-existente). Registrar no
  contrato Entrega↔Financeiro para não virar "bug novo".
- **Reserva órfã:** delivery preso em `pending` segura disponível indefinidamente
  (visibilidade = E4).

### 12.6. Testes obrigatórios antes de prod (além dos 3 fluxos)
1. Gate P1 (zero entregas em aberto). **Bloqueante.** ✅ FEITO 2026-05-31 (número canônico,
   reconciliado): `delivery_em_aberto = 0`. Entre os pedidos **delivery não-deletados existem
   só 3, todos com `status='cancelled'`** (`delivery_status`: 2 `delivered`, 1 `dispatched`);
   os demais (11 no total bruto) estão **soft-deleted**. Nenhuma ordem delivery está em estado
   aberto (`pending`/`dispatched` com `status<>'cancelled'`), logo não há re-baixa na transição.
   Reconferir este gate imediatamente antes do deploy.
2. **Snapshot de rollback:** ✅ FEITO 2026-05-31 — corpos atuais de
   `register_partner_local_order` e `cancel_partner_local_order` capturados da prod em
   `docs/SNAPSHOT_FUNCOES_PRE_0076_2026-05-31.sql` (rollback + base fiel para o Codex).
   Confirmado: `register` vivo == 0067, `cancel` vivo == 0075, sem override posterior.
3. `delivered` 2x → baixa **uma vez só** (P2).
4. `delivered` → tentar `failed` → `delivery_already_finalized`.
5. Pickup de item com reserva pendente → bloqueado com mensagem (não erro de CHECK).
6. Delivery com `servico`/`is_tracked=false`, e multi-item (rastreado + não) → não cria
   reserva no não-rastreado; `deliver` não tenta baixá-lo.
7. Ajuste manual abaixo do reservado → bloqueado com mensagem.
8. Editar preço de item com `reserved>0` → `stock_status` continua refletindo a reserva (P3).
9. Inativar item com `reserved>0` → bloqueado.
10. Cancelar delivery em `pending` (botão cancelar venda) → libera reserva, não incrementa `on_hand`.
11. Pós-migration: todas as linhas `reserved=0`, CHECK válido, `stock_status` recalculado.
12. `npm run typecheck` + restaurar saldo no fim do roteiro em preview-prod.

### 12.7. Decisões reafirmadas
- **E1 primeiro:** sim. **Não fazer ledger junto com `quantity_reserved`:** concordo.
- **Pular E2.5:** o E1 muda a semântica de `stock_decrement_sale` (no delivery passa a
  nascer no `delivered`), então KPI sobre `audit.events` seria frágil e descartável no
  E3. Saldo atual já é confiável; KPIs mensais são "ordem de grandeza". Ir
  **E1 → E2 (docs) → E3** direto, salvo necessidade imediata de KPI de entrada/saída.

> — Claude (Opus 4.8), 2026-05-31. Adendo à proposta assinada por Codex.

### 12.8. Revisão cruzada do Codex (2026-05-31)
Codex leu o adendo contra o código e **concordou** com P1/P2/P3 e com pular E2.5.
Acréscimos dele, já incorporados acima:
- **P3 ampliado:** incluir `registerPartnerPurchase` (queries.ts:1321) e
  `deletePartnerPurchase` (queries.ts:1515) no uso do helper SQL — ambos recalculam
  `stock_status` inline sem `reserved`. Item reservado que recebe compra deve sair de
  `reserved` corretamente; estorno de compra que zera disponível deve **voltar** a `reserved`.
- **P3b:** `deletePartnerStock` (queries.ts:1186) deve bloquear `quantity_reserved > 0` no
  **backend** (não só em teste).
- **Saídas no mês:** confirmado `activeSales` em app.js:507 e :737.
- **Inconsistência de números corrigida** (gate P1): número canônico único nos 4 docs.

**Bloqueios mínimos acordados (Opus + Codex) antes de `apply_migration` em prod:**
1. ✅ Inconsistência de números dos docs corrigida.
2. ⬜ Escrever a 0076 a partir do snapshot, com **helper SQL em todos** os updates de
   saldo/status (register, deliver, cancel, compra, estorno de compra, upsert).
3. ⬜ `npm run typecheck` + roteiro manual dos 12 testes (§12.6) em preview/prod controlado.

> — Codex + Claude (Opus 4.8), 2026-05-31.
