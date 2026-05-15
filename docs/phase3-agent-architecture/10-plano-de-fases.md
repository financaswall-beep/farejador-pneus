# 10 - Plano de Fases

## Fase A - Documentacao

Sem SQL.

Sem codigo.

Entregas:

- overview da Fase 3;
- fact ledger;
- commerce tables;
- agent state;
- integration;
- ADRs;
- data dictionary em portugues.

Objetivo: aprovar arquitetura antes de implementar.

## Fase B - Schema do banco

Migrations previstas:

- `0013_commerce_layer.sql`
- `0014_commerce_indexes.sql`
- `0015_commerce_views.sql`
- `0016_agent_layer.sql`
- `0017_agent_triggers.sql`
- `0018_analytics_evidence.sql`
- `0019_ops_phase3_additions.sql`
- `0020_vehicle_fitment_validation.sql`

Cada migration deve:

- ser idempotente;
- ter comentarios;
- ter teste;
- ser validada em Postgres real antes de merge.

## Fase C - Integracao TypeScript

Areas previstas:

- `src/agent/`
- `src/organizadora/`
- `src/commerce/`
- `src/persistence/`
- `src/integration/`

Componentes:

- Context Builder;
- Skill Router;
- 9 skills;
- validador `{ say, actions }`;
- worker da Organizadora;
- polling em `ops.enrichment_jobs`;
- repositorios `commerce.*` e `agent.*`.

## Fase D - Shadow Assistido

Primeiro periodo operacional:

- Wallace atende manualmente;
- LLM Organizadora roda;
- LLM Atendente fica desligada;
- sistema coleta cerca de 5 semanas de dados reais;
- dados calibram skills, prompts, fact_keys e dashboards.

Feature flags sugeridas:

```text
ORGANIZADORA_ENABLED=true
ATENDENTE_SHADOW_ENABLED=false
PLANNER_LLM_ENABLED=false
```

Estado em 03/05/2026: Worker Shadow da Atendente ja existe e continua
log-only. A proxima fase e Generator shadow, ainda sem envio Chatwoot.

## Fase E - Atendente ligada gradualmente

V1 da Atendente:

- agente responde;
- monta carrinho;
- sugere pedido;
- humano fecha.

Nao criar pedido automatico nesse primeiro momento.

## Fase F - Automacao de pedido

Depois de semanas de validacao:

- ativar handler transacional de `create_order`;
- reservar estoque;
- criar pedido automaticamente;
- rollback seguro se estoque acabar.

## Fase D estendida - Coleta humana 2-4 semanas (PROXIMO PASSO REAL, ADR-008)

Decisao 2026-05-10: a Fase D original previa 5 semanas; foi estendida com mecanismo de comparacao humano vs bot.

- Wallace atende clientes manualmente no Chatwoot por 2-4 semanas adicionais;
- Agente continua em shadow gerando candidato em `agent.turns`, sem envio;
- Rotina simples deterministica de comparacao humano vs bot (cliente perguntou X, bot teria respondido Y, Wallace respondeu Z);
- Conversas atendidas pelo Wallace marcadas como golden em `core.conversations`;
- Material vira dataset para calibrar prompt do Generator (few-shot ou ajuste manual);
- Em paralelo: popular catalogo `commerce.*` + 6 blocos pequenos de infra (particoes, LGPD, runbook, rate limit, RLS, migration history).

## Fase G - Supervisora batch (futura, depois de Sprint 8 maduro, ADR-006)

**Decisao 2026-05-10:** adiada. NAO e proximo passo. Calibracao depende de dataset humano (Fase D estendida) + envio em producao.

Quando entrar:

- LLM Supervisora roda em batch;
- audita conversas pos-fato em `ops.supervisor_reviews`;
- sugere melhorias;
- revisa perdas;
- nao participa do tempo real.

NOTA: Critic em tempo real (Sprint 7 original) foi DESCARTADO em 2026-05-10 (ADR-005). SayValidator + ActionValidator sao o gate sincrono pre-envio (ADR-007).
