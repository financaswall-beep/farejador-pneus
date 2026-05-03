# Briefing Para Codex - Farejador

Atualizado: 2026-05-03.

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
- `src/atendente/worker.ts` - Worker Shadow log-only.
- `src/shared/deterministic-id.ts` - UUID deterministico para eventos.

Desligado/inexistente:

- Worker Shadow existe, mas fica desligado por default
  (`ATENDENTE_SHADOW_ENABLED=false`).
- Generator.
- Critic.
- Envio Chatwoot.

## Principio De Arquitetura

Flexivel no funil, rigida na verdade:

- O funil nao e uma escada linear; e slot-filling reentrante.
- Planner escolhe skill/tool_requests de forma controlada.
- Dados factuais vem de tools deterministicas.
- Validators bloqueiam fala/acao sem lastro.
- Tudo grava ledger auditavel.

## Proxima Tarefa Sugerida

Sprint 6: criar Generator shadow da Atendente, sem envio Chatwoot.

Escopo esperado:

- receber contexto/plano/resultados de tools;
- gerar texto candidato sem enviar;
- validar com `SayValidator`/`ActionValidator`;
- gravar auditoria shadow;
- manter fallback seguro quando faltar dado;
- nao enviar mensagem para Chatwoot.

## Comandos De Validacao

```bash
npm test
npm run typecheck
npm run build
```

Ultima validacao conhecida:

- `npm test`: 267/267 verde
- `npm run typecheck`: verde
- `npm run build`: verde

## Arquivos De Estado

- `docs/NEXT_CHAT_HANDOFF.md`
- `docs/HANDOFF.md`
- `docs/phase3-agent-architecture/00-estado-de-implementacao.md`
- `docs/phase3-agent-architecture/21-atendente-v1-state-design.md`
- `db/migrations/README.md`
