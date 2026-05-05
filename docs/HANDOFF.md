# Handoff - Farejador

Atualizado: 2026-05-05.

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
  idempotente por mensagem. Antes do enqueue, garante `agent.session_current`
  para a conversa.
- Hardening de fila da Atendente: `src/atendente/reconcile-jobs.ts` busca
  mensagens publicas de cliente em `core.messages` sem job em
  `ops.atendente_jobs` e cria os jobs faltantes com o mesmo caminho idempotente
  (`ensureAtendenteSession` + `ops.enqueue_atendente_job`). O worker shadow roda
  essa reconciliacao a cada minuto para as ultimas 24h; admin pode chamar
  `POST /admin/reconcile/atendente-jobs` para uma janela controlada.
- Atendente Sprint 6: Generator Shadow (`src/atendente/generator/service.ts`).
  Gera resposta candidata auditavel, valida com SayValidator/ActionValidator,
  grava em `agent.turns` (status='generated'|'blocked') e auditoria em
  `agent.session_events` (event_type='generator_produced'). Nunca envia ao Chatwoot.
  Controlado por `GENERATOR_LLM_ENABLED` (default false). Em producao atual,
  o Generator LLM real foi habilitado em shadow com `GENERATOR_OPENAI_API_KEY`
  e `GENERATOR_MODEL` configurados.
- Organizadora v3.4: prompt `moto-pneus-hybrid-v3-4`, gerando a secao de
  valores permitidos a partir de `FACT_KEY_SCHEMAS`; corrige aliases e tipos
  que geravam `schema_violation`.
- Sprint 6.5: loop de estado — worker itera actions e aplica via
  `applyActionAndPersistInTx`. Persiste `session_items`, `session_slots`,
  `cart_current`, `cart_events`, `order_drafts`, `pending_confirmations`,
  `escalations`. Commit `63e40e8`.
- Sprint 6.6: bridge Organizadora -> Context Builder — lê
  `analytics.conversation_facts` e entrega `organizer_facts` ao Planner.
  Commit `63e40e8`.
- Sprint 6.7: Say Validator endurecido — bloqueia afirmacoes comerciais sem
  evidencia (estoque/prazo/compatibilidade exigem tool correspondente).
  6 novos testes. Commit `79c0d19`.
- Sprint 6.8: filtro sender_type no dispatcher — so enfileira job para
  `sender_type='contact'`; bots/agentes/sistema descartados com log info.
  2 novos testes. Commit `193b4ef`.
- Sprint 6.9: nota interna Chatwoot ao escalar — `ChatwootApiClient.createNote()`
  posta nota `private: true` quando `escalate` é emitido, fora da transacao.
  No-op se variaveis Chatwoot ausentes. 5 novos testes. Commit `e35ca31`.
  Deploy 2026-05-05.
- Ajuste pre-Critic: Generator calibrado para memoria operacional em tempo real.
  Emite `create_item`, `update_slot` e `update_draft` para dados novos do cliente
  na propria mensagem; contexto inclui `state.items`, `organizer_facts` e
  `derived_signals`. 3 novos testes.
- Sprint 6.9 calibracao de prompts: SayValidator endurecido com 3 novos padroes
  (`mixed_safe_fallback_with_other_content`, variante de stock Michelin, variantes
  de prazo/entrega). Planner bumped para `planner_v1.2.0` com secao ROTEAMENTO
  CONVERSACIONAL (7 regras). Generator bumped para `generator_v1.3.0` com regras
  9 e 10 sobre fallback. 8 novos testes. 328/328 verde. Build verde.

Nao implementado/nao ligado:

- Critic (Sprint 7).
- Envio Chatwoot pela Atendente (Sprint 8).
- Seed do catalogo commerce.* (Sprint 6.10).
- Qualquer atendimento automatico ao cliente.

## Ultimas Validacoes

- `npm test`: 316/316 verde, 49 arquivos.
- `npm run typecheck`: verde.
- `npm run build`: verde.
- Migration `0027_generator_shadow_events.sql` aplicada no Supabase atual em
  2026-05-03 e verificada: `generator_produced` aceito no CHECK de
  `agent.session_events`.
- Teste em producao com 6 conversas Chatwoot: `ops.atendente_jobs`,
  `agent.turns` e eventos `generator_produced` gravando em shadow; Generator
  LLM real gerou respostas candidatas sem envio ao cliente.
- Teste em producao com 12 conversas Chatwoot em 2026-05-05: todas as mensagens
  chegaram como `message_created/contact`; 6 jobs nasceram automaticamente e 6
  foram recuperados manualmente. A correcao implementada nesta sessao adiciona
  reconciliador automatico e endpoint admin para que lacunas desse tipo sejam
  recuperadas sem perder turno da Atendente.
- Pos-redeploy `cc42bfa`, run real `multiturn-20260505124936`: 6 conversas com
  3 mensagens cada; 18/18 mensagens, 18/18 jobs e 18/18 turns em `prod`. Zero
  job faltante. Dois jobs atrasaram mais de 30s, mas processaram. Qualidade LLM:
  12/18 ok, 6/18 review. Problemas: frase generica de escalacao em 5 respostas,
  uma resposta com politica/logistica sem lastro suficiente e uma resposta com
  `temos Michelin disponivel` sem evidencia de estoque/catalogo.
