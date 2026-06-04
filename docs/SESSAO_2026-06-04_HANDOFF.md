# Handoff — Sessão 2026-06-04 (Painel/Rede + SEC-001 + Onboarding Etapas 1 e 2)

**Pra quem continuar (outra LLM/sessão).** Auto-contido. Substitui o handoff de 2026-06-03
(que dizia "nada deployado" — hoje está tudo no ar).

- **Repo:** `C:\Farejador agente` · **Branch:** `feat/fundacao-bot-partner-orders` (= `main`)
- **Remote de deploy:** `pneus` (github.com/financaswall-beep/farejador-pneus). Coolify faz deploy do `main`.
- **HEAD final:** `94da672` · **Tudo DEPLOYADO em prod.**
- **Supabase prod ("Farejador"):** `aoqtgwzeyznycuakrdhp` (us-west-2).

---

## 0. TL;DR
Dia grande. Consertados 3 problemas (feed da Rede, tela Pedidos, vazamento SEC-001), todos no ar.
Construídas e deployadas as **Etapas 1 e 2 do onboarding da Rede**: cobertura saiu do código pra
uma tabela, o bot roteia data-driven (multi-parceiro), e há uma tela "Novo parceiro" que cria
parceiro + login + cobertura. **Validado AO VIVO:** o dono criou o parceiro "Anderson Tavares"
(Niterói) pela tela e o bot, numa conversa real no WhatsApp, roteou um pedido de Niterói pra ele.

---

## 1. Entregue e NO AR hoje (em ordem de commit)
1. **Fix feed da Rede** (`getPainelRede` recent_events/top_items): mostra status real do pedido;
   "Venda" só conta na entrega. — `fe79047`.
2. **Fix tela Pedidos** (migration **0082**): `dashboard.pedidos_recentes` ganhou colunas
   `is_partner`/`partner_status`/`delivery_status`/`payment_status` lidas de `partner_orders`;
   `commerce.network_orders_unified` parou de duplicar pedido de parceiro. Front `painel/public/app.js`. — `f103331`.
3. **Fix SEC-001** (`src/atendente-v2/tools.ts`, `consultar_pedido`): busca por número agora exige
   `o.contact_id` = contato da conversa. Fecha vazamento (cliente lia pedido de outro pelo número).
   Verificado em prod. — `1d79735`.
4. **Plano de onboarding aprovado + docs** — `b29713a` (`docs/PLANO_ONBOARDING_REDE_2026-06-04.md`).
5. **Onboarding ETAPA 1 (motor)** — `322d92c` + `9f99de4`:
   - migration **0083**: `network.unit_coverage` (cobertura por tabela) + coluna `role`
     (owner/funcionario, com CHECK) nos `partner_access_tokens`.
   - `resolveUnitForMunicipio` (em `fulfillment.ts`): bot resolve o parceiro pela cobertura na
     tabela — multi-parceiro, substituiu o `PARTNER_COVERAGE` hardcoded.
   - `createPartnerUnit` (TS, transacional, **sem SECURITY DEFINER**) + endpoint admin
     **`POST /admin/api/partners`** (cria unidade+parceiro+login+cobertura; slug auto com sufixo em
     colisão; token em texto só 1x; `already_exists` se slug explícito já existe).
   - Validado: typecheck + `scripts/test-create-partner.ts` (cria no env `test`, valida login/cobertura/role, limpa).
6. **Onboarding ETAPA 2** — `59f55bf` + `94da672`: tela **"Novo parceiro"** no painel da matriz
   (`painel/public`): botão no topo + modal → chama o endpoint, mostra o login 1x com botão copiar.
   (`94da672` = fix: modal não fecha ao clicar fora.)

**Migrations aplicadas hoje em prod:** 0082, 0083.

---

## 2. Limpeza feita
Os 2 pedidos de teste antigos — Wallace `PED-0022` (partner_order `0498caab`) e Rodrigo `PED-0023`
(`4c4d8af7`), unidade Rio do Ouro — foram **cancelados** (dono+espelho via `cancel_partner_local_order`
+ `cancel_manual_order`): estoque restaurado, recebíveis estornados.

---

## 3. Validação AO VIVO (o marco do dia)
- Wallace criou **pela tela "Novo parceiro"**, em prod, o parceiro **"Anderson Tavares"**
  (slug `anderson-tavares`, `unit_id 90dc9048-53c7-47ac-a583-bc330b6664fb`, cobre `niteroi`).
- Inserimos 2 pneus de teste no estoque dele (90/90-18 → produto `803a4169`; 140/70-17 → `fd79ffbf`;
  5 un cada; `updated_by='cadastro-teste-niteroi'`).
- Wallace conversou com o bot no WhatsApp pedindo entrega em **Fonseca/Niterói** → o bot roteou pro
  Anderson e gerou o pedido **`df730693` "Em separação"** (R$ 108,90). **Loop Uber provado end-to-end.**
- Robustez observada: o bot **não** ancorou no endereço antigo do cliente (tinha histórico de Manilha,
  cliente disse Niterói → corrigiu) e **não** forçou item que só existe na matriz ("150") no parceiro.

---

## 4. PENDÊNCIAS / DECISÕES DO DONO
- **Limpar dado de teste em prod (quando quiser):**
  - pedido `df730693` do Anderson "Em separação" (segura reserva de 1× 90/90-18; cancelar libera);
  - os 2 pneus de teste do Anderson (`updated_by='cadastro-teste-niteroi'`);
  - decidir se **"Anderson Tavares" é parceiro real ou teste**.
- **Conversas de teste (Wallace/Rodrigo) NÃO foram apagadas:** bloqueadas pelo trigger
  `analytics.enforce_fact_evidence_immutability` (`fact_evidence` é append-only). Apagar exige
  **exceção controlada** (desligar trigger → apagar → religar) + **OK explícito do dono**.
  Detalhe técnico: deletar a conversa cascateia facts→evidence; e `commerce.orders.source_conversation_id`
  é NO ACTION (detachar antes com `UPDATE ... source_conversation_id=NULL`).
- **ACHADO 2 (auditoria):** cockpit do dono (`analytics.v_daily_metrics` ← `v_conversation_summary`)
  conta faturamento/"fechou" de pedido de parceiro ANTES da entrega e mesmo cancelado (usa só
  `o.id IS NOT NULL`). Decisão pendente: contar na criação ou só na entrega? Não corrigido.
- **ACHADO 4 (baixo):** `getRedeFunnel` "pediu" conta pedido depois cancelado.
- **TODO sugerido:** teste do "endereço velho" — cliente com histórico de uma cidade que só diz
  "quero entrega" sem repetir; ver se o bot reconfirma a cidade ou chuta a antiga. Se chutar → guard
  "reconfirmar cidade antes de rotear".
- **RECOMENDAÇÃO forte:** testar o bot no ambiente **`test`**, não no prod. Cada conversa gera
  ~50 linhas de analytics IMUTÁVEL no prod (≈21 fatos + evidência + classificações + dicas) — testar
  no `test` evita sujar o prod e a dor de limpeza.

---

## 5. Falta do plano de onboarding (`docs/PLANO_ONBOARDING_REDE_2026-06-04.md`)
- **Etapa 3** — formulário público "quero ser parceiro" + fila de candidaturas na matriz.
- **Etapa 4** — níveis de acesso (dono vê financeiro, funcionário não), usando a coluna `role` já criada.

---

## 6. Próximo passo recomendado (1 frase)
Decidir o destino do dado de teste do Anderson (limpar ou manter como parceiro real) e então escolher
entre **Etapa 3**, **Etapa 4** ou o **Achado 2**.
