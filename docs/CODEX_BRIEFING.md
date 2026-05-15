# Briefing Para Codex - Farejador

**Atualizado: 2026-05-15.**

## Leitura Rápida

Você está no repo `C:\Farejador agente`. Responda em português brasileiro.

O projeto está em **Fase 3 / Fase D estendida (shadow assistido)**. O Atendente
roda em shadow gerando resposta candidata auditável; NÃO envia nada ao cliente.

## Estado da Atendente (2026-05-15)

### Versões Ativas

| Componente | Versão | Arquivo |
|---|---|---|
| Planner | `planner_v1.2.8` | `src/atendente/planner/prompt.ts` + `schemas.ts` |
| Generator (default) | `generator_v1.4.0` | `src/atendente/generator/prompt.ts` |
| Generator (flag) | `generator_v1.5.0` | `src/atendente/generator/prompt-v1_5.ts` |
| Organizadora | `moto-pneus-hybrid-v3-4` | `src/organizadora/prompt.ts` |

### Recursos Implementados Nesta Janela (Maio 2026)

**Planner-input fix:**
- `src/atendente/planner/prompt.ts`: regras absolutas sobre `marca` (somente
  fabricante de pneu) e `product_code` (somente SKU confirmado). NUNCA copiar
  medida ou marca de moto.
- `src/atendente/executor/tool-executor.ts`: `sanitizeBuscarProdutoInput` —
  rede de segurança que dropa `marca`/`product_code` se forem medida-like ou
  marca de moto conhecida. Permissivo para marcas desconhecidas.

**Etapa 3 — Planner sem regex de customer text:**
- Removidas funções `mentionsProductCompatibilityQuestion`,
  `shouldEnsurePolicyTool`, `findOrganizerNumberFact`, `latestCustomerText`.
- `mentionsPolicyQuestion` e `mentionsStoreInfoQuestion` mantidas como
  `@internal MOCK-ONLY` (usadas apenas em `mockPlanTurn`, dev path).
- Lógica de "patch" em `normalizePlannerOutputCandidate` removida —
  Planner LLM é o único intérprete de fala humana em tempo real.
- Trava não-regex preservada: `buscar_e_ofertar` sem tool → força
  `pedir_dados_faltantes`.

**Etapa 2 — Structured commercial claims:**
- `src/atendente/generator/schemas.ts`: `generatorClaimSchema` (discriminated
  union sobre `type`): `price`, `stock_availability`, `fitment`, `delivery_fee`.
- `generatorOutputRawSchema.claims: GeneratorClaim[]` (default `[]`).
- `src/atendente/validators/claim-validator.ts`: `validateClaims(claims, toolResults)`.
  Cada tipo de claim tem regra determinística contra tool result correspondente.
- Wired em `runValidators` no `service.ts`. SayValidator regex continua como
  rede de segurança durante migração.

**Etapa "v1.5.0 few-shot":**
- `src/atendente/generator/prompt-v1_5.ts`: novo prompt com 10 exemplos
  canônicos cobrindo todos os failure modes observados em catalog15-rerun.
- Feature flag `GENERATOR_PROMPT_FEW_SHOT_ENABLED` (env): quando `true`,
  service roteia para `buildGeneratorMessagesFewShot`. Default `false`.
- Schema agora aceita ambos: `generatorOutputRawSchema.prompt_version` é
  `z.enum([generatorPromptVersionV14, generatorPromptVersionV15])`.
- Tamanho: v1.5.0 ~2660 tokens vs v1.4.0 ~3690 tokens (~28% menor).

**B4 + B5 pré-shadow:**
- B4: todas as actions (`addToCart`, `removeFromCart`, `updateCartItem`,
  `clearCart`, `requestConfirmation`, `escalate`, `selectSkill`) ganharam
  `stateActionBaseSchema.extend` — `action_id` + meta agora obrigatórios →
  idempotência garantida.
- B5: `src/atendente/worker.ts` → `maybeSynthesizeEscalate(decision, generatorResult, ...)`
  emite action `escalate` quando `Planner.skill === 'escalar_humano'`. O
  Generator não emite escalate (não está em seu raw schema). Reason inferido
  de `risk_flags` + confidence. `agent.escalations` agora recebe linhas reais.

**Auto-chain `verificarEstoque`:**
- `src/atendente/executor/tool-executor.ts`: `maybeAutoChainVerificarEstoque`.
- Regra determinística: se `buscarProduto` retornou produto e `verificarEstoque`
  não rodou neste turno, executor injeta `verificarEstoque(product_id=primeiro)`.
