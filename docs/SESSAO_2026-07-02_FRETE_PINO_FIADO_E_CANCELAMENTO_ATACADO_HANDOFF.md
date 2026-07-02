# SESSÃO 2026-07-02 — Frete pelo pino (bot) + Financeiro do atacado: fiado (0115) e cancelamento (0116)

> Sessão da madrugada 07-01→07-02. Três obras: (1) conserto do furo da conversa #696 no bot
> (frete de entrega pelo pino), (2) fatia 1 do FINANCEIRO DO ATACADO (fiado a receber/a pagar),
> (3) CANCELAR venda de atacado. As duas primeiras PUSHADAS; a terceira PRONTA E PROVADA,
> aguardando ordem de push do dono. Migrations 0115 e 0116 JÁ APLICADAS no banco.

---

## 1. Bot: frete de ENTREGA pelo pino (furo #696) — PUSHADO `06871bd`, dormente

**O furo (visto ao vivo, conversa #696 de 07-01):** cliente mandou o pino; o bot usou o pino
pra medir a RETIRADA ("21 km, 26 min"), mas quando o cliente escolheu ENTREGA travou pedindo
"rua, número e bairro" só pra COTAR o frete — e repetiu a exigência quando o cliente reclamou
"já te passei minha localização". Loop que derruba venda.

**Raiz MECÂNICA (não era prompt):** `calcularFrete` (commerce-tools.ts) é chaveado no BAIRRO
(`commerce.resolve_neighborhood`); `localizacao_loja` e `criar_pedido` já eram pino-nativos
(`fillCityFromPin` + `decideStoreGeoOrFallback`). Assimetria: retirada saía do pino, entrega não.
O schema da tool ainda tinha `required:['bairro']`, contradizendo o pinNudge ("chame sem bairro").

**Fix (por CÓDIGO, flag `DELIVERY_FREIGHT_FROM_PIN`, default OFF):**
- `env.ts`: flag nova (dormente).
- `tools.ts`: com a flag on, bairro vira OPCIONAL no schema (`activeToolDefinitions` →
  `calcularFretePinDef`, variante memoizada) e o handler cota pelo pino quando falta bairro
  (`quoteFreteFromPin` → MESMA fonte do criar_pedido; invariante §5.7 cotação==cobrança).
  Parceiro → R$9,90 fixo; matriz → tabela por km; só-longe preservado. Sem pino →
  `precisa_localizacao` (não chama calcularFrete com bairro vazio = sem ZodError).
  Rede de segurança: bairro digitado que NÃO resolve + pino existe → cota pelo pino.
- `delivery-nudge.ts` (novo) + `agent.ts`: nudge determinístico (flag on + pino + cliente
  escolheu entrega) — cotar pelo pino AGORA; rua/número só no FECHAMENTO (detalhe do
  entregador), nunca como muro. Detector `customerChoseDelivery` conservador (palavra de
  retirada presente → não dispara).

**Provas:** `scripts/prova-frete-pino-test.ts` 5/5 (Google-free: cache do reverse-geocode
semeado + chave FAKE + haversine) · prova-geo 9/9 (não-regressão flag off) · vitest 512
(inclui `tests/unit/atendente/delivery-nudge.test.ts` 7/7) · typecheck.

**FALTA:** ~~Deploy~~ (FEITO 07-02) → ligar `DELIVERY_FREIGHT_FROM_PIN=true` no Coolify (exige
ROUTING_GEO+chave Google, já on) → validar ao vivo repetindo o roteiro do #696 (pino →
escolher entrega → tem que cotar na hora, sem exigir endereço antes).

---

## 2. Varredura da matriz: "dá pra fazer o financeiro?" (pergunta do dono)

**Veredito dado:** consolidado das 3 pernas AINDA NÃO; financeiro do ATACADO SIM (perna sólida).

Os 3 buracos que impedem o consolidado hoje:
1. **3 pernas = 3 ilhas.** Faturamento da matriz sai de VIEW de analytics (`v_daily_metrics`,
   relatório do funil do bot, não livro-caixa); atacado sai de `wholesale_orders`; comissão é
   `commission_percent` calculado na tela — nunca vira lançamento.
2. **Varejo da matriz NÃO congela custo na venda** (atacado congela — `unit_cost` snapshot +
   `line_profit` gerado). Lucro do varejo é invisível.
3. **Comissão não é conta a receber** (nem tabela de lançamento tem).

Descobertas da varredura:
- Schema `finance.*` (partner_payables/receivables/installments/expenses) EXISTE e está VAZIO
  em prod — mas tem **grant+RLS pro `farejador_partner_app`** → é território do PARCEIRO.
  **Regra de ouro do atacado: o dinheiro do galpão NÃO pode morar lá.**
