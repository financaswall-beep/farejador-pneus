# Handoff - Farejador

**Atualizado: 2026-05-15.**

Este arquivo é o handoff operacional curto. Para contexto completo da próxima
conversa, use também `docs/NEXT_CHAT_HANDOFF.md`.

## Estado Atual (2026-05-15)

O sistema está em **Fase 3 / Fase D estendida (shadow assistido)**.
Organizadora em produção e calibrada. Atendente em shadow capaz de:
- Decidir skill via Planner LLM (v1.2.8, sem regex de customer text)
- Rodar tools determinísticas (`buscarProduto`, `verificarEstoque`, `buscarCompatibilidade`, `calcularFrete`, `buscarPoliticaComercial`)
- Auto-chain de `verificarEstoque` pós-`buscarProduto` (determinístico, sem regex)
- Gerar resposta via Generator LLM (v1.4.0 default ou v1.5.0 few-shot atrás de flag)
- Emitir claims estruturados (`price`, `stock_availability`, `fitment`, `delivery_fee`) validados contra tool results pelo `ClaimValidator`
- Emitir action `escalate` sintética quando Planner escolhe `escalar_humano` → grava em `agent.escalations` + nota interna Chatwoot
- Persistir tudo em `agent.*` e `ops.*` com idempotência por `action_id`

**Nada é enviado ao cliente automaticamente.** Sprint 8 (envio Chatwoot) continua adiado.

## Versões Ativas

| Componente | Versão atual | Notas |
|---|---|---|
| Planner prompt | `planner_v1.2.8` | sem patches regex sobre customer text; regras explícitas por skill |
| Generator prompt (default) | `generator_v1.4.0` | declarativo com regras + structured claims |
| Generator prompt (flag) | `generator_v1.5.0` | few-shot ~2660 tokens, 10 exemplos canônicos; ativar via `GENERATOR_PROMPT_FEW_SHOT_ENABLED=true` |
| Organizadora prompt | `moto-pneus-hybrid-v3-4` | estável |
| Migrations DB | `0001`-`0030` | todas aplicadas em prod |

## Recursos Implementados

**Captura:**
- Fase 1: webhook, raw, core, admin replay/reconcile
- Fase 1.5: imutabilidade, constraints, guards

**Enrichment:**
- Fase 2a: enrichment determinístico
- Fase 3 Organizadora: worker LLM, facts, evidence, incidentes
- Analytics marts v1

**Atendente — Sprints 1–6.9** (estado reentrante, tools, Planner foundation,
Executor, validators iniciais, worker shadow, Generator shadow, loop de estado,
bridge Organizadora→Context, SayValidator endurecido, filtro sender_type,
nota Chatwoot ao escalar).

**Atendente — Pós-Maio/2026** (esta janela):
- **Planner-input fix** (commit `4963701`): prompt v1.2.7 com regras
  de marca/product_code; sanitize defensivo no executor. Resolveu 97% de
  `buscarProduto.output = []` por inputs alucinados.
- **Fase 3 residual** (commit `0a40e0d`): fitment hedge no SayValidator,
  anti-soma no prompt do Generator, regra `update_draft` exige endereço,
  auto-chain inicial.
- **Refactor A2** (commit `0ba7988`): remove regex de intent do auto-chain;
  regra puramente determinística "achou produto → confirma estoque".
- **B1+B2+B3 housekeeping** (commit `ce16830`): `safeRollback` com log,
  remove dead branch em `action-validator:99`, `deterministicId` 32-bit →
  `deterministicUuid` sha256.
- **B4 action_id** (commit `d0c5da3`): adiciona `stateActionBaseSchema.extend`
  em `addToCart`, `removeFromCart`, `updateCartItem`, `clearCart`,
  `requestConfirmation`, `escalate`, `selectSkill`.
- **B5 escalação real** (commit `9888bd7`): worker emite action `escalate`
  quando `Planner.skill === 'escalar_humano'`. `agent.escalations` agora
  recebe linhas (5 confirmadas em DB), `postEscalateNote` chamado.
- **Etapa 3 Planner cleanup** (commit `b6bc9d9`): removeu do
  `normalizePlannerOutputCandidate` os patches regex que liam customer text
  para "consertar" decisões do Planner LLM. Especificamente:
  - **Removidas do código (deletadas):** `mentionsProductCompatibilityQuestion`,
    `shouldEnsurePolicyTool`, `findOrganizerNumberFact`, `latestCustomerText`.
  - **Mantidas como `@internal MOCK-ONLY`:** `mentionsPolicyQuestion` e
    `mentionsStoreInfoQuestion` (usadas APENAS por `mockPlanTurn` quando
    `PLANNER_LLM_ENABLED=false` em dev — nunca em prod).
  Planner v1.2.8 com regras explícitas por skill e exemplos de fala informal
  (REGRA DE OURO). Em produção, LLM é o único intérprete de fala humana.
