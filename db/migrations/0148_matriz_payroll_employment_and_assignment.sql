-- 0148 - Folha respeita a vigencia do vinculo e fecha somente com eventos
-- comissionaveis atribuidos a vendedor/entregador.

CREATE OR REPLACE FUNCTION finance.matriz_collaborator_in_competence(
  p_created_at TIMESTAMPTZ,
  p_revoked_at TIMESTAMPTZ,
  p_competence DATE
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $fn$
  SELECT
    (p_created_at AT TIME ZONE 'America/Sao_Paulo')::date
      < (p_competence + interval '1 month')::date
    AND (
      p_revoked_at IS NULL
      OR (p_revoked_at AT TIME ZONE 'America/Sao_Paulo')::date >= p_competence
    )
$fn$;

CREATE OR REPLACE FUNCTION finance.matriz_payroll_assignment_gaps(
  p_environment env_t,
  p_competence DATE
)
RETURNS TABLE(event_type TEXT, missing_count INTEGER)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, finance, commerce, network, core
AS $fn$
  WITH events AS (
    SELECT 'sale'::text AS event_type,
           (o.created_at AT TIME ZONE 'America/Sao_Paulo')::date AS event_date
      FROM commerce.orders o
      JOIN core.units u
        ON u.id=o.unit_id AND u.environment=o.environment AND u.slug='main'
     WHERE o.environment=p_environment
       AND o.status<>'cancelled'
       AND o.seller_collaborator_id IS NULL
       AND (o.created_at AT TIME ZONE 'America/Sao_Paulo')::date>=p_competence
       AND (o.created_at AT TIME ZONE 'America/Sao_Paulo')::date
         <(p_competence+interval '1 month')::date
    UNION ALL
    SELECT 'sale',
           (o.created_at AT TIME ZONE 'America/Sao_Paulo')::date
      FROM commerce.wholesale_orders o
     WHERE o.environment=p_environment
       AND o.status='confirmed'
       AND o.seller_collaborator_id IS NULL
       AND (o.created_at AT TIME ZONE 'America/Sao_Paulo')::date>=p_competence
       AND (o.created_at AT TIME ZONE 'America/Sao_Paulo')::date
         <(p_competence+interval '1 month')::date
    UNION ALL
    SELECT 'delivery',
           (o.delivered_at AT TIME ZONE 'America/Sao_Paulo')::date
      FROM commerce.orders o
      LEFT JOIN commerce.matriz_delivery_trips t
        ON t.id=o.trip_id AND t.environment=o.environment AND t.deleted_at IS NULL
     WHERE o.environment=p_environment
       AND o.status<>'cancelled'
       AND o.delivery_status='delivered'
       AND o.delivered_at IS NOT NULL
       AND t.courier_collaborator_id IS NULL
       AND (o.delivered_at AT TIME ZONE 'America/Sao_Paulo')::date>=p_competence
       AND (o.delivered_at AT TIME ZONE 'America/Sao_Paulo')::date
         <(p_competence+interval '1 month')::date
    UNION ALL
    SELECT 'trip',
           (t.ended_at AT TIME ZONE 'America/Sao_Paulo')::date
      FROM commerce.matriz_delivery_trips t
     WHERE t.environment=p_environment
       AND t.deleted_at IS NULL
       AND t.status='closed'
       AND t.ended_at IS NOT NULL
       AND t.courier_collaborator_id IS NULL
       AND commerce.matriz_trip_financial_status(t.id,t.environment)='reconciled'
       AND (t.ended_at AT TIME ZONE 'America/Sao_Paulo')::date>=p_competence
       AND (t.ended_at AT TIME ZONE 'America/Sao_Paulo')::date
         <(p_competence+interval '1 month')::date
  )
  SELECT e.event_type,count(*)::int
    FROM events e
   WHERE EXISTS (
     SELECT 1
       FROM network.matriz_collaborators mc
       JOIN LATERAL (
         SELECT r.basis,r.active
           FROM network.matriz_collaborator_commission_rules r
          WHERE r.environment=mc.environment
            AND r.collaborator_id=mc.id
            AND r.starts_on<=e.event_date
          ORDER BY r.starts_on DESC
          LIMIT 1
       ) rule ON true
      WHERE mc.environment=p_environment
        AND finance.matriz_collaborator_in_competence(
          mc.created_at,mc.revoked_at,p_competence)
        AND rule.active
        AND (
          (e.event_type='sale' AND rule.basis IN ('margin','revenue','sale'))
          OR (e.event_type='delivery' AND rule.basis='delivery')
          OR (e.event_type='trip' AND rule.basis='trip')
        )
   )
   GROUP BY e.event_type
   ORDER BY e.event_type
$fn$;

REVOKE ALL ON FUNCTION finance.matriz_collaborator_in_competence(
  TIMESTAMPTZ,TIMESTAMPTZ,DATE) FROM PUBLIC;
REVOKE ALL ON FUNCTION finance.matriz_payroll_assignment_gaps(
  env_t,DATE) FROM PUBLIC;

DO $security$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='farejador_partner_app') THEN
    REVOKE ALL ON FUNCTION finance.matriz_collaborator_in_competence(
      TIMESTAMPTZ,TIMESTAMPTZ,DATE) FROM farejador_partner_app;
    REVOKE ALL ON FUNCTION finance.matriz_payroll_assignment_gaps(
      env_t,DATE) FROM farejador_partner_app;
  END IF;
END
$security$;

COMMENT ON FUNCTION finance.matriz_payroll_assignment_gaps(env_t,DATE) IS
  '0148: eventos comissionaveis sem vendedor/entregador que bloqueiam o fechamento da competencia.';
