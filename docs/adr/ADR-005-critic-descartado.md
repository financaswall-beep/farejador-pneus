# ADR-005 — Critic em tempo real descartado permanentemente

Data: 2026-05-10
Status: Aceita

## Contexto

ADR-004 (linha 94) planejava um "Critic LLM" como segundo passe LLM apos o Generator, sincronizo, com poder de bloquear envio ao cliente. Esse componente foi listado como Sprint 7 em multiplos documentos (`00-estado-de-implementacao.md`, `CHECKLIST.md`, `HANDOFF.md`, `NEXT_CHAT_HANDOFF.md`, `CODEX_BRIEFING.md`, `PROJECT.md`).

Em paralelo, durante Sprints 6.7 a 6.9 e PR1 a PR5 (de 2026-05-04 a 2026-05-10), foram implementados e validados:

- **SayValidator** (`src/atendente/validators/say-validator.ts`): bloqueia claims sem evidencia (estoque, marca, prazo, compatibilidade, desconto, brinde, oferta custom, dinheiro mencionado sem tool result).
- **ActionValidator** (`src/atendente/validators/action-validator.ts`): valida pre-condicoes de carrinho/draft/escalacao, idempotencia, scope de slots, item not found, etc.

PR5 foi validado em smoke LLM real em conversas Chatwoot `470`-`473` em 2026-05-10: 6 turnos seguros + 2 bloqueados, com `blocked_say_text` preservado. SayValidator + ActionValidator sao o gate sincrono pre-envio na pratica.

## Decisao

**Critic em tempo real esta descartado permanentemente.** Nao sera implementado.

SayValidator + ActionValidator sao oficialmente o gate sincrono pre-envio Chatwoot.

Sprint 7 deixa de existir como "Critic". O slot de Sprint 7 pode ser usado para outra coisa quando relevante (Fase D estendida, ver ADR-008).

## Razoes

1. **Cobertura ja existe.** SayValidator cobre os bloqueios criticos validados em prod (claims sem lastro, money mismatch, brinde sem politica, etc.).
2. **Custo de latencia.** Critic seria um segundo passe LLM no caminho sincrono — adicionaria 2-5s a cada resposta antes do envio. Inaceitavel.
3. **Custo financeiro.** Cada turno teria 2x chamadas LLM (Generator + Critic), dobrando custo OpenAI sem ganho proporcional.
4. **Material de auditoria preservado.** Turnos bloqueados pelo SayValidator preservam candidato em `agent.turns.blocked_say_text/blocked_actions/blocked_payload` (PR1, migration 0028). Auditoria de qualidade nao depende de Critic.
5. **Qualidade qualitativa pos-fato.** Para julgar tom, repeticao, playbook drift, missed question — coisas que regra estatica nao pega — a solucao certa e Supervisora batch (assincrono, sem latencia critica), nao Critic em tempo real. Ver ADR-006.

## Consequencias

Positivas:
- Latencia de resposta menor.
- Custo OpenAI menor.
- Menos codigo para manter.
- Foco em popular catalogo + Fase D estendida em vez de construir um Critic redundante.

Negativas:
- Sem segundo passe LLM, qualidade qualitativa em tempo real fica limitada ao que SayValidator/ActionValidator pegam.
- Mitigacao: Supervisora batch pos-fato (Fase G, ADR-006) + revisao humana de divergencias durante Fase D estendida.

## Documentos atualizados

- `docs/phase3-agent-architecture/00-estado-de-implementacao.md`
- `docs/CHECKLIST.md`
- `docs/HANDOFF.md`
- `docs/NEXT_CHAT_HANDOFF.md`
- `docs/CODEX_BRIEFING.md`
- `docs/phase3-agent-architecture/10-plano-de-fases.md`
- `docs/phase3-agent-architecture/11-perguntas-abertas.md`
- `docs/phase3-agent-architecture/14-topologia-de-execucao.md`
- `docs/phase3-agent-architecture/15-shadow-assisted-mode.md`
- `docs/PROJECT.md`

## Decisoes relacionadas

- ADR-004: arquitetura original da Fase 3 (substitui mencao a Critic)
- ADR-006: Supervisora batch adiada para Fase G
- ADR-007: SayValidator + ActionValidator como gate sincrono
- ADR-008: Fase D estendida como proximo passo