- **Etapa 2 structured claims** (commit `408f058`): Generator emite
  `claims[]` junto com `say`. `ClaimValidator` checa cada claim contra
  tool results. `SayValidator` regex continua como rede de segurança.
- **Limpeza dead code** (commit `654c521`): remove `llmAtendenteResponseSchema`
  legado (não importado em lugar nenhum).
- **Audit claims** (commit `1edd3a2`): `event_payload.claims` +
  `claims_count` + `claim_types` + `blocked_payload.claims`.
- **v1.5.0 few-shot** (commit `cc93a05`): novo prompt-v1_5.ts com 10
  exemplos canônicos derivados de catalog15 + bugs do Codex.
  `GENERATOR_PROMPT_FEW_SHOT_ENABLED` controla A/B.
- **Audit prompt_version fix** (commit `6f7e7c5`): DB grava versão REAL
  do prompt (v1.4 ou v1.5) em vez da constante.

## Resultados das Baterias Recentes

**catalog15-rerun com v1.5.0 ligada (2026-05-15):**
- 45/45 generated, 0 blocked
- 2 fallbacks exatos (eram 6 com v1.4.0)
- 64,4% turns com claims, média 1,4 claims/turn
- 0 `claim_invalid:*` blocks
- Tipos: price 32, stock_availability 24, fitment 4, delivery_fee 1
- Notas: Planner 9/10, Generator 9/10 provisório, Organizadora 8.5/10 provisório

**Bateria custom 8 casos coloquiais (2026-05-15):**
- 8/8 generated, 0 blocked
- Casos cobertos: "tem aí pra Fan?", "vc traz em Belford Roxo?",
  "pega na minha Bros?", "tá salgado?", "dois pneus, quanto cada e tem?",
  "ia querer X, mas é Y", "pode separar, pago pix, busco hoje"
- 1 caso ("tá salgado") caiu em SAFE_FALLBACK — Planner falhou em rotear
  pra `tratar_objecao`; não é bug do Generator

## Últimas Validações Técnicas

- `npm run typecheck`: verde
- `npm test`: 463/463 verde, 55 arquivos
- `npm run build`: verde
- Migrations 0001-0030 aplicadas em prod

## Últimos Commits Relevantes (pneus/main)

Ver `docs/NEXT_CHAT_HANDOFF.md` para a lista completa desta janela
(12 commits desde `4963701`).

## Próxima Fase

**Fase D estendida (ADR-008)** — em andamento.

Frentes paralelas:
1. Coleta humana 2-4 semanas, comparação humano vs bot
2. Catálogo comercial (preço, marca, foto, estoque real — 78 produtos técnicos
   prontos, comercial escasso — ver `docs/COMMERCE_CATALOG_STATUS.md`)
3. 6 blocos de infra: particões, LGPD, runbook, rate limit, auditoria RLS,
   reconciliação CLI

**Não fazer agora:**
- Tunar mais prompts (sistema entrou em diminishing returns)
- Critic (descartado, ADR-005)
- Supervisora (adiada para Fase G, ADR-006)
- Sprint 8 envio (depois da Fase D + catálogo)

## Cuidados

- Nao limpar nem reverter arquivos que o usuario criou sem revisar.
- Nao recriar scripts com token, connection string, endpoint real ou dados
  operacionais sensiveis hardcoded. Use `.env` local.
- `.env` e `.env.codex` nunca devem ser commitados.
- `ATENDENTE_SHADOW_ENABLED=true` em prod hoje, mas envio Chatwoot continua
  inexistente/desligado.
- `GENERATOR_PROMPT_FEW_SHOT_ENABLED=true` ativa v1.5.0; rollback = `false` + redeploy.

---

## HISTÓRICO (preservado para auditoria)

O HANDOFF anterior listava Sprints 6.5-6.9 + PRs 1-5 + ajustes
`planner_v1.2.5`/`generator_v1.3.1`/`generator_v1.3.2` em detalhe. Todos
continuam válidos como histórico; este arquivo foi reescrito em 2026-05-15
para refletir o estado pós-migração para Responses API + structured claims +
few-shot.

Versões anteriores estão no git.
