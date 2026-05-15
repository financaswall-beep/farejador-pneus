# Farejador - Visão Atual do Projeto

**Atualizado: 2026-05-15.**

Farejador é o backend que captura conversas do Chatwoot, normaliza dados em
Postgres/Supabase e prepara uma fundação auditável para analytics,
Organizadora LLM e Atendente em shadow/controle humano.

## Status Executivo

| Área | Status |
| --- | --- |
| Fase 1 — webhook, raw, core, admin | Concluída e em prod |
| Fase 1.5 — hardening DB/runtime | Concluída |
| Fase 2a — enrichment determinístico | Concluída |
| Fase 3 — Organizadora LLM | Em produção, `moto-pneus-hybrid-v3-4` |
| Fase 3 — analytics marts | Implementadas |
| Atendente Sprints 1–6.9 | Todos concluídos (estado reentrante, tools, Planner, Executor, validators, worker shadow, Generator shadow, loop de estado, bridge Organizadora, SayValidator endurecido, filtro sender_type, nota Chatwoot ao escalar) |
| Atendente — Planner-input fix | Concluído (`4963701`) — Planner v1.2.7 com regras marca/product_code + sanitize defensivo |
| Atendente — Fase 3 residual (A1+A3+A4) | Concluído (`0a40e0d`) — fitment hedge, anti-soma, delivery sem endereço, auto-chain inicial |
| Atendente — Refactor A2 (auto-chain) | Concluído (`0ba7988`) — auto-chain determinístico sem regex de intent |
| Atendente — B1+B2+B3 housekeeping | Concluído (`ce16830`) — safeRollback, dead branch, sha256 UUID |
| Atendente — B4 action_id | Concluído (`d0c5da3`) — metadados em todas as actions |
| Atendente — B5 escalação real | Concluído (`9888bd7`) — worker emite `escalate` quando Planner=`escalar_humano` |
| Atendente — Etapa 3 Planner cleanup | Concluído (`b6bc9d9`) — Planner v1.2.8 sem regex de customer text |
| Atendente — Etapa 2 structured claims | Concluído (`408f058`) — Generator v1.4.0 + ClaimValidator |
| Atendente — Audit claims | Concluído (`1edd3a2`) — claims em `event_payload` |
| Atendente — Generator v1.5.0 few-shot | Concluído (`cc93a05`) — atrás de feature flag `GENERATOR_PROMPT_FEW_SHOT_ENABLED` |
| Atendente — Audit prompt_version fix | Concluído (`6f7e7c5`) — DB grava versão real (v1.4 ou v1.5) |
| Critic (Sprint 7 original) | DESCARTADO (ADR-005). SayValidator + ActionValidator + ClaimValidator são o gate. |
| Supervisora batch | ADIADA para Fase G (ADR-006). |
| **Fase D estendida (coleta humana 2-4 semanas)** | **EM ANDAMENTO (ADR-008)** |
| Envio Chatwoot (Sprint 8) | Adiado até Fase D + catálogo. `ATENDENTE_SEND_ENABLED` não existe. |
| Seed catálogo commerce.* | Técnico populado (78 produtos, 308 vehicle_models, 166 fitments). Preço/marca/foto/estoque comercial escasso. |

## O Que Está Ligado em Prod (2026-05-15)

- Webhook Chatwoot → `raw.*` → `core.*`
- Enrichment determinístico → `analytics.*`
- Organizadora LLM → `analytics.conversation_facts` + `analytics.fact_evidence`
- Atendente Shadow Worker:
  - `ATENDENTE_SHADOW_ENABLED=true`
  - `GENERATOR_LLM_ENABLED=true`
  - Planner LLM v1.2.8 decide skill + tools
  - Tools determinísticas: `buscarProduto`, `verificarEstoque`,
    `buscarCompatibilidade`, `calcularFrete`, `buscarPoliticaComercial`
  - Sanitize defensivo em `tool-executor` dropa `marca`/`product_code`
    alucinados (medida-no-campo-marca, marca-de-moto)
  - Auto-chain `verificarEstoque` quando `buscarProduto` retorna produto
  - Generator LLM v1.4.0 (ou v1.5.0 atrás de flag)
  - Generator emite claims estruturados (price/stock/fitment/delivery_fee)
  - ClaimValidator + SayValidator (rede regex) + ActionValidator
  - Worker emite `escalate` sintética em skill=`escalar_humano`
  - `agent.turns`, `agent.session_events`, `agent.escalations` populados
- **Nenhuma mensagem é enviada ao cliente.** Sprint 8 continua adiado.

## Estado Real do Banco (2026-05-15)

```
agent.session_events:        5909 linhas / 6.4 MB
agent.turns:                 1396 linhas
agent.escalations:              5 linhas  (B5 funcionando — era 0 antes)
agent.order_drafts:            41 linhas
analytics.conversation_facts: 2976 linhas
commerce.products:             78 linhas
core.messages_2026_05:       1675 linhas
ops.atendente_jobs:          1396 linhas
ops.agent_incidents:           57 linhas (14 dias)
```

Migrations aplicadas: `0001` até `0030_vehicle_resolver_variant_precision.sql`.

## O Que Ainda Não Está Ligado

- Nenhum bot responde cliente automaticamente
- Não existe envio Chatwoot pela Atendente (`ATENDENTE_SEND_ENABLED` não existe em código)
- Critic e Reflection Loop não serão implementados (descartados)
- Catálogo comercial completo (preço, marca, foto, estoque): pendente
- Particões julho/agosto 2026 (pg_partman não instalado, urgente antes de 30/jun)
- Endpoint LGPD operacional de erasure
- Rate limit / circuit breaker OpenAI

## Princípio de Arquitetura

**Flexível no funil, rígida na verdade. LLM interpreta linguagem natural;
código valida estrutura.**

- Funil não é escada linear; é slot-filling reentrante
- Planner LLM escolhe skill + tool_requests (sem patches regex de customer text)
- Dados factuais vêm de tools determinísticas
- Validators bloqueiam fala/ação sem lastro
- Generator emite claims estruturados; validator checa contra tool results
- Tudo grava ledger auditável

## Invariantes (não-negociáveis)

- `raw.*` e `core.*` são determinísticas e não recebem escrita de LLM
- Organizadora escreve somente em `analytics.*` e incidentes em `ops.*`
- Atendente consome `core.*`, `analytics.*` e `commerce.*`; nunca altera `raw.*`, `core.*` ou `commerce.*`
- Atendente Shadow grava auditoria/estado em `agent.*` e incidentes em `ops.*`; nunca envia mensagem ao cliente
- Tudo respeita `environment` (`prod`/`test`)
- Dados sensíveis nunca entram em scripts temporários versionados

## Stack

- TypeScript + Node.js
- Fastify
- Zod
- Supabase Postgres via `pg`
- Pino
- Vitest

## Referências de Estado

- `docs/NEXT_CHAT_HANDOFF.md` — resumo curto para continuar em outro chat
- `docs/HANDOFF.md` — operacional médio
- `docs/CHECKLIST.md` — status por item
- `docs/CODEX_BRIEFING.md` — briefing para Codex
- `docs/CONFIG.md` — variáveis de ambiente
- `docs/phase3-agent-architecture/00-estado-de-implementacao.md` — log Fase 3
- `docs/DATA_DICTIONARY.md` — dicionário do banco
- `docs/adr/ADR-005`/`006`/`007`/`008`/`009` — decisões arquiteturais
- `db/migrations/README.md` — ordem das migrations
