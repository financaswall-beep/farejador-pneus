-- ============================================================
-- 0101_drop_organizadora_dead_tables.sql
-- FASE 2 da limpeza da Organizadora (V1). Remove 2 tabelas ÓRFÃS e VAZIAS.
--
-- Contexto: docs/MAPA_LIMPEZA_ORGANIZADORA_2026-06-14.md (+ FASE 1 commit 4746fc7).
-- A Organizadora (camada LLM do V1) está morta; o analytics que funciona é o
-- motor de regras determinístico (src/enrichment), que NÃO é tocado aqui.
--
-- DROPA:
--   - analytics.customer_journey  → resíduo. A MV analytics.customer_journey_mv
--     (usada pelo bot em agent.ts) deriva de core.conversations, NÃO desta tabela.
--     Zero código usa a tabela. 0 linhas.
--   - ops.agent_incidents         → o gravador (logIncident) foi removido na FASE 1.
--     Zero código usa. 0 linhas.
--
-- NÃO TOCA (vivos):
--   - analytics.conversation_signals  → o enrich escreve (signals.repository) e lê
--     (classification.service). Fica.
--   - analytics.customer_journey_mv   → a MV continua (deriva de core).
--   - ops.enrichment_jobs             → já não existe em prod (nada a fazer).
--
-- Sem CASCADE de propósito: se algo inesperado depender, o DROP falha (seguro).
-- Aplicação com travas: scripts/aplicar-0101.cjs (BEGIN + checagens + ROLLBACK).
-- Assinatura: Orquestrador (Claude Opus 4.8) — banco, 2026-06-14
-- ============================================================

DROP TABLE IF EXISTS analytics.customer_journey;
DROP TABLE IF EXISTS ops.agent_incidents;
