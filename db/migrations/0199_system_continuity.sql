-- ============================================================
-- 0199_system_continuity.sql
-- Continuidade: calendario unico, marcador canônico, retenção e partições.
-- ============================================================

BEGIN;

-- CURRENT_DATE segue a sessão do banco. O negócio inteiro fecha o calendário
-- em America/Sao_Paulo, independentemente do país do servidor PostgreSQL.
ALTER TABLE network.matriz_collaborator_compensation
  ALTER COLUMN starts_on SET DEFAULT ((now() AT TIME ZONE 'America/Sao_Paulo')::date);
ALTER TABLE network.matriz_collaborator_commission_rules
  ALTER COLUMN starts_on SET DEFAULT ((now() AT TIME ZONE 'America/Sao_Paulo')::date);

-- As três constraints foram criadas NOT VALID para permitir rollout seguro.
-- A auditoria pré-0199 confirmou zero violação; a validação torna a proteção
-- completa também para todo o histórico que permanecer após o go-live.
ALTER TABLE commerce.order_items
  VALIDATE CONSTRAINT order_items_discount_within_line_check;
ALTER TABLE commerce.wholesale_orders
  VALIDATE CONSTRAINT wholesale_orders_payment_dates_check;
ALTER TABLE network.commission_entries
  VALIDATE CONSTRAINT commission_entries_partner_order_fk;

-- Fonte canônica pertencente ao Farejador. Não altera nem tenta reconstruir o
-- rastreador interno do Supabase, cujo histórico antigo foi aplicado por mais
-- de um executor. O runtime consulta este marcador antes de aceitar tráfego.
CREATE TABLE IF NOT EXISTS ops.application_schema_state (
  singleton      BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
  version        INTEGER NOT NULL CHECK (version > 0),
  migration_name TEXT NOT NULL CHECK (length(btrim(migration_name)) > 0),
  applied_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

REVOKE ALL ON ops.application_schema_state FROM PUBLIC;

CREATE INDEX IF NOT EXISTS partner_sessions_retention_idx
  ON network.partner_sessions(expires_at);
CREATE INDEX IF NOT EXISTS matriz_staff_sessions_retention_idx
  ON network.matriz_staff_sessions(expires_at);
CREATE INDEX IF NOT EXISTS meta_sync_runs_retention_idx
  ON marketing.meta_sync_runs(finished_at)
  WHERE finished_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS atendente_dead_letters_retention_idx
  ON ops.atendente_dead_letters(resolved_at)
  WHERE resolved_at IS NOT NULL;

-- Conserva trilhas de negócio e todos os raw_events. Só remove resíduos
-- operacionais cujo ciclo já terminou: sessões vencidas, execuções de cron,
-- syncs antigos concluídos e dead letters já resolvidas.
CREATE OR REPLACE FUNCTION ops.perform_operational_retention(
  p_now TIMESTAMPTZ DEFAULT now()
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,ops,network,marketing
AS $function$
DECLARE
  partner_sessions_deleted INTEGER := 0;
  staff_sessions_deleted INTEGER := 0;
  cron_runs_deleted INTEGER := 0;
  meta_runs_deleted INTEGER := 0;
  dead_letters_deleted INTEGER := 0;
BEGIN
  DELETE FROM network.partner_sessions
   WHERE COALESCE(revoked_at,expires_at) < p_now-interval '30 days';
  GET DIAGNOSTICS partner_sessions_deleted=ROW_COUNT;

  DELETE FROM network.matriz_staff_sessions
   WHERE COALESCE(revoked_at,expires_at) < p_now-interval '30 days';
  GET DIAGNOSTICS staff_sessions_deleted=ROW_COUNT;

  IF to_regclass('cron.job_run_details') IS NOT NULL THEN
    EXECUTE $sql$
      DELETE FROM cron.job_run_details
       WHERE COALESCE(end_time,start_time) < $1-interval '30 days'
    $sql$ USING p_now;
    GET DIAGNOSTICS cron_runs_deleted=ROW_COUNT;
  END IF;

  DELETE FROM marketing.meta_sync_runs
   WHERE status IN ('succeeded','failed')
     AND finished_at < p_now-interval '365 days';
  GET DIAGNOSTICS meta_runs_deleted=ROW_COUNT;

  DELETE FROM ops.atendente_dead_letters
   WHERE resolved_at < p_now-interval '180 days';
  GET DIAGNOSTICS dead_letters_deleted=ROW_COUNT;

  RETURN jsonb_build_object(
    'partner_sessions',partner_sessions_deleted,
    'matriz_staff_sessions',staff_sessions_deleted,
    'cron_job_runs',cron_runs_deleted,
    'meta_sync_runs',meta_runs_deleted,
    'resolved_dead_letters',dead_letters_deleted
  );
END;
$function$;

REVOKE ALL ON FUNCTION ops.perform_operational_retention(TIMESTAMPTZ) FROM PUBLIC;

-- Mantém sete meses prontos agora e renova três meses à frente todo dia 20.
SELECT * FROM ops.ensure_monthly_partitions(6);
SELECT cron.schedule(
  'farejador-ensure-partitions',
  '0 3 20 * *',
  $$ SELECT ops.ensure_monthly_partitions(3) $$
);
SELECT cron.schedule(
  'farejador-operational-retention',
  '30 4 * * *',
  $$ SELECT ops.perform_operational_retention() $$
);

INSERT INTO ops.application_schema_state(singleton,version,migration_name,applied_at)
VALUES (true,199,'0199_system_continuity.sql',now())
ON CONFLICT (singleton) DO UPDATE
SET version=EXCLUDED.version,
    migration_name=EXCLUDED.migration_name,
    applied_at=EXCLUDED.applied_at;

COMMIT;
