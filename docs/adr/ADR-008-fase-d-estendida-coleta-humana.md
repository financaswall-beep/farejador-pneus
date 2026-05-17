# ADR-008 — Fase D estendida (coleta humana 2-4 semanas) como proximo passo

Data: 2026-05-10
Status: Aceita

Atualizacao 2026-05-14: o item "Popular catalogo" avancou parcialmente. O
ambiente `FAREJADOR_ENV=test` auditado tem catalogo tecnico de pneus com 50
produtos/specs, 138 modelos, 96 fitments oficiais e 84 discoveries pending.
Continuam pendentes preco, estoque real, marca comercial e fotos. Ver
`docs/COMMERCE_CATALOG_STATUS.md`.

## Contexto

O roadmap original (`10-plano-de-fases.md`) previa Fase D "Shadow Assistido" com Wallace atendendo manualmente por aproximadamente 5 semanas, agente em log-only, dados calibrando a automacao futura. Fase E ligaria a Atendente gradualmente; Fase G (Supervisora) era opcional.

Entre Sprints 1 a 6.9, a Atendente foi construida em camadas (estado reentrante, tools deterministicas, Planner, Executor, Worker Shadow, Generator Shadow). PRs 1 a 5 endureceram o sistema. SayValidator + ActionValidator viraram gate (ADR-007).

No estado atual (2026-05-10):
- 388 turns shadow em `agent.turns` (328 generated + 60 blocked).
- 0 entregues (`delivered_message_id` vazio em 100%).
- 322 conversas em `core.conversations`.
- 0 pedidos efetivados em `commerce.orders`.
- Catalogo `commerce.products` com 3 produtos.
- `ATENDENTE_SEND_ENABLED` nao existe.
- 6 blocos de infra pendentes (particoes futuras, LGPD endpoint, runbook, rate limit, RLS, migration history).

Decisoes 2026-05-10:
- Critic descartado (ADR-005).
- Supervisora batch adiada para Fase G (ADR-006).
- SayValidator + ActionValidator sao o gate (ADR-007).

A pergunta "qual o proximo passo?" precisava de resposta clara e registrada.

## Decisao

**Proximo passo: Fase D estendida — Wallace atende manualmente por 2-4 semanas adicionais, em paralelo com popular catalogo e resolver 6 blocos pequenos de infra.**

Componentes da Fase D estendida:

1. **Coleta humana ativa**
   - Wallace atende clientes normalmente no Chatwoot por 2-4 semanas.
   - Agente continua em shadow gerando candidato em `agent.turns`, sem envio.
   - Cada conversa atendida pelo Wallace e marcada como golden (mecanismo a definir: coluna em `core.conversations` ou tabela `ops.golden_conversations`).

2. **Comparacao humano vs bot (sem LLM)**
   - Rotina deterministica simples: para cada turno em que Wallace respondeu, mostra "cliente perguntou X, bot teria respondido Y, Wallace respondeu Z".
   - Sem LLM julgando — Supervisora batch ainda nao entra (ADR-006).
   - Wallace marca: concordo / discordo / parcial + nota livre.
   - Material vira dataset humano para calibrar prompt do Generator.

3. **Popular catalogo (Sprint 6.10) em paralelo**
   - Atualizacao 2026-05-14: seed tecnico de pneus populado no ambiente
     `test` auditado (50 produtos/specs, 138 modelos, 96 fitments oficiais,
     84 discoveries pending).
   - Ainda falta: preco, estoque real, marca comercial e fotos.
   - Desbloqueio: CSV/dump real da loja.

