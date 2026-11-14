BEGIN;

CREATE TABLE finance.purchase_sharing (
  environment env_t NOT NULL,
  purchase_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision >= 1),
  participants jsonb NOT NULL CHECK (jsonb_typeof(participants)='array'),
  stock_allocations jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(stock_allocations)='object'),
  PRIMARY KEY (environment,purchase_id),
  FOREIGN KEY (environment,purchase_id) REFERENCES commerce.wholesale_purchases(environment,id)
);

-- Only money handled directly by someone outside the store is attributed here.
CREATE TABLE finance.purchase_cash_shares (
  environment env_t NOT NULL,
  purchase_id uuid NOT NULL,
  transaction_id uuid NOT NULL REFERENCES finance.matriz_ledger_transactions(id),
  participant_id uuid NOT NULL,
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  PRIMARY KEY (environment,transaction_id,purchase_id,participant_id),
  FOREIGN KEY (environment,purchase_id) REFERENCES finance.purchase_sharing(environment,purchase_id)
);
CREATE INDEX purchase_cash_shares_purchase ON finance.purchase_cash_shares(environment,purchase_id);

CREATE FUNCTION finance.check_purchase_cash_share() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finance AS $$
DECLARE cash_amount numeric; assigned numeric;
BEGIN
  PERFORM 1 FROM finance.matriz_ledger_transactions t
    WHERE t.environment=NEW.environment AND t.id=NEW.transaction_id AND t.cash_on IS NOT NULL
      AND t.reversal_of_transaction_id IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'shared_cash_transaction_invalid'; END IF;
  SELECT CASE WHEN count(*)=1 THEN max(e.amount) END INTO cash_amount
    FROM finance.matriz_ledger_entries e WHERE e.environment=NEW.environment
      AND e.transaction_id=NEW.transaction_id AND e.account_code='cash';
  SELECT COALESCE(sum(s.amount),0) INTO assigned FROM finance.purchase_cash_shares s
    WHERE s.environment=NEW.environment AND s.transaction_id=NEW.transaction_id;
  IF cash_amount IS NULL OR assigned+NEW.amount>cash_amount THEN
    RAISE EXCEPTION 'shared_cash_amount_invalid';
  END IF;
  IF NOT EXISTS (SELECT FROM finance.purchase_sharing p CROSS JOIN LATERAL jsonb_array_elements(p.participants) person
    WHERE p.environment=NEW.environment AND p.purchase_id=NEW.purchase_id AND person->>'id'=NEW.participant_id::text) THEN
    RAISE EXCEPTION 'shared_cash_participant_invalid';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER validate_purchase_cash_share BEFORE INSERT ON finance.purchase_cash_shares
  FOR EACH ROW EXECUTE FUNCTION finance.check_purchase_cash_share();

-- Original journal entries retain their fingerprint. Split the cash leg into store cash
-- and third-party clearing for reporting. A reversal inherits the exact original split.
CREATE VIEW finance.matriz_reporting_entries WITH (security_invoker=true) AS
SELECT CASE WHEN leg.account_code=e.account_code THEN e.id ELSE md5(e.id::text||'/external')::uuid END id,
       e.environment,e.transaction_id,e.line_no,leg.account_code,e.account_class,e.side,
       leg.amount::numeric(14,2) amount,e.memo,e.metadata,e.created_at
FROM finance.matriz_ledger_entries e
JOIN finance.matriz_ledger_transactions t ON t.id=e.transaction_id AND t.environment=e.environment
LEFT JOIN LATERAL (
  SELECT sum(s.amount) outside_cash FROM finance.purchase_cash_shares s
  WHERE e.account_code='cash' AND s.environment=e.environment
    AND s.transaction_id=COALESCE(t.reversal_of_transaction_id,t.id)
) split ON true
CROSS JOIN LATERAL (VALUES
  (e.account_code,e.amount-COALESCE(split.outside_cash,0)),
  ('participant_clearing',split.outside_cash)
) leg(account_code,amount)
WHERE leg.amount>0;

ALTER TABLE finance.purchase_sharing ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance.purchase_cash_shares ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON finance.purchase_sharing,finance.purchase_cash_shares,finance.matriz_reporting_entries FROM PUBLIC,farejador_partner_app;
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON finance.purchase_sharing,finance.purchase_cash_shares,finance.matriz_reporting_entries FROM anon;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN
    REVOKE ALL ON finance.purchase_sharing,finance.purchase_cash_shares,finance.matriz_reporting_entries FROM authenticated;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname='service_role') THEN
    GRANT SELECT,INSERT,UPDATE ON finance.purchase_sharing TO service_role;
    GRANT SELECT,INSERT,DELETE ON finance.purchase_cash_shares TO service_role;
    GRANT SELECT ON finance.matriz_reporting_entries TO service_role;
  END IF;
END $$;

COMMIT;
