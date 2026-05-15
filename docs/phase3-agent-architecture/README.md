# Fase 3 - Arquitetura Do Agente De Pneus

Status: arquitetura aprovada em camadas e parcialmente implementada.

Esta pasta guarda o desenho e o log da Fase 3. Os docs 01-21 continuam como
registro arquitetural; o estado vivo fica em `00-estado-de-implementacao.md`.

## Estado Atual Curto

- Organizadora LLM: em producao.
- Shadow Assistido: em andamento.
- Atendente Sprint 1: estado reentrante implementado.
- Atendente Sprint 2: tools deterministicas implementadas.
- Atendente Sprint 3: Planner foundation implementado.
- Atendente Sprint 4: Executor/guardrails implementados.
- Atendente Sprint 5: Worker Shadow implementado, desligado por default.
- Atendente Sprint 6: Generator Shadow implementado, ainda sem envio Chatwoot.
- PR 1 de hardening do Generator: turns bloqueados auditaveis e `update_draft`
  com metacampos/idempotencia.
- Catalogo tecnico de pneus `commerce.*`: populado no ambiente `test` auditado
  em 2026-05-14. Ver `docs/COMMERCE_CATALOG_STATUS.md`.

## Indice Principal

0. [Estado de implementacao](00-estado-de-implementacao.md)
1. [Visao geral](01-visao-geral.md)
2. [Principios operacionais](02-principios-operacionais.md)
3. [Mapa de dados](03-mapa-de-dados.md)
4. [Blocos do banco](04-blocos-do-banco.md)
5. [Fact ledger da Organizadora](05-fact-ledger-organizadora.md)
6. [Estado da Atendente](06-agent-state-atendente.md)
7. [Commerce e grafo veicular](07-commerce-grafo-veicular.md)
8. [Business intelligence](08-business-intelligence-data-king.md)
9. [Skills, Planner e validadores](09-skills-router-e-validadores.md)
10. [Plano de fases](10-plano-de-fases.md)
11. [Perguntas abertas historicas](11-perguntas-abertas.md)
12. [Context Builder e slot filling](12-context-builder-e-slot-filling.md)
13. [Fluxo de eventos e integracao](13-fluxo-de-eventos-e-integracao.md)
14. [Topologia de execucao](14-topologia-de-execucao.md)
15. [Shadow assistido](15-shadow-assisted-mode.md)
16. [Planejamento das tabelas em portugues](16-planejamento-tabelas-em-portugues.md)
17. [Mapa portugues -> ingles tecnico](17-mapa-portugues-ingles.md)
18. [Diagrama ER](18-diagrama-er.md)
19. [Guia de teste Chatwoot + Organizadora](19-guia-teste-chatwoot-organizadora.md)
20. [Analytics marts v1](20-analytics-marts-v1.md)
21. [Atendente v1 state design](21-atendente-v1-state-design.md)

## Regra Operacional

Nada da Atendente deve enviar mensagem ao cliente ate Wallace autorizar. As
proximas sprints devem continuar em shadow/log-only.