- `commerce.wholesale_*`: ZERO grant pro parceiro (conferido em `role_table_grants`).
- 0114 já tinha deixado a porta do fiado aberta: `wholesale_purchases.payment_status`
  CHECK `('paid','pending')` — vocabulário `pending` = fiado (decisão do dono 06-30, honrada).
- Prod: 1 venda de atacado, 2 compras (construído mas quase não operado). zz-teste-* vivas
  sujam números da rede.

---

## 3. Financeiro do atacado — fatia 1: FIADO (0115) — PUSHADO `9044b2a`; flag JÁ LIGADA

**Arquitetura:** copia o DESENHO do finance.partner_* (status/vencimento/quitação) mas mora em
`commerce.wholesale_*` (regra de ouro). SEM tocar nas tabelas do parceiro.

- **Migration `0115_wholesale_finance_fiado.sql` — APLICADA** (via `scripts/aplicar-0115.cjs`,
  untracked; banco é ÚNICO, env é coluna): `wholesale_orders` + payment_status paid|pending +
  payment_method + due_date + paid_at; `wholesale_purchases` + due_date + paid_at; índices
  parciais nos pending; validação interna (antigas todas paid + parceiro sem acesso).
- **Flag `WHOLESALE_FINANCE`** (default OFF): off = tudo nasce 'paid' byte a byte, endpoint
  devolve `enabled:false`, UI some inteira. **O dono JÁ LIGOU =true no Coolify** (antes do
  Deploy — ordem ok, só vale quando o código subir).
- **Backend (queries.ts):** venda/compra aceitam `payment_status`/`due_date` (honrados SÓ com
  flag on); `getWholesaleFinance` (a_receber/a_pagar/vencidos + listas, vencido = pending com
  due_date < hoje); `settleWholesaleOrderPayment`/`settleWholesalePurchasePayment` (quitar →
  paid + paid_at; 2x → *_not_found, não sobrescreve).
- **Rotas:** GET `/admin/api/wholesale/finance` · POST `/admin/api/wholesale/finance/settle`
  `{kind:'sale'|'purchase', id}`.
- **UI (painel matriz, aba Vendas→Atacado):** bloco "Financeiro do galpão" (cards A receber /
  A pagar + vencidos em vermelho + listas com botão Recebi/Paguei); seletor "à vista × fiado
  (+vencimento opcional)" nos forms de VENDA e de COMPRA. `?v=` bumpado.

**Provas:** `scripts/prova-financeiro-atacado-test.ts` **14/14** · não-regressão: baixa 12/12,
fornecedores 10/10, vitest 512/512 · quitação validada NA TELA (preview 4211: R$530→R$180).

**FALTA:** ~~Deploy → conferir `?v=`~~ (FEITOS 07-02 — prod respondeu `?v=20260702-fiado`, fiado
VIVO) → validar ao vivo com uma venda fiada pequena (registrar fiado → aparece no bloco →
Recebi → some).

---

## 4. CANCELAR venda de atacado (0116) — PRONTO E PROVADO, **NÃO PUSHADO** (aguarda ordem)

**Motivação (avaliação "terminamos vendas?"):** o balcão não tinha como desfazer registro
errado (varejo tem `cancel_manual_order`; atacado nada). Com o fiado o buraco piorou: venda
fiada errada = "a receber" fantasma imortal.

- **Migration `0116_wholesale_cancel_trail.sql` — APLICADA** (via `scripts/aplicar-0116.cjs`,
  untracked): cancelled_at/cancelled_by/cancel_reason em wholesale_orders. O status
  'cancelled' JÁ existia no CHECK da 0110 ("cancela sem apagar") — faltava a trilha.
- **O que corrige SOZINHO** (tudo já filtrava `status='confirmed'`): ranking de recompra
  (view `wholesale_buyer_summary`), resumo faturamento/custo/lucro (`getWholesaleResumo`) e o
  fiado a receber (`getWholesaleFinance`).
- **Backend:** `cancelWholesaleSale` transacional (FOR UPDATE → confirmed→cancelled + trilha +
  DEVOLVE estoque via `applyWholesaleStockReturn` em wholesale-stock.ts — espelho exato da
  baixa, mesma flag `WHOLESALE_STOCK_DECREMENT`); `listWholesaleSales` (últimas 15, vivas E
  canceladas — trilha visível). Rotas: GET `/admin/api/wholesale/sales` · POST
  `/admin/api/wholesale/sales/cancel` (404 sale_not_found / 409 sale_already_cancelled).
