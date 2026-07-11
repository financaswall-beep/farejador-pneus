-- 0132_matriz_admin_login.sql
-- Login humano da Matriz: papel explícito no colaborador; a sessão opaca reutiliza
-- network.matriz_staff_sessions (0125), sempre com prefixo ms_ no cliente.

ALTER TABLE network.matriz_collaborators
  ADD COLUMN IF NOT EXISTS panel_role TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'network.matriz_collaborators'::regclass
       AND conname = 'matriz_collaborators_panel_role_check'
  ) THEN
    ALTER TABLE network.matriz_collaborators
      ADD CONSTRAINT matriz_collaborators_panel_role_check
      CHECK (panel_role IS NULL OR panel_role IN ('owner', 'admin'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS matriz_collaborators_panel_access_idx
  ON network.matriz_collaborators (environment, panel_role)
  WHERE revoked_at IS NULL AND panel_role IS NOT NULL;

COMMENT ON COLUMN network.matriz_collaborators.panel_role IS
  '0132: acesso humano ao painel da Matriz. NULL=sem acesso; admin=opera o painel; owner=opera e gerencia acessos.';

COMMENT ON TABLE network.matriz_staff_sessions IS
  'Sessões opacas do staff da Matriz. es_=portal do entregador; ms_=painel administrativo. Banco guarda somente SHA-256; validação sempre junta pessoa e colaborador ativos.';

DO $$
DECLARE
  v_sel BOOLEAN;
  v_ins BOOLEAN;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'farejador_partner_app') THEN
    SELECT has_table_privilege('farejador_partner_app', 'network.matriz_collaborators', 'SELECT') INTO v_sel;
    SELECT has_table_privilege('farejador_partner_app', 'network.matriz_staff_sessions', 'INSERT') INTO v_ins;
    IF v_sel OR v_ins THEN
      RAISE EXCEPTION '0132 falhou: role do parceiro nao pode acessar login da matriz';
    END IF;
  END IF;
END $$;
