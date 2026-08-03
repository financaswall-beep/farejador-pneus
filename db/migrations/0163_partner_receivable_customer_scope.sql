-- 0163 - Impede IDOR/BOLA no customer_id de contas a receber do parceiro.
--
-- O FK historico de finance.partner_receivables(customer_id) valida apenas o
-- UUID. Ele nao prova que o cliente pertence ao mesmo environment + unit_id da
-- conta. A aplicacao passa a validar antes da escrita e este trigger fecha a
-- mesma invariante no banco para qualquer caminho presente ou futuro.

-- Fail-safe, sem corrigir dado silenciosamente: uma divergencia historica deve
-- ser revisada antes do deploy. Como cada migration roda transacionalmente, este
-- erro nao deixa a protecao instalada pela metade.
DO $preflight$
DECLARE
  v_mismatches integer;
BEGIN
  SELECT count(*)::integer
    INTO v_mismatches
    FROM finance.partner_receivables pr
    JOIN commerce.partner_customers pc ON pc.id = pr.customer_id
   WHERE pr.customer_id IS NOT NULL
     AND (pc.environment IS DISTINCT FROM pr.environment
       OR pc.unit_id IS DISTINCT FROM pr.unit_id);

  IF v_mismatches > 0 THEN
    RAISE EXCEPTION
      '0163 bloqueada: % conta(s) a receber vinculada(s) a cliente de outro ambiente/unidade',
      v_mismatches;
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION finance.enforce_partner_receivable_customer_scope()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, finance, commerce
AS $function$
BEGIN
  IF NEW.customer_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM commerce.partner_customers pc
     WHERE pc.id = NEW.customer_id
       AND pc.environment = NEW.environment
       AND pc.unit_id = NEW.unit_id
  ) THEN
    -- A mensagem nao diferencia UUID inexistente ou de outra unidade.
    RAISE EXCEPTION 'partner_receivable_customer_scope_mismatch'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION finance.enforce_partner_receivable_customer_scope()
  FROM PUBLIC;

DROP TRIGGER IF EXISTS partner_receivables_customer_scope
  ON finance.partner_receivables;
CREATE TRIGGER partner_receivables_customer_scope
  BEFORE INSERT OR UPDATE OF environment, unit_id, customer_id
  ON finance.partner_receivables
  FOR EACH ROW
  EXECUTE FUNCTION finance.enforce_partner_receivable_customer_scope();

COMMENT ON FUNCTION finance.enforce_partner_receivable_customer_scope() IS
  '0163: customer_id de conta a receber deve ser cliente do mesmo environment e unit_id; inexistente e outra unidade falham de forma indistinguivel.';

DO $postcheck$
DECLARE
  v_trigger_count integer;
  v_security_definer boolean;
BEGIN
  SELECT count(*)::integer
    INTO v_trigger_count
    FROM pg_trigger
   WHERE tgrelid = 'finance.partner_receivables'::regclass
     AND tgname = 'partner_receivables_customer_scope'
     AND NOT tgisinternal;

  SELECT p.prosecdef
    INTO v_security_definer
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'finance'
     AND p.proname = 'enforce_partner_receivable_customer_scope'
     AND p.pronargs = 0;

  IF v_trigger_count <> 1 THEN
    RAISE EXCEPTION '0163 falhou: trigger de escopo nao instalado';
  END IF;
  IF v_security_definer IS DISTINCT FROM false THEN
    RAISE EXCEPTION '0163 falhou: trigger function nao deve usar SECURITY DEFINER';
  END IF;
END
$postcheck$;
