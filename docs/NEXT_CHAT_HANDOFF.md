# Next Chat Handoff - Farejador

Atualizado: 2026-05-03.

Use este resumo para continuar em outro chat sem reler a conversa inteira.

## Onde Estamos

Estamos construindo a Atendente por camadas, mas ela ainda nao envia mensagem ao
cliente. O sistema atual em producao captura Chatwoot, normaliza, roda
Organizadora LLM, roda a fundacao da Atendente em modo shadow quando habilitada
e prepara dados/estado para o Generator futuro.

## Ja Implementado

Base:

- Fase 1: webhook Chatwoot, `raw.*`, `core.*`, admin replay/reconcile.
- Fase 1.5: hardening de imutabilidade, idempotencia e guards.
- Fase 2a: enrichment deterministico.
- Fase 3 Organizadora: LLM em background escrevendo facts/evidence em
  `analytics.*`.
- Analytics marts v1.

Atendente:

- Sprint 1: estado reentrante com `agent.session_items`,
  `agent.session_slots`, `action_id`, versionamento e `applyAction`.
- Sprint 2: tools deterministicas:
  `buscarProduto`, `verificarEstoque`, `buscarCompatibilidade`,
  `calcularFrete`, `buscarPoliticaComercial`.
- Sprint 3: Context Builder + Planner foundation:
  `planner_decided`, `PlannerOutput`, `tool_requests` com input validado,
  `POLICY_VALUE_SCHEMAS`, `resolve_vehicle_model`.
- Sprint 4: Tool Executor + guardrails:
  `tool_executed/tool_failed`, `executeToolRequests`, `SayValidator` inicial,
  `ActionValidator` reforcado.
- Hardening pos-auditoria:
  logger estruturado, dinheiro com milhar, ids deterministicos compartilhados,
  idempotencia por turno no Planner.
- Sprint 5: Worker Shadow minimalista:
  `src/atendente/worker.ts`, consumo de `ops.atendente_jobs`,
  `buildPlannerContext`, `planTurn`, `recordPlannerDecision`,
  `executeToolRequests`, `recordToolExecutionResults`, sem Generator e sem
  envio Chatwoot. Desligado por default via `ATENDENTE_SHADOW_ENABLED=false`.
- Organizadora v3.3 calibrada:
  prompt `moto-pneus-hybrid-v3-3`, matriz expandida com 46/48 aprovados
  apos deploy em 2026-05-03.

## O Que Ainda Nao Existe

- Generator.
- Critic.
- Reflection loop.
- Envio Chatwoot pela Atendente.
- Atendimento automatico.

## Validacao Atual

Ultima validacao local conhecida:

- `npm test`: 267/267 verde.
- `npm run typecheck`: verde.
- `npm run build`: verde.
- Scripts operacionais locais foram higienizados em 2026-05-03 para depender de
  `.env` e nao manter secrets/endpoints reais hardcoded no repo.

Ultimos commits enviados para `origin/main` e `pneus/main`:

- `834151d docs: record organizadora v3.3 eval`
- `7beb37c feat: tune organizadora prompt v3.3`
- `d6669e6 test: expand organizadora eval matrix`
- `fec54ad feat: add atendente shadow worker`

## Proxima Fase

Sprint 6: Generator shadow da Atendente.

Objetivo: gerar uma resposta candidata em auditoria, ainda sem enviar nada ao
cliente.

Fluxo esperado:

```text
ops.atendente_jobs
  -> worker pega job
  -> buildPlannerContext
  -> planTurn
  -> executeToolRequests
  -> Generator cria resposta candidata
  -> validadores bloqueiam fala sem lastro
  -> grava auditoria shadow
  -> para
```

Nao fazer ainda:

- nao enviar Chatwoot;
- nao ativar envio automatico;
- nao criar pedido automatico.
- nao remover o modo shadow/log-only.

## Pergunta Para Comecar O Proximo Chat

"Quero abrir a Sprint 6: desenhar o Generator shadow da Atendente, sem envio
Chatwoot. Antes de codar, confira o estado do repo e proponha o menor plano
seguro."
