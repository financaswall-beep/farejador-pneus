# Farejador - Visao Atual do Projeto

Atualizado: 2026-05-03.

Farejador e o backend que captura conversas do Chatwoot, normaliza dados em
Postgres/Supabase e prepara uma fundacao auditavel para analytics,
Organizadora LLM e Atendente em shadow/controle humano.

## Status Executivo

| Area | Status |
| --- | --- |
| Fase 1 - webhook, raw, core, admin | Concluida e em prod |
| Fase 1.5 - hardening DB/runtime | Concluida |
| Fase 2a - enrichment deterministico | Concluida |
| Fase 3 - Organizadora LLM | Implementada e em prod |
| Fase 3 - analytics marts | Implementadas |
| Atendente Sprint 1 - estado reentrante | Implementado |
| Atendente Sprint 2 - tools deterministicas | Implementado |
| Atendente Sprint 3 - Planner foundation | Implementado |
| Atendente Sprint 4 - Executor/guardrails | Implementado |
| Atendente Sprint 5 - worker shadow | Implementado, desligado por default |
| Atendente Sprint 6 - Generator shadow | Proxima fase |

## O Que Esta Ligado

- Webhook Chatwoot -> `raw.*`.
- Normalizacao deterministica -> `core.*`.
- Enrichment deterministico -> `analytics.*`.
- Organizadora LLM -> `analytics.conversation_facts` e
  `analytics.fact_evidence`.
- Atendente Shadow Worker -> `agent.*`/`ops.*` quando
  `ATENDENTE_SHADOW_ENABLED=true`, sem Generator e sem envio Chatwoot.
- Migrations ate `0026` aplicadas/validadas no Supabase atual.

## O Que Ainda Nao Esta Ligado

- Nenhum bot responde cliente.
- Nao existe envio Chatwoot pela Atendente.
- Planner LLM fica desligado por default (`PLANNER_LLM_ENABLED=false`).
- Generator, Critic e Reflection Loop ainda nao existem.

## Invariantes

- `raw.*` e `core.*` sao deterministicas e nao recebem escrita de LLM.
- Organizadora escreve somente em `analytics.*` e incidentes em `ops.*`.
- Atendente, quando existir, deve consumir `core.*`, `analytics.*` e
  `commerce.*`; nunca deve alterar `raw.*`, `core.*` ou `commerce.*`.
- Atendente Shadow pode gravar auditoria/estado em `agent.*` e incidentes em
  `ops.*`; nunca envia mensagem ao cliente.
- Tudo respeita `environment` (`prod`/`test`).
- Dados sensiveis nunca entram em scripts temporarios versionados.

## Stack

- TypeScript + Node.js
- Fastify
- Zod
- Supabase Postgres via `pg`
- Pino
- Vitest

## Referencias De Estado

- `docs/NEXT_CHAT_HANDOFF.md` - resumo curto para continuar em outro chat.
- `docs/phase3-agent-architecture/00-estado-de-implementacao.md` - log
  detalhado da Fase 3.
- `docs/phase3-agent-architecture/21-atendente-v1-state-design.md` - desenho
  consolidado da Atendente reentrante.
- `db/migrations/README.md` - ordem das migrations.
- `docs/DATA_DICTIONARY.md` - dicionario do banco.
