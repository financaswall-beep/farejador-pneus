-- 0172_matriz_operation_permissions.sql
-- Permissoes individuais da Matriz na Operacao da Loja. A ausencia da linha
-- preserva exatamente o acesso historico derivado de cargo/area/papel.

CREATE TABLE IF NOT EXISTS network.matriz_collaborator_operation_permissions (
  collaborator_id UUID PRIMARY KEY
    REFERENCES network.matriz_collaborators(id) ON DELETE CASCADE,
  environment env_t NOT NULL,
  allow_vendas BOOLEAN NOT NULL,
  allow_entregas BOOLEAN NOT NULL,
  allow_financeiro BOOLEAN NOT NULL,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS matriz_operation_permissions_env_idx
  ON network.matriz_collaborator_operation_permissions(environment,updated_at DESC);

DROP TRIGGER IF EXISTS env_immutable_matriz_operation_permissions
  ON network.matriz_collaborator_operation_permissions;
CREATE TRIGGER env_immutable_matriz_operation_permissions
  BEFORE UPDATE OF environment
  ON network.matriz_collaborator_operation_permissions
  FOR EACH ROW EXECUTE FUNCTION ops.enforce_environment_immutable();

DROP TRIGGER IF EXISTS env_match_matriz_operation_permissions_collaborator
  ON network.matriz_collaborator_operation_permissions;
CREATE TRIGGER env_match_matriz_operation_permissions_collaborator
  BEFORE INSERT OR UPDATE OF collaborator_id
  ON network.matriz_collaborator_operation_permissions
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match(
    'network','matriz_collaborators','collaborator_id'
  );

REVOKE ALL ON network.matriz_collaborator_operation_permissions FROM PUBLIC;

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='farejador_partner_app') THEN
    REVOKE ALL ON network.matriz_collaborator_operation_permissions
      FROM farejador_partner_app;
  END IF;
END;
$grants$;

DO $assertions$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM network.matriz_collaborator_operation_permissions p
      LEFT JOIN network.matriz_collaborators c
        ON c.id=p.collaborator_id AND c.environment=p.environment
     WHERE c.id IS NULL
  ) THEN
    RAISE EXCEPTION 'matriz_operation_permissions_scope_invalid';
  END IF;
END;
$assertions$;

COMMENT ON TABLE network.matriz_collaborator_operation_permissions IS
  'Permissoes individuais da Matriz na Operacao da Loja. Sem linha, cargo/area/papel continuam definindo o acesso legado.';
