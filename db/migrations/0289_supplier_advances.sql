-- O crédito pertence ao fornecedor. O caixa e a liquidação permanecem no livro central.
BEGIN;
CREATE INDEX matriz_advance_supplier ON finance.matriz_ledger_transactions(environment,(metadata->>'supplier_id'),competence_on)
 WHERE source_type LIKE 'finance.supplier_advance.%';
CREATE INDEX matriz_advance_pix_reference ON finance.matriz_ledger_transactions
 (environment,(lower(btrim(metadata->>'cash_account'))),(metadata->>'bank_reference'))
 WHERE source_type='finance.supplier_advance.issue' AND metadata->>'bank_reference' IS NOT NULL;

-- A referência é exclusiva entre adiantamentos vigentes; uma correção mantém o histórico.
CREATE FUNCTION finance.guard_supplier_advance_reference() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finance AS $fn$
DECLARE account text := lower(btrim(NEW.metadata->>'cash_account'));
        reference text := NEW.metadata->>'bank_reference';
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.environment::text||':pix:'||account||':'||reference,0));
  IF EXISTS(SELECT FROM finance.matriz_ledger_transactions t WHERE t.environment=NEW.environment
      AND t.source_type='finance.supplier_advance.issue' AND lower(btrim(t.metadata->>'cash_account'))=account
      AND t.metadata->>'bank_reference'=reference AND NOT EXISTS (SELECT FROM finance.matriz_ledger_transactions r
        WHERE r.environment=t.environment AND r.reversal_of_transaction_id=t.id)) THEN
    RAISE EXCEPTION 'supplier_advance_reference_in_use';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER active_supplier_advance_reference BEFORE INSERT ON finance.matriz_ledger_transactions
FOR EACH ROW WHEN (NEW.source_type='finance.supplier_advance.issue' AND NEW.metadata->>'bank_reference' IS NOT NULL)
EXECUTE FUNCTION finance.guard_supplier_advance_reference();
REVOKE ALL ON FUNCTION finance.guard_supplier_advance_reference() FROM PUBLIC;

CREATE VIEW finance.supplier_advance_movements WITH (security_invoker=true) AS
 SELECT t.environment,t.id,t.source_type,t.amount,t.competence_on,t.cash_on,t.created_at,t.created_by,
   t.description,t.metadata,t.reversal_of_transaction_id,
   (t.metadata->>'supplier_id')::uuid supplier_id,
   CASE WHEN t.source_type='finance.supplier_advance.issue' THEN t.id
        ELSE (t.metadata->>'advance_id')::uuid END advance_id,
   (t.metadata->>'purchase_id')::uuid purchase_id,
   CASE WHEN e.side='debit' THEN e.amount ELSE -e.amount END delta
 FROM finance.matriz_ledger_transactions t JOIN finance.matriz_ledger_entries e
 ON e.environment=t.environment AND e.transaction_id=t.id AND e.account_code='supplier_advances'
 WHERE t.source_type LIKE 'finance.supplier_advance.%';

CREATE TABLE finance.supplier_advance_receipts (
 environment env_t NOT NULL, advance_id uuid NOT NULL REFERENCES finance.matriz_ledger_transactions(id),
 digest text NOT NULL, image bytea NOT NULL CHECK(octet_length(image) BETWEEN 1 AND 2097152),
 created_at timestamptz NOT NULL DEFAULT now(), created_by text NOT NULL,
 PRIMARY KEY(environment,advance_id,digest)
);
CREATE TRIGGER env_match_advance_receipt BEFORE INSERT OR UPDATE ON finance.supplier_advance_receipts
 FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('finance','matriz_ledger_transactions','advance_id');
ALTER TABLE finance.supplier_advance_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON finance.supplier_advance_movements,finance.supplier_advance_receipts FROM PUBLIC,farejador_partner_app;
DO $$ BEGIN
 IF EXISTS (SELECT FROM pg_roles WHERE rolname='service_role') THEN
  GRANT SELECT ON finance.supplier_advance_movements TO service_role;
  GRANT SELECT,INSERT ON finance.supplier_advance_receipts TO service_role;
 END IF;
END $$;

CREATE OR REPLACE FUNCTION finance.matriz_ledger_obligation_breakdown(p_environment env_t,p_id UUID)
RETURNS TABLE(amount NUMERIC,cash_paid NUMERIC,written_off NUMERIC,adjusted NUMERIC,
  open_amount NUMERIC,reversed BOOLEAN)
