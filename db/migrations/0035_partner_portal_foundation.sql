-- ============================================================
-- 0035_partner_portal_foundation.sql
-- Portal Parceiros MVP - isolamento por unidade.
--
-- Nao toca em agent.*, ops.*, raw.*, analytics.* nem mensagens Chatwoot.
-- Parceiro opera apenas dados comerciais da propria unit_id.
-- ============================================================

CREATE SCHEMA IF NOT EXISTS network;
CREATE SCHEMA IF NOT EXISTS finance;

-- ------------------------------------------------------------
-- Helpers
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION network.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- ------------------------------------------------------------
-- Parceiro comercial
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS network.partners (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment        env_t NOT NULL,
  legal_name         TEXT NOT NULL,
  trade_name         TEXT NOT NULL,
  document_number    TEXT,
  responsible_name   TEXT,
  whatsapp_phone     TEXT,
  email              TEXT,
  address            TEXT,
  status             TEXT NOT NULL DEFAULT 'credentialing'
                     CHECK (status IN ('credentialing', 'active', 'suspended')),
  commercial_model   TEXT NOT NULL DEFAULT 'commission'
                     CHECK (commercial_model IN ('commission', 'monthly', 'hybrid')),
  commission_percent NUMERIC(5, 2) CHECK (commission_percent IS NULL OR commission_percent >= 0),
  monthly_fee        NUMERIC(10, 2) CHECK (monthly_fee IS NULL OR monthly_fee >= 0),
  notes              TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at         TIMESTAMPTZ,
  UNIQUE (environment, document_number)
);

CREATE INDEX IF NOT EXISTS partners_status_idx
  ON network.partners(environment, status)
  WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS partners_set_updated_at ON network.partners;
CREATE TRIGGER partners_set_updated_at
  BEFORE UPDATE ON network.partners
  FOR EACH ROW EXECUTE FUNCTION network.set_updated_at();

DROP TRIGGER IF EXISTS env_immutable_partners ON network.partners;
CREATE TRIGGER env_immutable_partners
  BEFORE UPDATE OF environment ON network.partners
  FOR EACH ROW EXECUTE FUNCTION ops.enforce_environment_immutable();