- Auditoria `multiturn-20260505132047`: o deploy Coolify das 13:18 implantou
  `ce5ad8e` (docs-only), anterior ao commit local `032759c` com a calibracao.
  O banco confirma que o run usou `planner_v1.1.0` + `generator_v1.2.0`, nao
  `planner_v1.2.0` + `generator_v1.3.0`. Resultado factual do run antigo:
  18/18 mensagens, 18/18 jobs processed, 18/18 turns generated, 8/18 ok,
  10/18 review. Achado principal: muitas escalacoes vieram de
  `planner_schema_failed` (contrato/schema invalido: `traseiro` vs `rear`,
  `moto_ano` string, `municipio: null`, `buscarProduto` sem campo obrigatorio),
  nao de validacao real da calibracao nova. Relatorio completo:
  `docs/relatorio-atendente-2026-05-05.md`.
- Pos-deploy correto `a07f78f`, run `multiturn-20260505135703`: banco confirmou
  `planner_v1.2.0` + `generator_v1.3.0` em 18/18 turns. Resultado: 18/18 jobs
  processed, 17 generated, 1 blocked; 8/18 ok, 10/18 review. `escalar_humano`
  caiu de 12/18 para 9/18 e `tratar_objecao` apareceu 2 vezes. Gargalo real:
  6/18 `planner_schema_failed` por contrato de tool (`buscarProduto` sem
  medida/marca/product_code, `moto_ano` string, `posicao_pneu` em PT). Solucao
  local aplicada em `planner_v1.2.1`: normalizacao antes da validacao estrita
  (`traseiro` -> `rear`, ano string -> number, null omitido), enriquecimento de
  tool input com estado/fatos da Organizadora e downgrade seguro de
  `buscar_e_ofertar` sem tool valida para `pedir_dados_faltantes` em vez de
  fallback humano. Testes: 331/331 verde; typecheck verde.
- Sprint 6.7.5 local: SayValidator agora tambem bloqueia claims factuais de
  politica comercial sem `buscarPoliticaComercial` relevante
  (`policy_claim_without_tool_result`) e mismatches basicos de parcelamento/
  forma de pagamento (`policy_claim_mismatches_tool_result`). Mantem meta-fala
  liberada (ex.: "vou verificar", "preciso confirmar") para preservar conversa
  interpretativa. `commerce.store_policies` em prod foi atualizado com
  `parcelamento_maximo=4`, `formas_pagamento_aceitas=[pix, cartao_credito,
  cartao_debito]`, `prazo_troca=7 dias`, `garantia_descricao` da montagem e
  `horario_funcionamento` segunda a sabado 8h-17h. Testes: 351/351 verde;
  typecheck e build verdes.
- Organizadora v3.4 validada em conversas novas: extraiu facts como
  `moto_modelo`, `medida_pneu`, `posicao_pneu`, `bairro_mencionado`,
  `concorrente_citado` e `moto_cilindrada` sem novos `schema_violation`.
- Scripts operacionais locais higienizados em 2026-05-03 para nao carregar
  `DATABASE_URL`, endpoint real de Chatwoot ou identificador de inbox como
  default hardcoded. Devem ser executados sempre com `.env` local.
- Migrations ate `0027` criadas/aplicadas no Supabase atual.

## Ultimos Commits Relevantes

- `e35ca31 feat(atendente): Sprint 6.9 restante — nota interna Chatwoot ao escalar`
- `193b4ef feat(dispatcher): Sprint 6.8 — filtrar sender_type`
- `79c0d19 feat(atendente): Sprint 6.7 — Say Validator endurecido`
- `63e40e8 feat(atendente): Sprints 6.5 + 6.6 — loop de estado e bridge Organizadora`
- `56dfc0e feat: tune organizadora prompt v3.4`
- `866bae6 feat: add atendente generator shadow (sprint 6)`

Remotes sincronizados:

- `origin/main`
- `pneus/main`

## Proxima Fase Recomendada

Sprint 7: Critic Shadow da Atendente.
- Segundo passe LLM avalia candidato do Generator; bloqueia ou aprova.
- Nao envia ao Chatwoot no Critic.
- Agora pode seguir porque a memoria operacional do Generator foi calibrada.
- Deve priorizar bloqueio de claims sem lastro detectados no run multi-turn:
  disponibilidade de marca/produto, politica/prazo de entrega e fallback
  generico de escalacao quando ha resposta util segura.

Sprint 6.10 (bloqueado por dados): seed catalogo `commerce.*`.
- `commerce.products`, `tire_specs`, `vehicle_fitments` estao vazios; `buscar_e_ofertar` retorna lista vazia.
- Desbloqueio: trazer CSV/dump real da loja.

Sprint 8: envio controlado ao Chatwoot.
- `ChatwootApiClient.postMessage()` + worker envia turn `generated` aprovado.
- Controlado por `ATENDENTE_SEND_ENABLED=false` (default off).

## Cuidados

- Nao limpar nem reverter arquivos que o usuario criou sem revisar.
- Nao recriar scripts com token, connection string, endpoint real ou dados
  operacionais sensiveis hardcoded. Use `.env` local.
- `.env` e `.env.codex` nunca devem ser commitados.
- `ATENDENTE_SHADOW_ENABLED` pode rodar em log-only; envio Chatwoot continua
  inexistente/desligado ate Wallace mandar ativar explicitamente.