- Sem regex sobre customer text.

**Audit:**
- `event_payload.claims` + `claims_count` + `claim_types` em
  `agent.session_events` (event_type=`generator_produced`).
- `blocked_payload.claims` em `agent.turns.blocked_payload`.
- `prompt_version` agora vem do `parsed.data.prompt_version` (versão real
  emitida pelo LLM), não da constante fixa.

**Housekeeping:**
- `worker.ts`: `safeRollback` substitui `.catch(() => {})` mudo.
- `action-validator.ts`: dead branch removido.
- `apply-action.ts`: `deterministicId` 32-bit → `deterministicUuid` sha256.
- `shared/zod/agent-actions.ts`: `llmAtendenteResponseSchema` morto removido.

## Princípio de Arquitetura (estabilizado)

**LLM interpreta linguagem natural; código valida estrutura.**

- Customer text → **Planner LLM** decide skill + tools (sem regex de patch)
- Tool execution → **código determinístico** (sanitize defensivo, auto-chain)
- Generator → **LLM** escreve `say` + emite claims + emite actions estruturadas
- Validators → **código determinístico** (ClaimValidator + SayValidator + ActionValidator)
- Audit → claims + prompt_version preservados em `event_payload`

Regex sobre fala humana só sobrevive como:
- `SayValidator` (sobre output do bot, rede de segurança transitória)
- Detectores `@internal MOCK-ONLY` no Planner (dev path quando LLM desligado)

## Próxima Tarefa Sugerida

**Fase D estendida (ADR-008) — coleta humana e observabilidade.**

Não faça mais tunning de prompt sem coletar dados primeiro. Sistema entrou
em diminishing returns.

Lote 1 — Coleta e observabilidade:
- Confirmar adoção de claims via SQL (deve ser >70% em buscar_e_ofertar pós-deploy)
- Monitorar bloqueios por causa
- Dataset humano vs bot (Wallace atende manual)

Lote 2 — Catálogo:
- Preço, marca, foto, estoque real (78 produtos técnicos prontos,
  comercial escasso)
- Ver `docs/COMMERCE_CATALOG_STATUS.md`

Lote 3 — 6 blocos de infra:
1. Particões julho/agosto 2026 (urgente, pg_partman não instalado)
2. Reconciliar migration history CLI/banco
3. LGPD: endpoint erasure + base legal
4. Runbook de desligamento de emergência
5. Rate limit / circuit breaker OpenAI
6. Auditoria RLS

**NÃO fazer:** Critic (descartado, ADR-005), Supervisora (adiada, ADR-006),
Sprint 8 envio (adiado até Fase D + catálogo).

## Comandos de Validação

```bash
npm test           # 463/463 verde (em 2026-05-15)
npm run typecheck  # verde
npm run build      # verde
```

## Como Ligar/Desligar v1.5.0 Few-shot

```bash
# Ligar
export GENERATOR_PROMPT_FEW_SHOT_ENABLED=true

# Desligar (rollback)
export GENERATOR_PROMPT_FEW_SHOT_ENABLED=false
```

Redeploy. Sem essa env, o sistema usa v1.4.0 (default).

## Arquivos de Estado Atual

- `docs/NEXT_CHAT_HANDOFF.md` — resumo curto e priorizado
- `docs/HANDOFF.md` — operacional médio
- `docs/CHECKLIST.md` — status por item
- `docs/PROJECT.md` — visão executiva
- `docs/CONFIG.md` — env vars (inclui `GENERATOR_PROMPT_FEW_SHOT_ENABLED`)
- `docs/phase3-agent-architecture/00-estado-de-implementacao.md` — log Fase 3
- `docs/adr/ADR-005`/`006`/`007`/`008` — decisões arquiteturais
- `docs/adr/ADR-009-claims-and-few-shot.md` — decisão Etapa 2 + v1.5.0 (novo)
- `db/migrations/README.md` — ordem das migrations

---

## HISTÓRICO (preservado para auditoria)

Versões anteriores deste briefing listavam Sprints 6.5-6.9, PRs 1-5,
`planner_v1.2.5`/`v1.2.6`, `generator_v1.3.0`/`v1.3.1`/`v1.3.2` e a
auditoria 2026-05-14. Todo o trace está no git. Esta reescrita reflete
o estado pós-migração Responses API + structured claims + few-shot.