-- ------------------------------------------------------------
-- Unidade parceira
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS network.partner_units (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment  env_t NOT NULL,
  partner_id   UUID NOT NULL REFERENCES network.partners(id),
  unit_id      UUID NOT NULL REFERENCES core.units(id),
  slug         TEXT NOT NULL,
  display_name TEXT NOT NULL,
  address      TEXT,
  phone        TEXT,
  status       TEXT NOT NULL DEFAULT 'credentialing'
               CHECK (status IN ('credentialing', 'active', 'suspended')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ,
  UNIQUE (environment, slug),
  UNIQUE (environment, unit_id)
);

CREATE INDEX IF NOT EXISTS partner_units_partner_idx
  ON network.partner_units(partner_id)
  WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS partner_units_set_updated_at ON network.partner_units;
CREATE TRIGGER partner_units_set_updated_at
  BEFORE UPDATE ON network.partner_units
  FOR EACH ROW EXECUTE FUNCTION network.set_updated_at();

DROP TRIGGER IF EXISTS env_match_partner_units_partner ON network.partner_units;
CREATE TRIGGER env_match_partner_units_partner
  BEFORE INSERT OR UPDATE OF partner_id ON network.partner_units
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('network', 'partners', 'partner_id');

DROP TRIGGER IF EXISTS env_match_partner_units_unit ON network.partner_units;
CREATE TRIGGER env_match_partner_units_unit
  BEFORE INSERT OR UPDATE OF unit_id ON network.partner_units
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('core', 'units', 'unit_id');

DROP TRIGGER IF EXISTS env_immutable_partner_units ON network.partner_units;
CREATE TRIGGER env_immutable_partner_units
  BEFORE UPDATE OF environment ON network.partner_units
  FOR EACH ROW EXECUTE FUNCTION ops.enforce_environment_immutable();

-- ------------------------------------------------------------
-- Token de acesso do parceiro (hash SHA-256, sem token puro)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS network.partner_access_tokens (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment     env_t NOT NULL,
  partner_unit_id UUID NOT NULL REFERENCES network.partner_units(id),
  token_hash      TEXT NOT NULL,
  label           TEXT,
  created_by      TEXT,
  last_used_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at      TIMESTAMPTZ,
  UNIQUE (environment, token_hash)
);

CREATE INDEX IF NOT EXISTS partner_access_tokens_unit_idx
  ON network.partner_access_tokens(partner_unit_id)
  WHERE revoked_at IS NULL;

DROP TRIGGER IF EXISTS env_match_partner_tokens_unit ON network.partner_access_tokens;
CREATE TRIGGER env_match_partner_tokens_unit
  BEFORE INSERT OR UPDATE OF partner_unit_id ON network.partner_access_tokens
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('network', 'partner_units', 'partner_unit_id');

DROP TRIGGER IF EXISTS env_immutable_partner_access_tokens ON network.partner_access_tokens;
CREATE TRIGGER env_immutable_partner_access_tokens
  BEFORE UPDATE OF environment ON network.partner_access_tokens
  FOR EACH ROW EXECUTE FUNCTION ops.enforce_environment_immutable();

CREATE OR REPLACE FUNCTION network.hash_partner_token(p_token TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT encode(digest(p_token, 'sha256'), 'hex')
$$;

-- ------------------------------------------------------------
-- Estoque local do parceiro
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS commerce.partner_stock_levels (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment       env_t NOT NULL,
  unit_id           UUID NOT NULL REFERENCES core.units(id),
  product_id        UUID REFERENCES commerce.products(id),
  local_sku         TEXT,
  item_name         TEXT NOT NULL,
  tire_size         TEXT,
  brand             TEXT,
  supplier_name     TEXT,
  quantity_on_hand  INTEGER CHECK (quantity_on_hand IS NULL OR quantity_on_hand >= 0),
  minimum_quantity  INTEGER CHECK (minimum_quantity IS NULL OR minimum_quantity >= 0),
  average_cost      NUMERIC(10, 2) CHECK (average_cost IS NULL OR average_cost >= 0),
  sale_price        NUMERIC(10, 2) CHECK (sale_price IS NULL OR sale_price >= 0),
  is_tracked        BOOLEAN NOT NULL DEFAULT true,
  stock_status      TEXT NOT NULL DEFAULT 'unknown'
                    CHECK (stock_status IN ('unknown', 'in_stock', 'low_stock', 'out_of_stock', 'not_tracked')),
  updated_by        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at        TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS partner_stock_local_sku_uniq
  ON commerce.partner_stock_levels(environment, unit_id, local_sku)
  WHERE local_sku IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS partner_stock_unit_idx
  ON commerce.partner_stock_levels(environment, unit_id, stock_status)
  WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS partner_stock_set_updated_at ON commerce.partner_stock_levels;
CREATE TRIGGER partner_stock_set_updated_at
  BEFORE UPDATE ON commerce.partner_stock_levels
  FOR EACH ROW EXECUTE FUNCTION network.set_updated_at();

DROP TRIGGER IF EXISTS env_match_partner_stock_unit ON commerce.partner_stock_levels;
CREATE TRIGGER env_match_partner_stock_unit
  BEFORE INSERT OR UPDATE OF unit_id ON commerce.partner_stock_levels
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('core', 'units', 'unit_id');

DROP TRIGGER IF EXISTS env_match_partner_stock_product ON commerce.partner_stock_levels;
CREATE TRIGGER env_match_partner_stock_product
  BEFORE INSERT OR UPDATE OF product_id ON commerce.partner_stock_levels
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('commerce', 'products', 'product_id');

-- ------------------------------------------------------------
-- Compras do parceiro
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS commerce.partner_purchases (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment    env_t NOT NULL,
  unit_id        UUID NOT NULL REFERENCES core.units(id),
  supplier_name  TEXT,
  purchased_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  total_amount   NUMERIC(10, 2) NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
  payment_method TEXT,
  notes          TEXT,
  created_by     TEXT,
  idempotency_key TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS partner_purchases_unit_date_idx
  ON commerce.partner_purchases(environment, unit_id, purchased_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS partner_purchases_idempotency_uniq
  ON commerce.partner_purchases(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

DROP TRIGGER IF EXISTS env_match_partner_purchases_unit ON commerce.partner_purchases;
CREATE TRIGGER env_match_partner_purchases_unit
  BEFORE INSERT OR UPDATE OF unit_id ON commerce.partner_purchases
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('core', 'units', 'unit_id');

CREATE TABLE IF NOT EXISTS commerce.partner_purchase_items (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment env_t NOT NULL,
  purchase_id UUID NOT NULL REFERENCES commerce.partner_purchases(id) ON DELETE CASCADE,
  product_id  UUID REFERENCES commerce.products(id),
  item_name   TEXT NOT NULL,
  quantity    INTEGER NOT NULL CHECK (quantity > 0),
  unit_cost   NUMERIC(10, 2) NOT NULL CHECK (unit_cost >= 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS env_match_partner_purchase_items_purchase ON commerce.partner_purchase_items;
CREATE TRIGGER env_match_partner_purchase_items_purchase
  BEFORE INSERT OR UPDATE OF purchase_id ON commerce.partner_purchase_items
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('commerce', 'partner_purchases', 'purchase_id');

DROP TRIGGER IF EXISTS env_match_partner_purchase_items_product ON commerce.partner_purchase_items;
CREATE TRIGGER env_match_partner_purchase_items_product
  BEFORE INSERT OR UPDATE OF product_id ON commerce.partner_purchase_items
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('commerce', 'products', 'product_id');

-- ------------------------------------------------------------
-- Despesas do parceiro
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS finance.partner_expenses (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment     env_t NOT NULL,
  unit_id         UUID NOT NULL REFERENCES core.units(id),
  expense_date    DATE NOT NULL DEFAULT CURRENT_DATE,
  category        TEXT NOT NULL
                  CHECK (category IN ('employee_payment', 'rent', 'utilities', 'maintenance', 'delivery', 'tax', 'other')),
  description     TEXT NOT NULL,
  amount          NUMERIC(10, 2) NOT NULL CHECK (amount >= 0),
  payment_method  TEXT,
  created_by      TEXT,
  idempotency_key TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS partner_expenses_unit_date_idx
  ON finance.partner_expenses(environment, unit_id, expense_date DESC);

CREATE UNIQUE INDEX IF NOT EXISTS partner_expenses_idempotency_uniq
  ON finance.partner_expenses(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

DROP TRIGGER IF EXISTS env_match_partner_expenses_unit ON finance.partner_expenses;
CREATE TRIGGER env_match_partner_expenses_unit
  BEFORE INSERT OR UPDATE OF unit_id ON finance.partner_expenses
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('core', 'units', 'unit_id');

-- ------------------------------------------------------------
-- View segura por unidade
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW network.partner_unit_summary AS
SELECT
  pu.environment,
  pu.id AS partner_unit_id,
  pu.unit_id,
  pu.slug,
  pu.display_name,
  p.id AS partner_id,
  p.trade_name AS partner_name,
  p.status AS partner_status,
  pu.status AS unit_status,
  COALESCE(orders_month.total_sales, 0) AS sales_month,
  COALESCE(orders_month.order_count, 0) AS orders_month,
  COALESCE(purchases_month.total_purchases, 0) AS purchases_month,
  COALESCE(expenses_month.total_expenses, 0) AS expenses_month,
  COALESCE(stock_counts.stock_items, 0) AS stock_items,
  COALESCE(stock_counts.low_stock_items, 0) AS low_stock_items,
  COALESCE(orders_month.total_sales, 0)
    - COALESCE(purchases_month.total_purchases, 0)
    - COALESCE(expenses_month.total_expenses, 0) AS estimated_result_month
FROM network.partner_units pu
JOIN network.partners p
  ON p.id = pu.partner_id AND p.environment = pu.environment
LEFT JOIN LATERAL (
  SELECT count(*)::int AS order_count, COALESCE(sum(total_amount), 0) AS total_sales
  FROM commerce.orders o
  WHERE o.environment = pu.environment
    AND o.unit_id = pu.unit_id
    AND o.status <> 'cancelled'
    AND o.created_at >= date_trunc('month', now())
) orders_month ON true
LEFT JOIN LATERAL (
  SELECT COALESCE(sum(total_amount), 0) AS total_purchases
  FROM commerce.partner_purchases pp
  WHERE pp.environment = pu.environment
    AND pp.unit_id = pu.unit_id
    AND pp.purchased_at >= date_trunc('month', now())
) purchases_month ON true
LEFT JOIN LATERAL (
  SELECT COALESCE(sum(amount), 0) AS total_expenses
  FROM finance.partner_expenses pe
  WHERE pe.environment = pu.environment
    AND pe.unit_id = pu.unit_id
    AND pe.expense_date >= date_trunc('month', now())::date
) expenses_month ON true
LEFT JOIN LATERAL (
  SELECT count(*)::int AS stock_items,
         count(*) FILTER (WHERE stock_status IN ('low_stock', 'out_of_stock'))::int AS low_stock_items
  FROM commerce.partner_stock_levels ps
  WHERE ps.environment = pu.environment
    AND ps.unit_id = pu.unit_id
    AND ps.deleted_at IS NULL
) stock_counts ON true
WHERE pu.deleted_at IS NULL;

COMMENT ON VIEW network.partner_unit_summary IS
  'Resumo seguro do portal parceiro. Uma linha por unidade, sem dados de bot/shadow.';
