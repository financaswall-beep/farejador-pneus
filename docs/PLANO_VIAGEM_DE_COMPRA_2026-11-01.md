# Plano — Viagem de compra (etiqueta que junta compras e gastos)

> Decisão do dono (Wallace, 2026-11-01). Substitui a proposta anterior de "compras agrupadas"
> com resumo financeiro próprio (pago/pendente/saldo) — essa versão foi DESCARTADA por ser
> grande demais. Escrito pelo Orquestrador (Claude) depois de ler o código atual de Compras,
> OC, lotes, conferência, despesas e livro central. Quem implementar: seguir este texto.

## 1. O que o dono quer

Ele vai a São Paulo, compra pneus de vários fornecedores e gasta com combustível, comida,
hotel, pedágio. Quer marcar tudo isso como "Viagem SP — nov/26" e responder UMA pergunta:
**quanto custou cada pneu dessa viagem, contando os gastos? Compensou ir?**

## 2. Princípio: a viagem é uma LENTE, não lança nada

- A viagem **não guarda valor nenhum**. Só aponta pra compras e despesas que já existem
  e soma na hora de mostrar.
- Cada coisa continua morando onde mora hoje:
  - compra → Compras (OC, itens/lote, conferência, parcelas, cancelamento) — intocado;
  - pagamento da compra → Financeiro / livro central — intocado;
  - gasto → Financeiro → Despesas (modalidade, comprovante, pago/a pagar) — intocado;
  - estoque, custo médio, lucro do mês, caixa → intocados.
- **Vincular ou desvincular NÃO altera** `commerce.wholesale_purchases`, `commerce.matriz_expenses`,
  itens, lotes, estoque, `finance.matriz_ledger_*`. Nenhum lançamento novo no livro. Nenhuma
  obrigação nova. Nenhuma mudança de custo.
- Apagar uma viagem não pode mudar nenhum número de nenhuma outra tela.

## 3. Modelo de dados (uma migration — próximo número livre, hoje 0273; conferir)

Nomes: na tela é **"Viagem de compra"**, código **VC-0001**. No banco, NÃO usar `trip`
(já é a rota de entrega da Logística: `commerce.matriz_delivery_trips`) nem "lote" (já é
`commerce.tire_lots`). Usar `purchase_group`.

```
commerce.wholesale_purchase_groups
  id uuid pk, environment env_t not null,
  group_number bigint generated always as identity,
  name text not null (2..120),
  status text not null default 'open' check in ('open','closed'),
  notes text null,
  created_by text not null, created_at timestamptz default now(),
  closed_at timestamptz null, closed_by text null,
  unique (environment,id), unique (environment,group_number),
  check ((status='open' and closed_at is null) or (status='closed' and closed_at is not null))

commerce.wholesale_purchase_group_purchases      -- vínculo compra → viagem
  environment env_t, group_id uuid, purchase_id uuid,
  linked_by text not null, linked_at timestamptz default now(),
  primary key (environment, purchase_id),        -- uma compra = no máximo UMA viagem
  fk (environment,group_id)    → wholesale_purchase_groups(environment,id)
  fk (environment,purchase_id) → wholesale_purchases(environment,id)

commerce.wholesale_purchase_group_expenses       -- vínculo despesa → viagem
  environment env_t, group_id uuid, expense_id uuid,
  linked_by text not null, linked_at timestamptz default now(),
  primary key (environment, expense_id),         -- uma despesa = no máximo UMA viagem
  fk (environment,group_id)   → wholesale_purchase_groups(environment,id)
  fk (environment,expense_id) → matriz_expenses(environment,id)
```

- Vínculo em **tabela separada** de propósito: `matriz_expenses` tem gatilhos de proteção
  (datas de negócio 0186, folha 0133, comprovante perdido aprovado 0260). Tabela à parte
  garante "vincular não altera o registro" e não briga com eles.
- FK composta com `environment` em tudo (isolamento prod/test de graça). Confirmar que
  `matriz_expenses` tem `UNIQUE (environment,id)` (a 0140 já referencia assim).
- `ops.enforce_environment_immutable` nas três tabelas (padrão 0208).
- RLS ligada + `REVOKE ALL` de `PUBLIC`, `anon`, `authenticated`, `partner_app`,
  `farejador_partner_app` (padrão 0230). Bloco `DO $smoke$` que aborta a migration se o
  parceiro enxergar qualquer uma das três tabelas.
- Desvincular = `DELETE` da linha de vínculo + evento de auditoria (abaixo). O registro
  original nunca é tocado.

## 4. Regras de vínculo (servidor valida; banco trava o que der)

1. Compra cancelada não pode ser vinculada. Se for cancelada DEPOIS de vinculada, o vínculo
   fica, a linha aparece riscada e sai das somas.
