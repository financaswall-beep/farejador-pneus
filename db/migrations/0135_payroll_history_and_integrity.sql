-- 0135 - Integridade da Folha gerencial da Matriz.
-- Depende da fundacao 0133. Nao calcula encargos trabalhistas: registra apenas
-- salario mensal configurado, comissao apurada e ajustes manuais.

-- Remuneracao e comissao preservam versoes por vigencia. Periodos fechados
-- continuam lendo o snapshot imutavel de finance.matriz_payroll_items.
ALTER TABLE network.matriz_collaborator_compensation
  ADD COLUMN IF NOT EXISTS id UUID NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE network.matriz_collaborator_compensation
  DROP CONSTRAINT IF EXISTS matriz_collaborator_compensation_pkey;
ALTER TABLE network.matriz_collaborator_compensation
  ADD CONSTRAINT matriz_collaborator_compensation_pkey PRIMARY KEY (id);
CREATE UNIQUE INDEX IF NOT EXISTS matriz_collaborator_compensation_version_uniq
  ON network.matriz_collaborator_compensation (collaborator_id, starts_on);
CREATE INDEX IF NOT EXISTS matriz_collaborator_compensation_effective_idx
  ON network.matriz_collaborator_compensation (environment, collaborator_id, starts_on DESC);

ALTER TABLE network.matriz_collaborator_commission_rules
  ADD COLUMN IF NOT EXISTS id UUID NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE network.matriz_collaborator_commission_rules
  DROP CONSTRAINT IF EXISTS matriz_collaborator_commission_rules_pkey;
ALTER TABLE network.matriz_collaborator_commission_rules
  ADD CONSTRAINT matriz_collaborator_commission_rules_pkey PRIMARY KEY (id);
CREATE UNIQUE INDEX IF NOT EXISTS matriz_collaborator_commission_version_uniq
  ON network.matriz_collaborator_commission_rules (collaborator_id, starts_on);
CREATE INDEX IF NOT EXISTS matriz_collaborator_commission_effective_idx
  ON network.matriz_collaborator_commission_rules (environment, collaborator_id, starts_on DESC);

-- O banco garante as correlacoes usadas no fechamento e no pagamento.
DROP TRIGGER IF EXISTS env_match_matriz_payroll_item_period ON finance.matriz_payroll_items;
CREATE TRIGGER env_match_matriz_payroll_item_period
  BEFORE INSERT OR UPDATE OF payroll_period_id ON finance.matriz_payroll_items
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('finance', 'matriz_payroll_periods', 'payroll_period_id');

DROP TRIGGER IF EXISTS env_match_matriz_payroll_item_expense ON finance.matriz_payroll_items;
CREATE TRIGGER env_match_matriz_payroll_item_expense
  BEFORE INSERT OR UPDATE OF source_expense_id ON finance.matriz_payroll_items
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('commerce', 'matriz_expenses', 'source_expense_id');

ALTER TABLE finance.matriz_payroll_items
  DROP CONSTRAINT IF EXISTS matriz_payroll_items_total_due_check;
ALTER TABLE finance.matriz_payroll_items
  ADD CONSTRAINT matriz_payroll_items_total_due_check
  CHECK (total_due = GREATEST(base_salary + commission_amount + additions - deductions, 0));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='farejador_partner_app') THEN
    REVOKE ALL ON network.matriz_collaborator_compensation FROM farejador_partner_app;
    REVOKE ALL ON network.matriz_collaborator_commission_rules FROM farejador_partner_app;
    REVOKE ALL ON finance.matriz_payroll_items FROM farejador_partner_app;
  END IF;
END $$;
