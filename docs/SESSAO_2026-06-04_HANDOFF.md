# Handoff — Sessão 2026-06-04 (Rede + SEC-001 + Onboarding Etapas 1–3 + Time de Agentes)

**Pra quem continuar (outra LLM/sessão).** Auto-contido. Substitui versão anterior do mesmo dia.

- **Repo:** `C:\Farejador agente` · **Branch:** `feat/fundacao-bot-partner-orders` (= `main`)
- **Remote de deploy:** `pneus` (github.com/financaswall-beep/farejador-pneus). Coolify faz deploy do `main`.
- **HEAD final:** `60b78f4` · Etapas 1 e 2 DEPLOYADAS; Etapa 3 no `main`, ⚠️ AGUARDANDO REDEPLOY.
- **Supabase prod ("Farejador"):** `aoqtgwzeyznycuakrdhp` (us-west-2).

---

## 0. TL;DR

Dia grande. Consertados 3 problemas (feed da Rede, tela Pedidos, vazamento SEC-001), todos no ar.
Construídas as **Etapas 1, 2 e 3 do onboarding da Rede**: cobertura saiu do código pra uma tabela,
o bot roteia data-driven (multi-parceiro), há uma tela "Novo parceiro" que cria parceiro+login+cobertura,
e há um **formulário público "Seja parceiro"** com fila de candidaturas na matriz.
**Validado AO VIVO:** o dono criou "Anderson Tavares" (Niterói) pela tela e o bot roteou um pedido real.
Etapa 3 aguarda redeploy. Descoberta de perf: a lentidão no desktop era o antivírus (Avast) interceptando CDNs.

---

## 1. Entregue hoje (em ordem de commit)

1. **Fix feed da Rede** (`getPainelRede` recent_events/top_items): mostra status real do pedido;
   "Venda" só conta na entrega. — `fe79047`.
2. **Fix tela Pedidos** (migration **0082**): `dashboard.pedidos_recentes` ganhou colunas
   `is_partner`/`partner_status`/`delivery_status`/`payment_status` lidas de `partner_orders`;
   `commerce.network_orders_unified` parou de duplicar pedido de parceiro. — `f103331`.
3. **Fix SEC-001** (`src/atendente-v2/tools.ts`, `consultar_pedido`): busca por número exige
   `o.contact_id` = contato da conversa. Fecha vazamento (cliente lia pedido de outro pelo número).
   Verificado em prod. — `1d79735`.
4. **Plano de onboarding aprovado + docs** — `b29713a` (`docs/PLANO_ONBOARDING_REDE_2026-06-04.md`).
5. **Onboarding ETAPA 1 (motor)** — `322d92c` + `9f99de4` · DEPLOYADA:
   - migration **0083**: `network.unit_coverage` + coluna `role` (owner/funcionario) nos tokens.
   - `resolveUnitForMunicipio`: bot resolve parceiro pela tabela — multi-parceiro, substitui hardcoded.
   - `createPartnerUnit` + endpoint **`POST /admin/api/partners`** (sem SECURITY DEFINER).
6. **Onboarding ETAPA 2** — `59f55bf` + `94da672` · DEPLOYADA:
   tela "Novo parceiro" no painel matriz (modal → endpoint → login exibido 1x com botão copiar).
7. **Perf: pool de conexão do portal parceiro 5→15** (`src/parceiro/db.ts`) — `898064c` · DEPLOYADO:
   portal abre ~12 chamadas em paralelo; antes faziam fila.
8. **Onboarding ETAPA 3** — ⚠️ NO `main`, AGUARDANDO REDEPLOY:
   - migration **0084**: `network.partner_applications` (fila de candidaturas).
   - Página pública `/seja-parceiro` (CSS embutido, sem CDN externo).
   - Endpoint público `POST /api/seja-parceiro` (honeypot anti-spam).
   - Fila na matriz: botão "Candidaturas" + badge; aprovar define cobertura/comissão e cria parceiro; recusar.
   - Backend testado 6/6 (`scripts/test-partner-application.ts`).

**Migrations aplicadas em prod:** 0082, 0083, 0084.

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
- Wallace conversou no WhatsApp pedindo entrega em **Fonseca/Niterói** → bot roteou pro Anderson e
  gerou o pedido **`df730693` "Em separação"** (R$ 108,90). **Loop Uber provado end-to-end.**
- Robustez: bot não ancorou no endereço antigo (histórico Manilha → cliente disse Niterói → corrigiu)
  e não forçou item que só existe na matriz.

---

## 4. Fase atual — Onboarding da Rede

Plano: `docs/PLANO_ONBOARDING_REDE_2026-06-04.md`

| Etapa | Descrição | Status |
|-------|-----------|--------|
| 1 | Motor: cobertura por tabela + role nos tokens + createPartnerUnit + endpoint admin | DEPLOYADA, validada ao vivo |
| 2 | Tela "Novo parceiro" no painel matriz | DEPLOYADA |
| 3 | Formulário público /seja-parceiro + fila de candidaturas na matriz | No `main`, ⚠️ aguarda redeploy |
| 4 | Níveis de acesso dono vs. funcionário (usa coluna `role` da Etapa 1) | PRÓXIMA |

---

## 5. Time de agentes (.claude/agents/)

