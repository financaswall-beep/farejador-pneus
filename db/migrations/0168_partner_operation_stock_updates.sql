-- 0168 - Edicao segura do cadastro pela Operacao da Loja.
--
-- A equipe pode propor somente metadados operacionais. Saldo, custo, preco,
-- fornecedor, vinculo ao catalogo e tipo do item continuam fora do pedido.
-- A alteracao so chega ao estoque depois da aprovacao transacional do dono.

ALTER TABLE commerce.partner_item_registration_requests
  ADD COLUMN IF NOT EXISTS target_stock_id UUID
    REFERENCES commerce.partner_stock_levels(id);

ALTER TABLE commerce.partner_item_registration_requests
  ADD COLUMN IF NOT EXISTS stock_metadata_snapshot JSONB;

DO $constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'partner_item_update_snapshot_check'
       AND conrelid = 'commerce.partner_item_registration_requests'::regclass
  ) THEN
    ALTER TABLE commerce.partner_item_registration_requests
      ADD CONSTRAINT partner_item_update_snapshot_check CHECK (
        (target_stock_id IS NULL AND stock_metadata_snapshot IS NULL)
        OR (target_stock_id IS NOT NULL
            AND jsonb_typeof(stock_metadata_snapshot) = 'object')
      );
  END IF;
END;
$constraints$;

CREATE UNIQUE INDEX IF NOT EXISTS partner_item_update_one_pending_idx
  ON commerce.partner_item_registration_requests(environment, unit_id, target_stock_id)
  WHERE target_stock_id IS NOT NULL AND status = 'pending';

DROP TRIGGER IF EXISTS env_match_partner_item_registration_target
  ON commerce.partner_item_registration_requests;
CREATE TRIGGER env_match_partner_item_registration_target
  BEFORE INSERT OR UPDATE OF target_stock_id
  ON commerce.partner_item_registration_requests
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match(
    'commerce', 'partner_stock_levels', 'target_stock_id'
  );

COMMENT ON COLUMN commerce.partner_item_registration_requests.target_stock_id IS
  '0168: preenchido quando a solicitacao altera um item existente; NULL em cadastro novo.';
COMMENT ON COLUMN commerce.partner_item_registration_requests.stock_metadata_snapshot IS
  '0168: metadados observados no envio; impede aprovacao sobre cadastro alterado depois.';

DO $smoke$
DECLARE
  v_write_grants INTEGER;
  v_index BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'commerce'
       AND indexname = 'partner_item_update_one_pending_idx'
  ) INTO v_index;
  IF v_index IS DISTINCT FROM true THEN
    RAISE EXCEPTION '0168: indice de uma edicao pendente por item ausente';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'farejador_partner_app') THEN
    SELECT count(*) INTO v_write_grants
      FROM information_schema.role_table_grants
     WHERE grantee = 'farejador_partner_app'
       AND table_schema = 'commerce'
       AND table_name = 'partner_item_registration_requests'
       AND privilege_type IN ('UPDATE', 'DELETE');
    IF v_write_grants <> 0 THEN
      RAISE EXCEPTION '0168: role do parceiro recebeu UPDATE/DELETE na fila';
    END IF;
  END IF;
END;
$smoke$;
