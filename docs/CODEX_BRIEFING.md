# Briefing Para Codex - Farejador

Atualizado: 2026-05-07.

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

Proximo lote recomendado: PR 2 de estado/contexto. A migration 0028 ja foi
aplicada e o PR 1 esta pronto para rodar em shadow.

Escopo:

- Bug 8: limite de mensagens do Context Builder configuravel.
- Bug 16: popular `derived_signals.stale_slots`.
- Bug 1/Bug 6: invalidar oferta/slots quando cliente muda moto/medida/dados.

Alternativa imediata se dados disponiveis:

Sprint 6.10: seed catalogo `commerce.*` (products, tire_specs, vehicle_fitments).

## Comandos De Validacao

```bash
npm test
npm run typecheck
npm run build
```

Ultima validacao conhecida:

- `npm test`: 367/367 verde, 50 arquivos
- `npm run typecheck`: verde
- `npm run test:integration -- tests/integration/atendente-state-persistence.integration.test.ts`: 7/7 verde

## Arquivos De Estado

- `docs/NEXT_CHAT_HANDOFF.md`
- `docs/HANDOFF.md`
- `docs/phase3-agent-architecture/00-estado-de-implementacao.md`
- `docs/phase3-agent-architecture/21-atendente-v1-state-design.md`
- `db/migrations/README.md`
