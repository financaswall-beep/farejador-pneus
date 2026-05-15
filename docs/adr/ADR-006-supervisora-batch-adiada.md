# ADR-006 — Supervisora batch adiada para Fase G

Data: 2026-05-10
Status: Aceita

## Contexto

A Supervisora batch foi proposta como auditora qualitativa pos-fato dos turnos do agente — uma LLM que revisa cada turno (`agent.turns.status='generated'`) e atribui nota, motivo e sugestao de correcao em `ops.supervisor_reviews`.

Em discussoes anteriores (entre 2026-05-08 e 2026-05-10), considerou-se trazer a Supervisora para Sprint 7 imediato, no slot deixado vago pelo descarte do Critic (ADR-005). O plano detalhado chegou a ser desenhado em `C:\Users\Casa1\.claude\plans\vc-acha-necesario-ou-dynamic-hennessy.md` com schema `ops.supervisor_reviews`, fila dedicada `ops.supervisor_jobs`, vocabulario `ops.supervisor_reason_codes`, append-only seletivo, cron de enfileiramento.

Em 2026-05-10, ao reler o roadmap original (`10-plano-de-fases.md` Fase G "Supervisora opcional") e cruzar com o estado real do projeto, ficou claro que:

1. Supervisora calibrada em shadow agora vai julgar turnos sem ground truth de venda (0 pedidos efetivados, 0 `delivered_message_id`).
2. Sem dataset humano (Wallace atendendo por 2-4 semanas), a Supervisora seria calibrada em vazio.
3. ATENDENTE_SEND_ENABLED ainda nao existe — agente nunca enviou ao cliente. Distribuicao de erro shadow ≠ producao.
4. Supervisora seria construida para um problema que ainda nao existe na escala real.

## Decisao

**Supervisora batch fica adiada para Fase G original** (depois de Sprint 8 maduro), conforme `10-plano-de-fases.md` desde o desenho original.

NAO e proximo passo. NAO ocupa Sprint 7.

O plano detalhado em `C:\Users\Casa1\.claude\plans\vc-acha-necesario-ou-dynamic-hennessy.md` fica preservado como referencia futura, mas pausado ate Fase G.

## Razoes

1. **Calibracao precisa de ground truth.** Sem dataset humano + envio em producao, juiz LLM nao tem padrao para comparar.
2. **Custo desnecessario.** Calibrar Supervisora em shadow agora gasta dinheiro com LLM julgando coisa sem padrao de qualidade definido.
3. **Roadmap original estava certo.** Fase G era "possivel evolucao futura" justamente porque depende de fases anteriores maduras.
4. **Foco e mais valioso em outra frente.** Fase D estendida (Wallace atendendo + comparacao humano vs bot) gera o dataset que Supervisora precisaria para calibrar.

## Quando entrar (criterios de unblock)

Supervisora batch sera reconsiderada quando:

- Sprint 8 (envio Chatwoot) estiver ligado e maduro.
- Houver pelo menos 200 conversas reais com cliente (envio entregue).
- Volume justifique: revisao humana manual nao escala (por exemplo, >30 atendimentos automatizados/dia).
- Houver dataset humano ja consolidado da Fase D estendida para calibrar prompt da Supervisora.

## Consequencias

Positivas:
- Foco nao se dispersa em construir juiz prematuro.
- Recursos vao para popular catalogo, coleta humana e blocos de infra.
- Quando Supervisora entrar, sera com material real e expectativa clara.

Negativas:
- Durante Fase D estendida, qualidade qualitativa do shadow do bot depende de revisao manual humano vs bot. Mitigacao: rotina deterministica simples de comparacao (ADR-008), sem LLM.
- Quando Sprint 8 ligar, primeiros 200 atendimentos rodam sem juiz automatico. Mitigacao: escopo restrito (1 vendedor de plantao + fallback humano).

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

- ADR-005: Critic descartado
- ADR-007: SayValidator + ActionValidator como gate sincrono
- ADR-008: Fase D estendida como proximo passo

## Plano detalhado preservado

`C:\Users\Casa1\.claude\plans\vc-acha-necesario-ou-dynamic-hennessy.md` contem o desenho completo da Supervisora batch (schema, fila, vocabulario, cron). Esse plano fica congelado e sera reaberto quando Fase G iniciar.
