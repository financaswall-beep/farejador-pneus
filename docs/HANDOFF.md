# Handoff - Farejador

**Atualizado: 2026-05-23 (sessão Claude Sonnet 4.5).**

> Para o estado MAIS RECENTE (sessão 2026-05-23), ver:
> [`docs/SESSAO_2026-05-23_HANDOFF.md`](SESSAO_2026-05-23_HANDOFF.md)
> Cobre: consolidação de catálogo (87 operações em prod), bug 593 morto na causa raiz
> (PCX 150 com 4 fitments), aliases envenenados limpos, 5 motos modernas adicionadas
> (CB 250F/300F Twister, CBR 250R, XJ6, CB 750 Hornet), variantes Crosser S 2025 e
> Ténéré Flex separadas. Plano anti-alucinação Camada 4 concluída — Camadas 1.4/1.5/3 pendentes.
>
> Sessão anterior (2026-05-22): [`docs/SESSAO_2026-05-22_HANDOFF.md`](SESSAO_2026-05-22_HANDOFF.md)
> + plano completo: [`docs/PLANO_ANTI_ALUCINACAO_2026-05-22.md`](PLANO_ANTI_ALUCINACAO_2026-05-22.md)

Este arquivo é o handoff operacional curto. Para contexto completo da próxima
conversa, use também `docs/NEXT_CHAT_HANDOFF.md` e os docs das sessões recentes.

## Estado Atual (2026-05-23)

**Mudanças desde 2026-05-22:**

| frente | resumo |
|---|---|
| Auditoria | 4 agentes paralelos auditaram prompts/validators/fluxo/banco. Plano de 5 camadas escrito em [`PLANO_ANTI_ALUCINACAO_2026-05-22.md`](PLANO_ANTI_ALUCINACAO_2026-05-22.md) |
| Pesquisa | 23 buscas web (manuais oficiais Honda/Yamaha/Suzuki/etc.) coletaram medidas com fontes |
| Catálogo | **+14 tire_specs, +5 motos modernas, +2 variantes, +45 fitments, -22 entradas duplicadas/órfãs** — banco passou de 157→141 motos limpas, 56→70 produtos, 132→177 fitments |
| Bug 593 | morto na causa raiz: PCX 150 (2013-2022) agora tem 4 fitments (OEM + alt), bot deixa de cair em `produtos=[]` |
| Aliases | envenenamentos removidos (Crosser ≠ Lander ≠ Ténéré, Ténéré 700 não rouba mais "Tenere" simples) |
| Script | `scripts/consolidar-catalogo-2026-05-23.ts` (~700 linhas) aplicado em prod em transação única (87 operações, ROLLBACK automático se erro) |

**Camada 4 do plano anti-alucinação concluída. Camadas 1.4/1.5/3 pendentes** — recomendadas como próxima frente.

---

## Estado Atual (2026-05-22)

**Mudanças desde 2026-05-15** (resumo — detalhes em [`SESSAO_2026-05-22_HANDOFF.md`](SESSAO_2026-05-22_HANDOFF.md)):

| frente | resumo |
|---|---|
| Catálogo | merge `test → prod`, 20 motos populares novas (CG/Factor/Fazer/MT/CB/Hornet/Twister), 56 produtos a R$ 99, 624 zones de entrega a R$ 9,90, migration 0047 resolve modelo preferindo candidatos úteis |
| Prompts | CoT estruturado obrigatório (a/b/c/d), exemplos 11/12/13/14 no Generator v1.5, anti-drible "tem sim opções", rationale 500→800 chars |
| Self-correction | worker.ts re-executa generator 1× quando blocked ou SAFE_FALLBACK, com retryContext específico |
| Validator | say-validator aceita aritmética simples sobre tool_results_history (somas 2-3 valores, múltiplos 1..10x) |
| Organizadora | nova seção "QUEM DISSE O PRECO" + 2 fact_keys novos (`preco_cotado`, `taxa_frete_cotada`) |
| Bug aberto 🔴 | bot afirma compatibilidade implícita ("achei o pneu pra X") sem buscarCompatibilidade ter retornado o product_id (conv 593) |

**Commits da sessão 2026-05-22**:
- `a615832` — prompts pensativos + fact_keys cotação
- `ecc9220` — self-correction + anti-mentira + extracao frete confirmado
- `bae915a` — say-validator aceita aritmética sobre history
- `8f2bafd` — migration 0047 resolve_vehicle_model

---

## Estado Atual (linha base 2026-05-15)

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