- **SEM flag nova** (decisão): mudança aditiva (botão explícito, endpoint novo); a devolução
  usa o MESMO interruptor que baixou. Precedente: fornecedores (0114) subiu sem flag.
- **UI:** tabela "Últimas vendas" na aba Atacado (Data · Borracheiro · Total · badge
  fiado/pago · Cancelar). Cancelada = linha esmaecida + badge, sem botão. Confirm forte;
  venda PAGA avisa "se o dinheiro já entrou, o acerto é por fora". Motivo via prompt
  (opcional). `?v=20260702-cancelar`.
- **⚠️ Assimetria honesta do clamp (documentada no código):** venda oversell-confirmada baixou
  MENOS que o vendido (clamp em 0) → cancelar devolve o TOTAL vendido e pode inflar o galpão.
  Raro; correção de verdade = livro-razão (Camada 2, adiada de propósito).

**Provas:** `scripts/prova-cancelar-atacado-test.ts` **13/13** (trilha · devolução 26→30 ·
fiado some do a receber · resumo volta ao base · 2x barra · id inexistente barra · ranking
ignora · venda PAGA também cancela · listagem mostra canceladas) · regressão completa: fiado
14/14, baixa 12/12, fornecedores 10/10, vitest 512/512, typecheck · validado NA TELA
(preview: badge "cancelada" + a receber 275→0).

---

## 5. Como reprovar tudo (comandos)

```bash
npm run typecheck && npx vitest run                    # 512 unit
npx tsx --env-file=.env.pooler scripts/prova-frete-pino-test.ts          # 5/5
npx tsx --env-file=.env.pooler scripts/prova-geo-rede-test.ts            # 9/9 (não-regressão)
npx tsx --env-file=.env.pooler scripts/prova-financeiro-atacado-test.ts  # 14/14
npx tsx --env-file=.env.pooler scripts/prova-cancelar-atacado-test.ts    # 13/13
WHOLESALE_STOCK_DECREMENT=true npx tsx --env-file=.env.pooler scripts/prova-venda-atacado-baixa-test.ts  # 12/12
npx tsx --env-file=.env.pooler scripts/prova-fornecedores-test.ts        # 10/10
```
Preview do painel com fiado ligado: launch config **`matriz-fiado-4211`** (porta 4211,
`.env.pooler` = test + `WHOLESALE_FINANCE=true`). Ler última conversa de prod:
`node --env-file=.env.preview.pooler scripts/ver-ultima-conversa-wpp.cjs` (local, untracked).

## 6. Estado do git / o que falta (ordem)

| Obra | Commit | Deploy | Flag | Validar ao vivo |
|---|---|---|---|---|
| Frete pelo pino | `06871bd` PUSHADO | **FEITO 07-02** (conferido `?v=`) | `DELIVERY_FREIGHT_FROM_PIN` OFF (ligar depois) | pendente |
| Fiado atacado (0115) | `9044b2a` PUSHADO | **FEITO 07-02** (conferido `?v=20260702-fiado` de fora) | `WHOLESALE_FINANCE` **JÁ LIGADA** → **fiado VIVO em prod** | pendente |
| Cancelamento (0116) | **NÃO COMMITADO** (working tree) | — | sem flag (aditivo) | provado em preview |

1. Dono manda push → commit do cancelamento (queries/route/wholesale-stock/app.js/index.html/
   0116/prova) + este handoff + CLAUDE.md atualizado.
2. NOVO Deploy no Coolify (só pro cancelamento — fiado e frete-pino já subiram no Deploy de 07-02).
3. Conferir de fora: `?v=20260702-cancelar` no painel.
4. Validar: venda fiada pequena → Recebi (JÁ DÁ — fiado tá no ar); registro errado → Cancelar
   (após o Deploy do passo 2); roteiro #696 do bot (só depois de ligar a flag do frete).

## 7. Roadmap de Vendas (avaliação "terminamos?" — resposta: quase)

Próximos (ordem de dor): **(a)** custo congelado no VAREJO da matriz → lucro real do varejo
(fatia 2 do financeiro); **(b)** ligar+validar `WHOLESALE_MATRIZ_OVERSELL_GUARD` (dormente);
**(c)** validar ENTREGA pela matriz ao vivo (frete 9,90/13/19); **(d)** resumo do atacado com
recorte por período (hoje é all-time). Adiados DE PROPÓSITO: PEPS por fornecedor; Camada 2
(reserva + livro-razão da matriz). Consolidado das 3 pernas: só depois de (a) + comissão
virar lançamento.

— Orquestrador (Claude Fable 5) — domínios `bot` + `matriz` + `banco`, 2026-07-02
