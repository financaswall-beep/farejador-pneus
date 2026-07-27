-- 0145 - Despesa aprovada por comprovante nao pode ser removida e deixar
-- a rota com um vinculo terminal quebrado. Correcao de legado acontece por
-- restauracao explicita e auditada da mesma despesa, nunca trocando o vinculo.

CREATE OR REPLACE FUNCTION finance.protect_matriz_receipt_expense()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce
AS $fn$
BEGIN
  IF NEW.deleted_at IS NOT NULL
     AND OLD.deleted_at IS NULL
     AND EXISTS (
       SELECT 1
         FROM commerce.matriz_trip_receipts r
        WHERE r.environment = NEW.environment
          AND r.ai_expense_id = NEW.id
          AND r.workflow_status IN ('linked','legacy_linked')
     ) THEN
    RAISE EXCEPTION 'receipt_expense_locked';
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS protect_matriz_receipt_expense
  ON commerce.matriz_expenses;
CREATE TRIGGER protect_matriz_receipt_expense
  BEFORE UPDATE OF deleted_at ON commerce.matriz_expenses
  FOR EACH ROW EXECUTE FUNCTION finance.protect_matriz_receipt_expense();

REVOKE ALL ON FUNCTION finance.protect_matriz_receipt_expense() FROM PUBLIC;

DO $security$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='farejador_partner_app') THEN
    REVOKE ALL ON FUNCTION finance.protect_matriz_receipt_expense()
      FROM farejador_partner_app;
  END IF;
END
$security$;

COMMENT ON FUNCTION finance.protect_matriz_receipt_expense() IS
  '0145: impede soft-delete de despesa ligada a comprovante terminal; reparo restaura a mesma linha.';
