# Briefing Para Codex - Farejador

Atualizado: 2026-05-05.

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

Sprint 7: Critic Shadow da Atendente.

Escopo:

- avaliar resposta candidata do Generator antes de qualquer envio;
- bloquear ou aprovar com motivo auditavel;
- gravar auditoria em `agent.*`/`ops.*`;
- nao enviar mensagem para Chatwoot nesta sprint.

Alternativa imediata se dados disponiveis:

Sprint 6.10: seed catalogo `commerce.*` (products, tire_specs, vehicle_fitments).

## Comandos De Validacao

```bash
npm test
npm run typecheck
npm run build
```

Ultima validacao conhecida:

- `npm test`: 316/316 verde, 49 arquivos
- `npm run typecheck`: verde
- `npm run build`: verde

## Arquivos De Estado

- `docs/NEXT_CHAT_HANDOFF.md`
- `docs/HANDOFF.md`
- `docs/phase3-agent-architecture/00-estado-de-implementacao.md`
- `docs/phase3-agent-architecture/21-atendente-v1-state-design.md`
- `db/migrations/README.md`
