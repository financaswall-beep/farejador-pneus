-- Migration 0049 — 2026-05-24
--
-- Adiciona coluna rationale_text em agent.turns pra persistir a justificativa
-- textual que o LLM Generator devolve a cada turn. Hoje o rationale eh
-- exigido pelo schema (z.string().min(1).max(800)) mas eh descartado apos
-- a validacao — auditoria pos-fato fica cega. Sem essa coluna, nao da pra
-- responder "por que o LLM decidiu X" depois.
--
-- NULLABLE pq turns historicos nao tem o dado. Backfill nao faz sentido
-- (o rationale eh produto do LLM no turn, nao algo derivavel do estado).

ALTER TABLE agent.turns
  ADD COLUMN IF NOT EXISTS rationale_text TEXT;

COMMENT ON COLUMN agent.turns.rationale_text IS
  'Justificativa textual do LLM Generator (campo `rationale` do output). '
  'Preenchido a partir do GeneratorResult quando blocked=false ou quando '
  'havia candidato auditavel mesmo blocked. NULL em turns legados pre-0049.';
