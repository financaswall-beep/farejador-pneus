# Briefing Para Codex - Farejador

Atualizado: 2026-05-08.

## Leitura Rapida

Voce esta no repo `C:\Farejador agente`. Responda em portugues brasileiro.

O projeto ja passou da captura basica: webhook, normalizacao, enrichment,
Organizadora LLM, Worker Shadow da Atendente e fundacao de estado/tools/planner
estao implementados. O bot ainda nao responde clientes.

## Estado Da Atendente

Implementado:

- `src/atendente/state/*` - `applyAction`, estado reentrante e validators.
- `src/atendente/tools/commerce-tools.ts` - tools deterministicas.
- `src/atendente/planner/*` - Context Builder, Planner schemas/service/prompt.
- `src/atendente/executor/*` - executor de tools.
- `src/atendente/validators/*` - validacao inicial de fala/acoes.
- `src/atendente/worker.ts` - Worker Shadow com loop de estado e Generator.
- `src/atendente/generator/service.ts` - Generator Shadow (LLM real em prod).
- `src/atendente/handlers/escalate.ts` - nota interna Chatwoot ao escalar.
- `src/admin/chatwoot-api.client.ts` - cliente HTTP Chatwoot com retry.
- `src/shared/deterministic-id.ts` - UUID deterministico para eventos.
- Sprint 6.5: loop de estado (applyActionAndPersistInTx).
- Sprint 6.6: bridge Organizadora -> Context Builder (organizer_facts).
- Sprint 6.7: Say Validator endurecido (bloqueia claims sem evidencia).
- Sprint 6.8: filtro sender_type no dispatcher (so contact).
- Sprint 6.9: nota interna Chatwoot ao escalar (private: true, fora da tx).
- Ajuste pre-Critic: Generator calibrado para emitir memoria operacional em
    tempo real (`create_item`, `update_slot`, `update_draft`) e recebe
    `state.items` + `organizer_facts` no contexto.
- PR 1 Generator audit: turns bloqueados preservam candidato em
    `blocked_say_text`/`blocked_payload`; `update_draft` agora tem
    `action_id` e demais metacampos obrigatorios.
- PR 2 Estado/contexto: Context Builder usa limite configuravel
    `ATENDENTE_CONTEXT_MESSAGES_LIMIT` (default 20), `loadCurrent` popula
    `derived_signals.stale_slots`, e troca de item/slots comerciais invalida
    oferta antiga.
- PR 3 Validators/eventos: Action Validator bloqueia carrinho/draft/escalacao
    sem pre-condicao; `session_events` usa eventos semanticos de carrinho/draft;
    `update_cart_item` grava `updated` em `agent.cart_events`.
- Generator `generator_v1.3.2`: reforca fechamento seguro. Quando cliente passa
    nome/pagamento/endereco ou diz "pode fechar", deve emitir `update_draft`
    mesmo sem estoque confirmado, e responder que um atendente confirmara
    produto/estoque antes de fechar.

Desligado/inexistente:

- Worker Shadow desligado por default (`ATENDENTE_SHADOW_ENABLED=false`),
  habilitado em producao atual.
- Critic.
- Envio de mensagem ao cliente (ATENDENTE_SEND_ENABLED inexistente).

## Principio De Arquitetura

Flexivel no funil, rigida na verdade:

- O funil nao e uma escada linear; e slot-filling reentrante.
- Planner escolhe skill/tool_requests de forma controlada.
- Dados factuais vem de tools deterministicas.
- Validators bloqueiam fala/acao sem lastro.
- Tudo grava ledger auditavel.

## Proxima Tarefa Sugerida

Proximo lote recomendado: PR 4 de Organizadora/ops, depois do deploy e smoke
LLM do PR 3.

Escopo:

- Bug 11: lease/reclaim em `ops.enrichment_jobs`.
- Bug 12: magic numbers para env.
- Bug 13: decisao/documentacao sobre mensagem editada em evidence.

Alternativa imediata se dados disponiveis:

Sprint 6.10: seed catalogo `commerce.*` (products, tire_specs, vehicle_fitments).

## Comandos De Validacao

```bash
npm test
npm run typecheck
npm run build
```

Ultima validacao conhecida:

- `npm test`: 380/380 verde, 51 arquivos
- `npm run typecheck`: verde
- `npx vitest run --config vitest.integration.config.ts tests/integration/atendente-state-persistence.integration.test.ts`: 8/8 verde
- `npm run build`: verde
- Smoke LLM real (2026-05-08) via Chatwoot fake `pr12-chatwoot-1778211526899`:
  Organizadora + Planner + Generator rodaram em shadow; 15 facts salvos,
  Planner `planner_v1.2.5`, Generator `generator_v1.3.1`, 13 mensagens no
  contexto da conversa e 0 envio ao cliente.
- Nota qualitativa do smoke: Organizadora 9/10, Planner 9/10, Generator 8/10,
  fluxo geral 8,7/10. Não considerar como certificação completa: ainda falta
  smoke de bloqueio proposital para `blocked_say_text`.
- Smoke PR3 pos-deploy (2026-05-08, Chatwoot conversa `452`): Organizadora
  salvou 12 facts, Planner LLM `planner_v1.2.5` usou tools comerciais, Generator
  rodou em shadow e bloqueou 1 turno com `stock_claim_without_verificar_estoque`,
  preservando `blocked_say_text`. Nao houve envio ao cliente. O smoke nao emitiu
  `update_draft`, entao `draft_updated` ficou validado pelos testes
  deterministico/integracao.
- Ajuste pos-smoke: `generator_v1.3.2` cobre essa lacuna. Teste unitario novo
  simula "pode fechar no pix, meu nome e Joao, entrega..." e exige
  `update_draft` completo sem claim de estoque.

## Arquivos De Estado

- `docs/NEXT_CHAT_HANDOFF.md`
- `docs/HANDOFF.md`
- `docs/phase3-agent-architecture/00-estado-de-implementacao.md`
- `docs/phase3-agent-architecture/21-atendente-v1-state-design.md`
- `db/migrations/README.md`
