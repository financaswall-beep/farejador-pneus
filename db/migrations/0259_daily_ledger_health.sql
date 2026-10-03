BEGIN;
-- Estado de uma checagem somente de leitura; nenhum reparo financeiro automático.
CREATE TABLE ops.matriz_ledger_health_checks (
  environment env_t PRIMARY KEY,
  checked_on date NOT NULL,
  checked_at timestamptz NOT NULL,
  status text NOT NULL CHECK(status IN ('green','yellow','red','disabled','error')),
  error_signals integer NOT NULL DEFAULT 0 CHECK(error_signals>=0),
  pending_signals integer NOT NULL DEFAULT 0 CHECK(pending_signals>=0)
);
ALTER TABLE ops.matriz_ledger_health_checks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ops.matriz_ledger_health_checks FROM PUBLIC;
DO $smoke$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid='ops.matriz_ledger_health_checks'::regclass AND relrowsecurity) THEN
    RAISE EXCEPTION '0259: protecao da conferencia diaria ausente';
  END IF;
END $smoke$;
COMMIT;