2. **OC não se divide entre viagens.** Se a compra tem `purchase_order_id` e outra compra da
   mesma OC já está em OUTRA viagem → recusar (`purchase_order_split_across_groups`).
3. Despesa removida (`deleted_at` não nulo) não pode ser vinculada. Se for removida depois,
   aparece riscada e sai das somas.
4. **Despesa que já tem dono em outro módulo NÃO pode entrar na viagem** (senão o mesmo
   gasto "paga" duas coisas). No mínimo, bloquear quando a despesa aparece em:
   - `commerce.matriz_delivery_trips.fuel_expense_id` (fechamento de rota);
   - `commerce.matriz_trip_receipts.ai_expense_id` (comprovante de rota);
   - `commerce.matriz_trip_lost_receipts.expense_id` (combustível sem comprovante aprovado);
   - `finance.matriz_payroll_items.source_expense_id` (folha).
   Procurar no código outros módulos que "possuem" despesas (ex.: comissão de operação em
   `src/admin/caixa/`) e bloquear também. Erro: `expense_owned_by_other_module`.
5. Viagem **fechada** não aceita vincular nem desvincular. O dono pode reabrir.
6. Viagem só pode ser **excluída se estiver vazia**.
7. Toda ação (criar, renomear, fechar, reabrir, excluir, vincular, desvincular) grava evento
   via `recordIntegrityEvent` (padrão de `queries-purchase-orders.ts`) e usa
   `beginIntegrityOperation` / `completeIntegrityOperation` com idempotency key.

## 5. Onde a etiqueta é posta

- **Nova compra** e **Comprar lote**: campo opcional "Viagem de compra" (lista só as
  abertas + "➕ Nova viagem…" inline). O vínculo é gravado NA MESMA transação do cadastro.
  ⚠️ O `group_id` **entra no fingerprint** de `registerWholesalePurchase` — senão um reenvio
  com viagem diferente devolve a compra antiga calado. `queries-fornecedores-registro.ts` tem
  só ~22 linhas de folga no teto congelado: a lógica vai num helper do módulo novo, o
  registro só chama.
- **Detalhe da compra**: mostra a viagem; se não tiver, select "Vincular a uma viagem".
- **Financeiro → Despesas → lançar despesa**: campo opcional "Viagem de compra" (mesmo
  comportamento). Se o cadastro de despesa tiver idempotência/fingerprint, o grupo entra nela.
- **Tela da viagem → "+ gasto"**: abre o MESMO formulário de despesa do Financeiro, já com a
  viagem marcada. Não criar formulário novo de despesa.
- **Tela da viagem → "Puxar despesa já lançada"**: lista despesas recentes não removidas,
  sem viagem e sem dono (regra 4), pra vincular.

## 6. Onde a viagem aparece

- **Compras → Visão geral**: bloco "Viagens de compra" (abertas primeiro: código, nome,
  total, custo por pneu).
- **Compras → tela da viagem** com três partes:
  1. **Compras da viagem** — fornecedor, OC, valor, pneus, status que já existe
     (Recebida / Em trânsito / Cancelada; Pago / A pagar). Clicar abre o detalhe atual.
  2. **Gastos da viagem** — modalidade, descrição, data, valor, status da própria despesa.
     Clicar abre a despesa no Financeiro.
  3. **Resumo** (seção 7).
- **Financeiro → Despesas**: chip "VC-0001 · Viagem SP" na linha + filtro por viagem.

## 7. Os números da tela da viagem (fonte ÚNICA = as mesmas telas que já existem)

A viagem tem que mostrar EXATAMENTE os números que Compras e Despesas já mostram, pra
nunca discordar delas:

- **Compras** = Σ `wholesale_purchases.total_amount` com `status<>'cancelled'`
  (mesma coluna da lista de Compras; já é o valor líquido depois da conferência, com frete
  do fornecedor e desconto dentro).
- **Frete dentro das compras** = Σ `freight_amount` das mesmas compras — só informativo,
  escrito "já incluído nas compras". **Nunca somar de novo.**
- **Gastos** = Σ `matriz_expenses.amount` com `deleted_at IS NULL`, quebrado por modalidade
  (rótulo de `matriz_expense_categories`).
- **Total da viagem** = Compras + Gastos.
- **Pneus** = Σ `COALESCE(accepted_quantity, quantity)` de `commerce.wholesale_purchase_lines`
  das compras não canceladas (mesma conta do `items_count` em `listWholesalePurchases`).
  Mostrar separado: recebidos (`stock_applied`) e a caminho.
- **Custo por pneu com os gastos da viagem** = Total ÷ Pneus, em centavos.
  Se houver compra a caminho: "provisório — falta conferir N compra(s)".
  Pneus = 0 → "—".

