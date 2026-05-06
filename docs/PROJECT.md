# Farejador - Visao Atual do Projeto

Atualizado: 2026-05-06.

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
| Atendente Sprint 6 - Generator shadow | Implementado; LLM real em shadow |
| Atendente Sprint 6.5 - loop de estado | Implementado |
| Atendente Sprint 6.6 - bridge Organizadora | Implementado |
| Atendente Sprint 6.7 - Say Validator endurecido | Implementado |
| Atendente Sprint 6.8 - filtro sender_type | Implementado |
| Atendente Sprint 6.9 - nota Chatwoot ao escalar | Implementado em prod |
| Ajuste pre-Critic - memoria operacional do Generator | Implementado |
| Fix planner_v1.2.5 - Planner usa organizer_facts | Implementado em prod |
| Fix generator_v1.3.1 - Generator proibe SAFE_FALLBACK em pedir_dados_faltantes | Implementado em prod |
| Fix phase3 repo - dedup de facts identicos por valor | Implementado em prod |
| Critic (Sprint 7) | Proxima fase |
| Envio Chatwoot (Sprint 8) | Proxima fase |
| Seed catalogo commerce.* (Sprint 6.10) | Bloqueado por dados |

## O Que Esta Ligado

- Webhook Chatwoot -> `raw.*`.
- Normalizacao deterministica -> `core.*`.
- Enrichment deterministico -> `analytics.*`.
- Organizadora LLM -> `analytics.conversation_facts` e
  `analytics.fact_evidence`.
- Atendente Shadow Worker -> `agent.*`/`ops.*` quando
  `ATENDENTE_SHADOW_ENABLED=true`; Generator LLM real ativo em shadow.
- Generator recebe `state.items`, `organizer_facts` e `derived_signals` e emite
  actions de memoria operacional em tempo real (`create_item`, `update_slot`,
  `update_draft`).
- Nota interna Chatwoot (`private: true`) ao emitir `escalate`.
- Planner `planner_v1.2.5` promove `pedir_dados_faltantes` para
  `buscar_e_ofertar+buscarCompatibilidade` quando `organizer_facts` ja contem
  `moto_modelo` com conf >= 0.85 e cliente pergunta compatibilidade.
- Generator `generator_v1.3.1` proibe resposta SAFE_FALLBACK quando skill e
  `pedir_dados_faltantes`; SayValidator bloqueia com razao
  `safe_fallback_not_allowed_for_pedir_dados_faltantes`.
- `analytics-phase3.repository`: dedup de facts identicos por valor deep-equal
  antes de inserir nova linha — so anexa evidence ao fact existente.
- Migrations ate `0027` aplicadas/validadas no Supabase atual.

## O Que Ainda Nao Esta Ligado

- Nenhum bot responde cliente.
- Nao existe envio Chatwoot pela Atendente.
- Planner LLM fica desligado por default (`PLANNER_LLM_ENABLED=false`).
- Critic e Reflection Loop ainda nao existem.
- Nenhum envio de mensagem ao cliente (Sprint 8 pendente).
- Catalogo `commerce.*` vazio (seed pendente — Sprint 6.10).

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
