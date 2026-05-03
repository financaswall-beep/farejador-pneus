# Handoff - Farejador

Atualizado: 2026-05-03.

Este arquivo e o handoff operacional curto. Para contexto completo da proxima
conversa, use tambem `docs/NEXT_CHAT_HANDOFF.md`.

## Estado Atual

O sistema esta em Fase 3, com a Organizadora em producao/calibrada e a
Atendente construida em camadas. A Atendente ainda nao responde clientes.

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
- Organizadora v3.3: prompt `moto-pneus-hybrid-v3-3`, matriz expandida 48
  casos com 46 aprovados, 2 falhas pequenas registradas.

Nao implementado/nao ligado:

- Generator.
- Critic.
- Envio Chatwoot pela Atendente.
- Qualquer atendimento automatico ao cliente.

## Ultimas Validacoes

- `npm test`: 267/267 verde.
- `npm run typecheck`: verde.
- `npm run build`: verde.
- Migrations ate `0026` validadas/aplicadas no Supabase atual.

## Ultimos Commits Relevantes

- `834151d docs: record organizadora v3.3 eval`
- `7beb37c feat: tune organizadora prompt v3.3`
- `fec54ad feat: add atendente shadow worker`
- `05395d8 fix: share deterministic event ids`

Remotes sincronizados:

- `origin/main`
- `pneus/main`

## Proxima Fase Recomendada

Sprint 6: Generator shadow da Atendente.

Objetivo: criar resposta candidata auditavel sem enviar nada ao cliente:

```text
ops.atendente_jobs
  -> worker pega job
  -> Context Builder
  -> Planner
  -> Tool Executor
  -> Generator shadow
  -> validadores
  -> grava auditoria
  -> STOP, sem envio Chatwoot
```

Por que fazer assim:

- valida qualidade de resposta sem risco de envio;
- gera material de auditoria para Wallace/Opus;
- prepara o terreno para Critic e, depois, sugestao assistida.

## Cuidados

- Nao limpar nem reverter arquivos que o usuario criou sem revisar.
- Scripts temporarios na raiz foram removidos; nao recriar scripts com token ou
  dados reais fora de `tmp/`.
- `.env` e `.env.codex` nunca devem ser commitados.
- `ATENDENTE_SHADOW_ENABLED` pode rodar em log-only; envio Chatwoot continua
  inexistente/desligado ate Wallace mandar ativar explicitamente.
