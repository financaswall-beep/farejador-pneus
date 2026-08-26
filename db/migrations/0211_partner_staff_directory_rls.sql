-- 0211_partner_staff_directory_rls.sql
-- Diretório mínimo de colaboradores para o painel parceiro e o desempenho.
-- A role restrita continua sem SELECT nas credenciais: recebe somente EXECUTE
-- numa função escopada pela unidade plantada em app.partner_unit_id.

CREATE OR REPLACE FUNCTION network.partner_staff_directory()
RETURNS TABLE (
  id UUID,
  name TEXT,
  active BOOLEAN,
  job_role TEXT,
  role_name TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, network, public
AS $function$
  SELECT pat.id,
         COALESCE(NULLIF(btrim(pat.label),''),'Colaborador')::TEXT name,
         (pat.revoked_at IS NULL) active,
         pat.job_role::TEXT,
         CASE pat.job_role
           WHEN 'vendedor' THEN 'Vendedor'
           WHEN 'estoque' THEN 'Estoque'
           WHEN 'entregador' THEN 'Entregador'
           ELSE 'Colaborador'
         END::TEXT role_name
    FROM network.partner_access_tokens pat
    JOIN network.partner_units pu
      ON pu.id=pat.partner_unit_id AND pu.environment=pat.environment
   WHERE network.current_partner_unit() IS NOT NULL
     AND pat.partner_unit_id=network.current_partner_unit()
     AND pat.environment=pu.environment
     AND pat.role='funcionario'
   ORDER BY pat.revoked_at IS NOT NULL,name;
$function$;

COMMENT ON FUNCTION network.partner_staff_directory() IS
  '0211: diretório mínimo da equipe da unidade corrente; não expõe usuário, credencial, remuneração, comissão ou permissões.';

REVOKE ALL ON FUNCTION network.partner_staff_directory() FROM PUBLIC;

DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='farejador_partner_app') THEN
    GRANT EXECUTE ON FUNCTION network.partner_staff_directory()
      TO farejador_partner_app;
  END IF;
END;
$grant$;

DO $smoke$
DECLARE
  v_security_definer BOOLEAN;
BEGIN
  SELECT p.prosecdef INTO v_security_definer
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='network' AND p.proname='partner_staff_directory'
     AND p.pronargs=0;
  IF v_security_definer IS DISTINCT FROM true THEN
    RAISE EXCEPTION '0211: partner_staff_directory precisa ser SECURITY DEFINER';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='farejador_partner_app')
     AND has_table_privilege(
       'farejador_partner_app','network.partner_access_tokens','SELECT'
     ) THEN
    RAISE EXCEPTION '0211: role restrita não pode ler credenciais diretamente';
  END IF;
END;
$smoke$;
