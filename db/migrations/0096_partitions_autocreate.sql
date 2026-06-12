-- ============================================================
-- 0096 — Partições automáticas (auditoria 360° de 2026-06-12)
-- ------------------------------------------------------------
-- A função ops.ensure_monthly_partitions existe desde a 0006,
-- mas o agendamento ficou só em comentário. Partições de
-- raw.raw_events e core.messages existiam apenas até 2026_06:
-- em 2026-07-01 o INSERT do webhook falharia e a ingestão cairia.
--
-- (1) Cria já as partições dos próximos 6 meses (jul→dez/2026).
-- (2) Agenda pg_cron mensal (dia 20, 03:00 UTC, 3 meses à frente)
--     — cron.schedule com o mesmo nome atualiza o job (idempotente).
-- ============================================================

SELECT * FROM ops.ensure_monthly_partitions(6);

SELECT cron.schedule(
  'farejador-ensure-partitions',
  '0 3 20 * *',
  $$ SELECT ops.ensure_monthly_partitions(3) $$
);
