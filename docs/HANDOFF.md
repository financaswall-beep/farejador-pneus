# Handoff - Farejador

Atualizado: 2026-05-03.

Este arquivo e o handoff operacional curto. Para contexto completo da proxima
conversa, use tambem `docs/NEXT_CHAT_HANDOFF.md`.

## Estado Atual

O sistema esta em Fase 3, com a Organizadora em producao/calibrada e a
Atendente construida em camadas. A Atendente ainda nao responde clientes
automaticamente.

Implementado:

- Fase 1: webhook, raw, core, admin replay/reconcile.
- Fase 1.5: imutabilidade, constraints e guards.
- Fase 2a: enrichment deterministico.
- Fase 3 Organizadora: worker LLM, facts, evidence, incidentes.
- Analytics marts v1.
- Atendente Sprint 1: estado reentrante (`session_items`, `session_slots`,
  `action_id`, versionamento).
- Atendente Sprint 2: tools deterministicas de commerce.
- Atendente Sprint 3: Context Builder, Planner schema/service, policy schemas.
- Atendente Sprint 4: Tool Executor, eventos `tool_executed/tool_failed`,
  `SayValidator` inicial e `ActionValidator` reforcado.
- Atendente Sprint 5: Worker Shadow minimalista (`src/atendente/worker.ts`),
  log-only, desligado por default via `ATENDENTE_SHADOW_ENABLED=false`.
- Normalizacao enfileira `ops.atendente_jobs` em `message_created` quando
  `ATENDENTE_SHADOW_ENABLED=true`, usando `ops.enqueue_atendente_job`
  idempotente por mensagem.
- Atendente Sprint 6: Generator Shadow (`src/atendente/generator/service.ts`).
  Gera resposta candidata auditavel, valida com SayValidator/ActionValidator,
  grava em `agent.turns` (status='generated'|'blocked') e auditoria em
  `agent.session_events` (event_type='generator_produced'). Nunca envia ao Chatwoot.
  Controlado por `GENERATOR_LLM_ENABLED` (default false).
- Organizadora v3.3: prompt `moto-pneus-hybrid-v3-3`, matriz expandida 48
  casos com 46 aprovados, 2 falhas pequenas registradas.

Nao implementado/nao ligado:

- Critic.
- Envio Chatwoot pela Atendente.
- Qualquer atendimento automatico ao cliente.

## Ultimas Validacoes

- `npm test`: 289/289 verde.
- `npm run typecheck`: verde.
- `npm run build`: verde.
- Migration `0027_generator_shadow_events.sql` aplicada no Supabase atual em
  2026-05-03 e verificada: `generator_produced` aceito no CHECK de
  `agent.session_events`.
- Scripts operacionais locais higienizados em 2026-05-03 para nao carregar
  `DATABASE_URL`, endpoint real de Chatwoot ou identificador de inbox como
  default hardcoded. Devem ser executados sempre com `.env` local.
- Migrations ate `0027` criadas/aplicadas no Supabase atual.

## Ultimos Commits Relevantes

- `834151d docs: record organizadora v3.3 eval`
- `7beb37c feat: tune organizadora prompt v3.3`
- `fec54ad feat: add atendente shadow worker`
- `05395d8 fix: share deterministic event ids`

Remotes sincronizados:

- `origin/main`
- `pneus/main`

## Proxima Fase Recomendada

Sprint 7: Critic Shadow da Atendente.

Objetivo: avaliar a resposta candidata do Generator antes de qualquer envio:

```text
ops.atendente_jobs
  -> worker pega job
  -> Context Builder
  -> Planner
  -> Tool Executor
  -> Generator shadow (gera candidato)
  -> Critic shadow (avalia candidato)
  -> grava auditoria
  -> STOP, sem envio Chatwoot
```

Alternativamente, se Critic for considerado prematuro, proxima fase pode ser:
- ativar envio Chatwoot controlado para conversas de teste em shadow mode;
- monitorar qualidade por 1-2 semanas antes de ativar em producao.

## Cuidados

- Nao limpar nem reverter arquivos que o usuario criou sem revisar.
- Nao recriar scripts com token, connection string, endpoint real ou dados
  operacionais sensiveis hardcoded. Use `.env` local.
- `.env` e `.env.codex` nunca devem ser commitados.
- `ATENDENTE_SHADOW_ENABLED` pode rodar em log-only; envio Chatwoot continua
  inexistente/desligado ate Wallace mandar ativar explicitamente.