LANGUAGE sql STABLE SET search_path=pg_catalog,finance AS $fn$
 SELECT t.amount,
   CASE WHEN t.transaction_kind IN ('sale_cash','purchase_cash') THEN t.amount ELSE
     COALESCE(sum(p.amount) FILTER (WHERE p.payment_kind='settlement' AND pt.source_type <> 'finance.supplier_advance.apply'),0)
     -COALESCE(sum(p.amount) FILTER (WHERE p.payment_kind='reversal' AND pt.source_type <> 'finance.supplier_advance.restore'),0) END,
   COALESCE(sum(p.amount) FILTER (WHERE p.payment_kind='writeoff'),0),
   COALESCE(sum(p.amount) FILTER (WHERE p.payment_kind='adjustment'),0),
   CASE WHEN t.transaction_kind IN ('sale_cash','purchase_cash') THEN 0::numeric ELSE
     finance.matriz_ledger_obligation_balance(p_environment,t.id) END,
   EXISTS (SELECT 1 FROM finance.matriz_ledger_transactions r
     WHERE r.environment=t.environment AND r.reversal_of_transaction_id=t.id)
 FROM finance.matriz_ledger_transactions t
 LEFT JOIN finance.matriz_ledger_payments p
   ON p.environment=t.environment AND p.obligation_transaction_id=t.id
 LEFT JOIN finance.matriz_ledger_transactions pt ON pt.environment=p.environment AND pt.id=p.payment_transaction_id
 WHERE t.environment=p_environment AND t.id=p_id
 GROUP BY t.id,t.environment,t.amount,t.transaction_kind
$fn$;

CREATE OR REPLACE FUNCTION finance.matriz_stage3_ledger_orphans(
  p_environment env_t
) RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, finance, commerce
AS $fn$
  SELECT count(*)
    FROM finance.matriz_ledger_transactions t
   WHERE t.environment=p_environment
     AND (
       (t.source_type LIKE 'commerce.wholesale_purchase.%' AND NOT EXISTS (
         SELECT 1 FROM commerce.wholesale_purchases p
          WHERE p.environment=t.environment
            AND p.id::text=CASE
              WHEN t.source_type='commerce.wholesale_purchase.payment' THEN COALESCE(t.metadata->>'source_id',t.source_id)
              WHEN t.source_type='commerce.wholesale_purchase.partial_payment'
                THEN t.metadata->>'source_id'
              ELSE t.source_id
            END
       ))
       OR
       (t.source_type LIKE 'commerce.wholesale_order.%' AND NOT EXISTS (
         SELECT 1 FROM commerce.wholesale_orders o
          WHERE o.environment=t.environment
            AND o.id::text=CASE
              WHEN t.source_type='commerce.wholesale_order.partial_payment'
                THEN t.metadata->>'source_id'
              ELSE t.source_id
            END
       ))
       OR
       (t.source_type LIKE 'commerce.order.%' AND NOT EXISTS (
         SELECT 1 FROM commerce.orders o
          WHERE o.environment=t.environment
            AND o.id::text=CASE
              WHEN t.source_type='commerce.order.partial_payment'
                THEN t.metadata->>'source_id'
              ELSE t.source_id
            END
       ))
       OR
       (t.source_type='finance.inventory_adjustment' AND NOT EXISTS (
         SELECT 1 FROM finance.matriz_inventory_adjustments a
          WHERE a.environment=t.environment AND a.id::text=t.source_id
       ))
     );
$fn$;

-- Uma obrigação quitada por compensação já tem liquidação, inclusive sem Pix final.
ALTER FUNCTION finance.matriz_stage3_ledger_reconciliation(env_t) RENAME TO matriz_stage3_ledger_reconciliation_v0288;
CREATE FUNCTION finance.matriz_stage3_ledger_reconciliation(p_environment env_t)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,finance,commerce AS $$
 SELECT finance.matriz_stage3_ledger_reconciliation_v0288(p_environment) || jsonb_build_object(
 'purchase_payment_missing',(SELECT count(*) FROM commerce.wholesale_purchases p
 JOIN finance.matriz_ledger_transactions t ON t.environment=p.environment AND t.source_id=p.id::text
 AND t.source_type='commerce.wholesale_purchase.accrual' AND t.transaction_kind='purchase_payable'
 WHERE p.environment=p_environment AND p.payment_status='paid' AND p.total_amount>0
 AND finance.matriz_ledger_obligation_balance(p_environment,t.id)>0
 AND NOT EXISTS(SELECT FROM finance.matriz_ledger_transactions x WHERE x.environment=t.environment
 AND x.source_type='commerce.wholesale_purchase.payment' AND x.source_id=p.id::text)))
$$;
REVOKE ALL ON FUNCTION finance.matriz_stage3_ledger_reconciliation(env_t) FROM PUBLIC,farejador_partner_app;
DO $$ BEGIN IF EXISTS (SELECT FROM pg_roles WHERE rolname='service_role') THEN
 GRANT EXECUTE ON FUNCTION finance.matriz_stage3_ledger_reconciliation(env_t) TO service_role;
END IF; END $$;
COMMIT;
