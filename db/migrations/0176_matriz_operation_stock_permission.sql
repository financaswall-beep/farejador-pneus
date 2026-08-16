-- 0176_matriz_operation_stock_permission.sql
-- Libera a consulta segura do estoque do galpao na Operacao da Loja e permite
-- que o proprietario decida quais colaboradores da Matriz enxergam o modulo.

ALTER TABLE network.matriz_collaborator_operation_permissions
  ADD COLUMN IF NOT EXISTS allow_estoque BOOLEAN NOT NULL DEFAULT false;

DO $assertions$
DECLARE
  stock_default TEXT;
  stock_not_null BOOLEAN;
BEGIN
  SELECT pg_get_expr(d.adbin,d.adrelid),a.attnotnull
    INTO stock_default,stock_not_null
    FROM pg_attribute a
    JOIN pg_class c ON c.oid=a.attrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
   WHERE n.nspname='network'
     AND c.relname='matriz_collaborator_operation_permissions'
     AND a.attname='allow_estoque'
     AND NOT a.attisdropped;

  IF stock_default IS NULL OR stock_default NOT IN ('false','false::boolean') THEN
    RAISE EXCEPTION 'matriz_operation_stock_default_invalid: %',stock_default;
  END IF;
  IF stock_not_null IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'matriz_operation_stock_nullable';
  END IF;
END;
$assertions$;

COMMENT ON COLUMN network.matriz_collaborator_operation_permissions.allow_estoque IS
  'Permite consultar o estoque operacional da Matriz sem expor custo nem autorizar ajustes.';
