# 14 - Topologia de Execucao

## Por que este documento existe

A arquitetura define tres papeis logicos com latencias diferentes:

- Farejador API: sincrono, leve, 200 rapido
- Atendente Worker: async, baixa latencia
- Organizadora Worker: async, debounce/alta latencia

Sem este documento, fica vago **onde cada um roda** e **como sao acionados**. Isso bloqueia deploy e setup local.

## Principio sagrado

**Webhook do Chatwoot precisa responder 200 rapido.**

Nada que dependa de LLM pode rodar sincronamente no path do webhook.

Atendente nao e parte sincrona do webhook. E worker async com baixa latencia.

## Tres papeis logicos

### 1. Farejador API

Servico HTTP. Recebe webhook do Chatwoot.

Responsabilidades:

- validar HMAC;
- gravar `raw.raw_events`;
- normalizar e gravar `core.messages`, `core.sessions`, `core.contacts`;
- enfileirar job em `ops.atendente_jobs` (incoming do cliente);
- enfileirar job em `ops.enrichment_jobs` (debounce, upsert);
- responder 200 rapido ao Chatwoot.

Nao pode:

- chamar LLM;
- escrever em `agent.*`;
- escrever em `analytics.*`;
- segurar conexao do webhook.

### 2. Atendente Worker

Processo async. Consome `ops.atendente_jobs`.

Responsabilidades:

- pegar job em milissegundos (poll curto ou listen/notify);
- montar contexto via Context Builder;
- escolher skill via Planner constrained sobre o estado reentrante;
- chamar LLM Atendente;
- aplicar Say Validator + Action Validator;
- gravar `agent.turns` (idempotente). Em turn bloqueado, `say_text` fica
  `NULL` e o candidato fica em `blocked_say_text`/`blocked_payload`;
- executar action handlers (gravam `agent.*`);
- postar resposta no Chatwoot via API apenas quando Sprint 8/envio estiver habilitado.

Nota de estado em 07/05/2026: a Atendente ja tem estado reentrante, Planner,
Tool Executor, Worker Shadow log-only e Generator Shadow. Critic e envio
Chatwoot pela Atendente ainda nao existem.

Nao pode:

- escrever em `analytics.*`;
- escrever em `core.*` ou `raw.*`;
- escrever em `commerce.*` (v1).

Latencia alvo: resposta no Chatwoot em 3-8s desde o webhook chegar.

### 3. Organizadora Worker

Processo async. Consome `ops.enrichment_jobs`.

Responsabilidades:

- polling em jobs com `not_before <= now()`;
- ler `core.messages` ate `last_message_id`;
- ler `agent.pending_confirmations` resolvidas (reforco);
- chamar LLM Organizadora com schema fechado de `fact_keys`;
- validar Zod (whitelist + evidencia);
- gravar `analytics.conversation_facts` (append-only);
- gravar `analytics.fact_evidence`;
- atualizar `analytics.conversation_classifications` por dimension;
- atualizar `analytics.customer_journey`;
- registrar `last_processed_message_id` no job.

Nao pode:

- escrever em `agent.*`;
- escrever em `core.*` ou `raw.*`;
- responder cliente.

Latencia: 60-120s apos inatividade ou ao fechar sessao.

### 4. Supervisora Worker (opcional futuro)

Nao entra no v1.

Processo async/batch que pode ser adicionado depois.

Responsabilidades possiveis:

- auditar conversas perdidas;
- revisar respostas bloqueadas;
- sugerir novas skills;
- analisar `ops.unhandled_messages`;
- apontar oportunidade perdida;
- gerar flags de qualidade.

Nao pode:

- responder cliente;
- alterar `core.*` ou `raw.*`;
- criar pedido;
- bloquear conversa em tempo real.

Latencia: diaria ou sob demanda.

## Filas

Postgres como fila no v1. Sem Redis, sem RabbitMQ.

```text
ops.atendente_jobs    consumido pelo Atendente Worker
ops.enrichment_jobs   consumido pela Organizadora Worker
```

Vantagens:

- transacao nativa: enfileirar + gravar core.messages no mesmo commit;
- zero infra extra;
- visivel em SQL para debug.

Mecanismo:

- `SELECT ... FOR UPDATE SKIP LOCKED` para concorrencia;
- `LISTEN/NOTIFY` se latencia virar problema (v2);
- por padrao, polling de 250-500ms.

## Deploy v1

### Preferido: 3 servicos, mesma imagem Docker