NÃO entra nesta versão: pago/pendente/saldo consolidado da viagem. (Se um dia entrar, ler
pelo saldo das contas como `matriz-ledger-open-items.ts` — NÃO usar
`matriz_ledger_obligation_breakdown`, que trata despesa paga na hora (`expense_cash`) como
100% em aberto.)

## 8. Texto explicativo obrigatório na tela

- Ao lado do custo por pneu: **"Inclui gastos da viagem. O custo do pneu no estoque continua
  sendo só a compra (pneu + frete do fornecedor)."**
- Regra do frete, perto do "+ gasto": **"Frete cobrado pelo fornecedor vai na compra dele.
  Caminhão ou transportadora que trouxe a carga vai aqui como gasto (modalidade Frete pago)."**
- Alerta (não bloqueia): se a viagem tem compra com `freight_amount > 0` E gasto na
  modalidade `frete` → "Tem frete nas compras e frete nos gastos — confere se não é o mesmo."

## 9. Fora do escopo (não fazer)

- Ratear gastos no custo do estoque / no `allocated_cost`. Obra própria futura; quando vier,
  o ponto certo é NA CONFERÊNCIA (antes de o pneu entrar no estoque e ser vendido).
- Mexer em OC, conferência, parcelas, cancelamento, lucro do mês, caixa, livro.
- Pago/pendente consolidado da viagem.
- Lançar gasto pelo celular / IA de comprovante dentro da viagem.
- Flag: não precisa (aditivo, só leitura + vínculo). Se preferir, `PURCHASE_GROUPS` default off.

## 10. Regras da casa (CLAUDE.md §3)

- Migration aplicada (test e prod) ANTES do push.
- Teto 300 linhas: módulos novos (ex.: `src/admin/painel/queries-purchase-groups.ts`,
  `route-purchase-groups.ts`, `painel/public/app.compras.viagens.js`). Não engordar os
  congelados (`queries-fornecedores-registro.ts`, `app.compras.acoes.js` só tem ~4 linhas
  de folga, `app.compras.js`). `npm run checar-tamanho` verde.
- Módulo novo do painel na lista fixa de `src/admin/painel/route-static.ts` (404 no módulo
  derruba o Alpine inteiro). Montagem via `getOwnPropertyDescriptors`, nunca spread.
- Bump do `?v=` no `painel/public/index.html`.
- Rotas novas com a MESMA autorização das rotas de Compras/Despesas; escrita só dono
  (padrão atual de Compras). Valores de pagamento respeitam `can_view_payments`.
- Regravar DE PROPÓSITO no mesmo commit: `node scripts/prova-paridade-matriz.cjs --gravar-baseline`
  e o baseline de rotas.

## 11. Provas obrigatórias (`scripts/prova-viagem-compra-test.ts`, env test, BEGIN/ROLLBACK,
`npx tsx --env-file=.env.pooler ...`) — rodar 2×, verde nas duas

1. Criar viagem → VC-#### único por ambiente.
2. Compra nova com viagem → vinculada na mesma transação; sem viagem → igual a hoje
   (compra avulsa intacta).
3. **Vincular e desvincular não muda NADA**: contagem e soma de `finance.matriz_ledger_*`,
   `wholesale_stock`, `wholesale_stock_movements`, `tire_lots`, e as linhas de
   `wholesale_purchases`/`matriz_expenses` idênticas antes e depois.
4. Mesma compra em 2 viagens → recusa. Mesma despesa em 2 viagens → recusa.
5. OC com 2 compras → não divide entre viagens.
6. Despesa de rota (fuel_expense_id / ai_expense_id / lost_receipt) e de folha → recusa.
7. Despesa paga na hora e a pagar → ambas somam em Gastos (sem olhar pagamento).
8. Conferência aceitando menos pneus → Compras e Pneus da viagem acompanham
   (= números da lista de Compras).
9. Compra de lote → entra com o valor e a quantidade do lote.
10. Compra cancelada / despesa removida → saem das somas, vínculo continua visível.
11. Frete: compra com frete 800 → Total não soma 800 de novo; alerta aparece quando há
    gasto "frete" na mesma viagem.
12. Isolamento: viagem de test não enxerga/vincula compra ou despesa de prod (FK recusa).
13. Viagem fechada recusa vínculo; excluir viagem com vínculo → recusa.
14. Reenvio do cadastro de compra com a mesma idempotency key e viagem DIFERENTE → conflito,
    não replay silencioso.
15. Parceiro sem grant nas três tabelas.

Mais: `npm run typecheck`, `npm test`, `npm run checar-tamanho`, paridade, rotas, e
**preview pelo clique** (criar viagem → compra com viagem → gasto pelo "+ gasto" → puxar
despesa existente → conferir os números da viagem contra a lista de Compras e Despesas).

## 12. Entrega

Não fazer push sem a revisão do Orquestrador (Claude). Mandar: commit(s), saída das provas,
e print/descrição do preview.