4. **6 blocos pequenos de infra paralela (~5-7 dias espalhados)**
   - **Particoes julho/agosto 2026** (urgente — antes de 30/jun). pg_partman NAO esta instalado; sera SQL manual ou cron proprio.
   - **Reconciliar migration history Supabase** (banco em 0030, CLI registra 0021) ou abandonar formalmente o CLI Supabase.
   - **LGPD minimo**: endpoint de erasure operacional + base legal documentada (`ops.erasure_log` ja existe como tabela).
   - **Runbook de desligamento de emergencia** (kill switch documentado).
   - **Rate limit / circuit breaker** de custo OpenAI (sem isso, cliente pode enfileirar 1000 mensagens em 10s e estourar conta).
   - **Auditoria RLS**: confirmar que so backend usa service_role (RLS off em 55+ tabelas e aceitavel apenas se nao ha anon_key vazando).

## Razoes

1. **Padrao de qualidade so existe via humano.** Bot calibrado por LLM julgando shadow sem dataset humano e bot calibrado contra abstracao. Wallace atendendo cria padrao real.
2. **Roadmap original ja previa.** Fase D era 5 semanas no plano original. Estamos estendendo com mecanismo de comparacao humano vs bot.
3. **Sem ground truth, nao da pra ligar envio.** 0 pedidos efetivados, 0 mensagens entregues. Ligar Sprint 8 sem dataset historico de "o que funciona" e roleta russa.
4. **Catalogo tecnico sem estoque/preco ainda bloqueia venda.** O catalogo
   tecnico ja existe no ambiente auditado, mas sem preco e estoque real o agente
   ainda nao pode vender de forma autonoma.
5. **Infra paralela barata.** 6 blocos pequenos espalhados durante 2-4 semanas nao competem com tempo do Wallace.

## Criterios de saida (quando Fase D estendida termina)

Fase D estendida termina e Sprint 8 pode iniciar quando:

- ≥30 conversas atendidas pelo Wallace e marcadas como golden.
- ≥200 turns shadow comparados humano vs bot, com taxa de concordancia >=60% nas respostas onde bot teria respondido algo nao-fallback.
- Catalogo `commerce.products` com >=30 produtos cobrindo as motos mais
  pedidas, com preco e estoque real carregados para os produtos vendaveis.
- Os 6 blocos de infra resolvidos (particoes, migration history, LGPD, runbook, rate limit, RLS).
- Wallace confirma que "o bot ja responderia razoavelmente nesse caso" para >=70% das golden.

## Consequencias

Positivas:
- Quando Sprint 8 ligar, sera com prompt calibrado em padrao real.
- Dataset humano fica como ativo permanente (few-shot examples + material de auditoria).
- Sistema fica auditavel — cada divergencia bot vs humano vira nota arquivada.
- Wallace mantem controle total durante o periodo: nada sai sem ele.

Negativas:
- 2-4 semanas adicionais de trabalho humano para Wallace.
- Mitigacao: ele ja atende essas conversas no dia a dia; o que muda e ter o agente em shadow + rotina de comparacao.

## Documentos atualizados

- `docs/phase3-agent-architecture/00-estado-de-implementacao.md`
- `docs/CHECKLIST.md`
- `docs/HANDOFF.md`
- `docs/NEXT_CHAT_HANDOFF.md`
- `docs/CODEX_BRIEFING.md`
- `docs/phase3-agent-architecture/10-plano-de-fases.md`
- `docs/PROJECT.md`

## Decisoes relacionadas

- ADR-005: Critic descartado
- ADR-006: Supervisora batch adiada para Fase G
- ADR-007: SayValidator + ActionValidator como gate sincrono

## Notas sobre implementacao da Fase D estendida

A implementacao concreta sera detalhada em handoff/plano separado quando iniciada. Esta ADR registra apenas a decisao arquitetural de prioridade.

Ideia preliminar para mecanismo de comparacao:
- Adicionar coluna `is_golden_reference boolean` em `core.conversations`, default false; trigger marca true quando ha mensagem com `sender_type='agent'` (humano via Chatwoot, nao bot).
- View `ops.human_vs_bot_comparison`: para cada `agent.turns` em conversa golden, junta com a mensagem humana mais proxima e mostra lado a lado.
- Endpoint admin ou query simples para Wallace marcar concordancia.