O projeto usa um time de subagentes especialistas por área, dividido em dois grupos.

### DECISORES — rodam Opus; zona sensível onde errar custa caro

| Agente | Responsabilidade |
|--------|-----------------|
| `banco` | Schema/migrations/integridade do Supabase central (raw/core/analytics/ops/agent/commerce). Proj prod `aoqtgwzeyznycuakrdhp`. |
| `bot` | Atendente/roteamento bot→parceiro→matriz, criar/consultar pedido, SEC-001 (`src/atendente-v2`). |
| `parceiro` | Painel + backend + dados/financeiro do parceiro (`src/parceiro`, `commerce.partner_*`). |
| `matriz` | Rede/cobrança/comissão/funil/antifraude (`src/admin/painel`). |
| `seguranca` | Vazamento de dado/autorização (ex.: SEC-001). |

### EXECUTORES — rodam Sonnet; trabalho mecânico/barato

| Agente | Responsabilidade |
|--------|-----------------|
| `executor` | Mecânico geral. |
| `coletor` | Garimpa dados, roda scripts `.cjs`. |
| `front` | UI/visual. |
| `escriba` | Docs/handoffs (este documento). |

### Regras de trabalho

- **Assinatura:** ao fim de cada resolução, listar quais especialistas fizeram cada etapa + modelo do Claude ao lado. Exemplo: "bot (Opus 4.8)", "coletor (Sonnet 4.6)".
- **Delegação:** coisa boba/mecânica vai pro Sonnet por reflexo. Dúvida ou zona sensível (dinheiro/estoque/lógica central/segurança/arquitetura) fica no Opus.
- **LIMITAÇÃO descoberta 2026-06-04:** os agentes nomeados em `.claude/agents/` NÃO são invocáveis por nome neste ambiente — a tool `Agent` só aceita tipos genéricos (general-purpose etc.). Para delegar ao Sonnet: usar `Agent` com `subagent_type=general-purpose` + `model=sonnet`, embutindo a persona do especialista no prompt. A economia de custo funciona igual; o nome do especialista é o "chapéu" na assinatura.
- **Continuidade:** a memória do projeto (`C:\Users\Casa1\.claude\projects\C--Farejador-agente\memory\`) é o mapa que o Opus carrega a cada sessão. SEMPRE cruzar com o estado real (banco/repo) antes de agir — hoje isso pegou um handoff desatualizado que dizia "nada deployado".

---

## 6. Descoberta de perf/infra

- **Pool parceiro 5→15 (deployado):** portal abria ~12 chamadas em paralelo, faziam fila no pool de 5.
- **Lentidão no DESKTOP = antivírus (Avast):** o Avast intercepta CDNs externos (Tailwind/unpkg/jsdelivr),
  causando 15–50s de "carregando eterno". Servidor e banco estão OK (mobile sempre foi rápido).
  Recomendação: hospedar os assets localmente para blindar contra antivírus dos clientes — **pendente**.

---

## 7. PENDÊNCIAS / DECISÕES DO DONO

- **Redeploy** para a Etapa 3 entrar no ar (`/seja-parceiro` + fila de candidaturas).
- **Limpar dado de teste em prod (quando quiser):**
  - pedido `df730693` "Em separação" (segura reserva de 1× 90/90-18; cancelar libera estoque);
  - os 2 pneus de teste (`updated_by='cadastro-teste-niteroi'`);
  - decidir se **"Anderson Tavares" é parceiro real ou teste**.
- **Conversas de teste (Wallace/Rodrigo) NÃO apagadas:** bloqueadas pelo trigger
  `analytics.enforce_fact_evidence_immutability` (`fact_evidence` é append-only). Apagar exige
  exceção controlada (desligar trigger → apagar → religar) + **OK explícito do dono**.
  Detalhe: deletar conversa cascateia facts→evidence; e `commerce.orders.source_conversation_id`
  é NO ACTION (detachar antes com `UPDATE ... source_conversation_id=NULL`).
- **ACHADO 2 (auditoria):** cockpit do dono conta faturamento de pedido de parceiro ANTES da entrega
  e mesmo cancelado (`analytics.v_daily_metrics` ← `v_conversation_summary` usa só `o.id IS NOT NULL`).
  Decisão pendente: contar na criação ou só na entrega?
- **ACHADO 4 (baixo):** `getRedeFunnel` "pediu" conta pedido depois cancelado.
- **Assets locais:** hospedar Tailwind/unpkg localmente para blindar antivírus dos clientes — recomendado.
- **TODO sugerido:** testar "endereço velho" — cliente com histórico de outra cidade que só diz
  "quero entrega" sem repetir; ver se o bot reconfirma ou chuta a cidade antiga.
- **RECOMENDAÇÃO forte:** testar o bot no ambiente `test`, não no prod. Cada conversa gera
  ~50 linhas de analytics IMUTÁVEL no prod — sujar o prod dói na limpeza.

---

## 8. Próximo passo recomendado (1 frase)

Redeploy + testar `/seja-parceiro` e a fila de candidaturas (Etapa 3), depois decidir entre Etapa 4 (níveis dono/funcionário) e os assets locais (blindagem contra antivírus).

---

*Escriba (Sonnet 4.6) · 2026-06-04*