```yaml
# docker-compose conceitual (Coolify equivalente)
services:
  farejador-api:
    image: farejador:latest
    command: node dist/farejador.js

  atendente-worker:
    image: farejador:latest
    command: node dist/atendente.js

  organizadora-worker:
    image: farejador:latest
    command: node dist/organizadora.js
```

Vantagens:

- mesmo build, tres entrypoints;
- isolamento de processo (LLM travada num nao derruba os outros);
- escala independente;
- logs separados;
- healthcheck por servico.

### Fallback: 1 container com 3 processos

Se Coolify complicar:

```text
node dist/farejador.js     # webhook receiver
node dist/atendente.js     # worker Atendente
node dist/organizadora.js  # worker Organizadora
```

PM2 ou supervisord roda os tres. Menor isolamento, mais simples de configurar.

## Deploy v2

Tres containers separados se carga exigir. Mesma codebase, zero refator.

Tambem possivel:

- Atendente Worker em container com mais RAM (LLM context grande);
- Organizadora Worker em container scheduled (so roda em horario de baixo trafego);
- Farejador API com auto-scale horizontal.

## Deploy futuro com Supervisora

Se a LLM Supervisora for criada:

```text
supervisora-worker:
  image: farejador:latest
  command: node dist/supervisora.js
```

Ela deve ser batch/seletiva. Nao entra no caminho de resposta ao cliente.

## Codebase compartilhado

Mesmo repositorio, tres entrypoints:

```text
src/
  farejador/       webhook receiver
  atendente/       worker
  organizadora/    worker
  supervisora/     worker futuro opcional
  shared/          tipos, repositorios, schemas, validators
    repositories/
    schemas/
    validators/
    llm-clients/
```

Vantagens:

- types compartilhados (zero drift);
- repositorios reusados (`AgentRepo`, `AnalyticsRepo`, `CoreRepo`);
- schemas Zod canonicos;
- validators canonicos.

## Healthcheck

Cada servico expoe seu proprio:

```text
farejador-api       GET /healthz
atendente-worker    GET /healthz (porta separada)
organizadora-worker GET /healthz (porta separada)
```

Healthcheck verifica:

- conexao com Postgres;
- conexao com LLM provider (probe leve, timeout curto);
- backlog da fila respectiva (alerta se > N).

## Observabilidade minima

Cada servico loga estruturado em JSON:

```text
service: "farejador-api" | "atendente-worker" | "organizadora-worker"
event: nome do evento
session_id: se aplicavel
trigger_message_id: se aplicavel
duration_ms: para LLM e queries
```

Metricas chave:

- latencia webhook -> 200 (Farejador);
- latencia job enfileirado -> resposta enviada (Atendente);
- latencia job criado -> facts gravados (Organizadora);
- backlog de cada fila;
- taxa de incidentes em `ops.agent_incidents`.

## Escopo de leitura/escrita por papel

```text
Farejador API
  le:     payload do webhook, raw.*, core.*
  escreve: raw.*, core.*, ops.atendente_jobs, ops.enrichment_jobs

Atendente Worker
  le:     core.*, agent.*, analytics.* (consumo), commerce.*
  escreve: agent.* (apenas via action handler validado)
  posta:  Chatwoot API (resposta ao cliente)

Organizadora Worker
  le:     core.messages, agent.pending_confirmations resolvidas
  escreve: analytics.*

Supervisora Worker (Fase G futura, ADR-006 adiada para depois de Sprint 8)
  le:     core.*, analytics.*, agent.*, ops.*
  escreve: ops.supervisor_reviews + ops.supervisor_reason_codes (vocabulario fechado)
  nao escreve: raw.*, core.*, commerce.orders
  NOTA: NAO e proximo passo. Calibracao depende de dataset humano (Fase D estendida) + envio em producao.

Action handlers (compartilhados em src/shared)
  escrevem: agent.*, opcionalmente analytics.* (correct_fact, confirm_pending)
  nao escrevem: core.*, raw.*, commerce.* (v1)
```

## Anti-padroes

- Atendente sincrono ao webhook (quebra 200-rapido);
- Farejador chamando LLM (latencia mata webhook);
- Organizadora gravando em `agent.*` (mistura papeis);
- Atendente gravando em `analytics.*` direto (deve passar por action handler validado);
- worker sem idempotencia (retry duplica trabalho);
- mesma fila pra Atendente e Organizadora (latencias diferentes).
