-- ============================================================
-- 0114_wholesale_suppliers.sql
-- ATACADO — FORNECEDORES: o lado de ENTRADA do galpão (de quem o dono COMPRA).
--
-- Contexto (negócio): o dono é atacadista de pneu usado. A metade da VENDA já tem
-- espelho (0110 venda+ranking de recompra, 0111 estoque, 0112 custo/lucro). A metade
-- da COMPRA era cega: o fornecedor existia só como TEXTO solto (supplier_name). Esta
-- migration dá ficha ao fornecedor e registra cada COMPRA (entrada) por origem, pra o
-- dono ver "quanto comprei de cada um" e "qual fornecedor sumiu".
--
-- Decisões do dono (2026-06-30) que moldam o desenho:
--   • Paga À VISTA hoje → NÃO há "contas a pagar ao fornecedor" agora. Mas a porta fica
--     aberta: wholesale_purchases.payment_status default 'paid' (ligar 'pending' depois
--     habilita fiado sem refazer schema).
--   • QUER rastrear a origem de cada pneu (de quem veio) → cada compra aponta o fornecedor.
--   • SÓ da matriz (single-tenant) → ZERO grant pro farejador_partner_app (regra de ouro
--     do atacado, provada na §7), espelhando 0110.
--
-- A compra ALIMENTA o custo médio do galpão (commerce.wholesale_stock) — mas isso é
-- lógica do BACKEND (reusa a "+Entrada" que já existe); aqui só criamos o REGISTRO da
-- compra. O custo médio do galpão (0111/0112) fica INTOCADO. PEPS (saldo por lote) é
-- 2ª etapa — esta camada é "de quem veio e quanto", custo segue MÉDIO.
--
-- 100% ADITIVA. DORMENTE até o backend/UI (flag WHOLESALE_SUPPLIERS) subir.
-- Rollback no fim (comentado). Assinatura: Orquestrador (Claude Opus 4.8) — banco/matriz, 2026-06-30
-- ============================================================

-- ─────────────────────────────────────────────
-- 1. FICHA DO FORNECEDOR (de quem o dono compra)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS commerce.wholesale_suppliers (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment  env_t NOT NULL,

  name         TEXT NOT NULL,        -- cadastro leve (igual wholesale_customers)
  phone        TEXT,
  notes        TEXT,

  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ
);

COMMENT ON TABLE commerce.wholesale_suppliers IS
  'Ficha do FORNECEDOR de atacado (0114): de quem o dono compra pneu usado pro galpao. Cadastro leve nome+telefone. Dado SO da matriz: SEM grant pro farejador_partner_app.';

-- Busca por nome no formulário/ranking.
CREATE INDEX IF NOT EXISTS wholesale_suppliers_name_idx
  ON commerce.wholesale_suppliers(environment, name)
  WHERE deleted_at IS NULL;

-- ─────────────────────────────────────────────
-- 2. COMPRA DE ATACADO / ENTRADA (cabeçalho)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS commerce.wholesale_purchases (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment    env_t NOT NULL,

  supplier_id    UUID NOT NULL REFERENCES commerce.wholesale_suppliers(id),

  purchased_at   TIMESTAMPTZ NOT NULL DEFAULT now(),   -- data da compra (pode retroagir)
  total_amount   NUMERIC(12, 2) NOT NULL DEFAULT 0
                   CHECK (total_amount >= 0),           -- somatório dos itens (app preenche)
  status         TEXT NOT NULL DEFAULT 'confirmed'
                   CHECK (status IN ('confirmed', 'cancelled')),  -- cancela sem apagar
  -- Porta aberta pro FIADO (hoje à vista). default 'paid' = comportamento de hoje;
  -- 'pending' destrava "contas a pagar ao fornecedor" sem refazer schema.
  payment_status TEXT NOT NULL DEFAULT 'paid'
                   CHECK (payment_status IN ('paid', 'pending')),
  created_by     TEXT,                                  -- quem registrou (trilha; matriz)
  notes          TEXT,

  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE commerce.wholesale_purchases IS
  'Compra/ENTRADA de atacado da Matriz (0114): de quem veio (supplier_id), quando, total. payment_status default paid (a vista hoje; pending = fiado futuro). Alimenta o custo medio do galpao via backend. Dado SO da matriz: SEM grant pro parceiro.';

-- Ranking de fornecedor: agrupar por fornecedor, mais recente primeiro.
CREATE INDEX IF NOT EXISTS wholesale_purchases_supplier_idx
  ON commerce.wholesale_purchases(environment, supplier_id, purchased_at DESC)
  WHERE status = 'confirmed';

-- Linha do tempo geral das compras.
CREATE INDEX IF NOT EXISTS wholesale_purchases_date_idx
  ON commerce.wholesale_purchases(environment, purchased_at DESC);

-- ─────────────────────────────────────────────
-- 3. ITENS DA COMPRA (os pneus que entraram) — custo DIGITADO por compra
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS commerce.wholesale_purchase_items (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment  env_t NOT NULL,

  purchase_id  UUID NOT NULL REFERENCES commerce.wholesale_purchases(id) ON DELETE CASCADE,

  measure      TEXT NOT NULL,                          -- medida do pneu (ex.: '90/90-18')
  brand        TEXT,                                   -- marca (opcional)
  quantity     INTEGER NOT NULL CHECK (quantity > 0),
  unit_cost    NUMERIC(12, 2) NOT NULL CHECK (unit_cost >= 0),  -- custo digitado por compra
  line_total   NUMERIC(12, 2) GENERATED ALWAYS AS (quantity * unit_cost) STORED,

  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE commerce.wholesale_purchase_items IS
  'Itens da compra de atacado (0114): medida/marca livres, custo DIGITADO por compra (unit_cost), line_total gerado. O backend casa a measure com o galpao (tireSizeKey) e recalcula o custo MEDIO.';

CREATE INDEX IF NOT EXISTS wholesale_purchase_items_purchase_idx
  ON commerce.wholesale_purchase_items(purchase_id);

-- ─────────────────────────────────────────────
-- 4. TRIGGERS — updated_at + invariante de ambiente (padrão 0110)
-- ─────────────────────────────────────────────
DROP TRIGGER IF EXISTS wholesale_suppliers_set_updated_at ON commerce.wholesale_suppliers;
CREATE TRIGGER wholesale_suppliers_set_updated_at
  BEFORE UPDATE ON commerce.wholesale_suppliers
  FOR EACH ROW EXECUTE FUNCTION network.set_updated_at();

DROP TRIGGER IF EXISTS wholesale_purchases_set_updated_at ON commerce.wholesale_purchases;
CREATE TRIGGER wholesale_purchases_set_updated_at
  BEFORE UPDATE ON commerce.wholesale_purchases
  FOR EACH ROW EXECUTE FUNCTION network.set_updated_at();

-- env-match: a compra tem que apontar fornecedor do MESMO ambiente.
DROP TRIGGER IF EXISTS env_match_wholesale_purchases_supplier ON commerce.wholesale_purchases;
CREATE TRIGGER env_match_wholesale_purchases_supplier
  BEFORE INSERT OR UPDATE OF environment, supplier_id ON commerce.wholesale_purchases
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('commerce', 'wholesale_suppliers', 'supplier_id');

DROP TRIGGER IF EXISTS env_match_wholesale_purchase_items_purchase ON commerce.wholesale_purchase_items;
CREATE TRIGGER env_match_wholesale_purchase_items_purchase
  BEFORE INSERT OR UPDATE OF environment, purchase_id ON commerce.wholesale_purchase_items
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('commerce', 'wholesale_purchases', 'purchase_id');

-- environment IMUTÁVEL após INSERT (padrão 0021/0110).
DROP TRIGGER IF EXISTS env_immutable_wholesale_suppliers ON commerce.wholesale_suppliers;
CREATE TRIGGER env_immutable_wholesale_suppliers
  BEFORE UPDATE OF environment ON commerce.wholesale_suppliers
  FOR EACH ROW EXECUTE FUNCTION ops.enforce_environment_immutable();

DROP TRIGGER IF EXISTS env_immutable_wholesale_purchases ON commerce.wholesale_purchases;
CREATE TRIGGER env_immutable_wholesale_purchases
  BEFORE UPDATE OF environment ON commerce.wholesale_purchases
  FOR EACH ROW EXECUTE FUNCTION ops.enforce_environment_immutable();

DROP TRIGGER IF EXISTS env_immutable_wholesale_purchase_items ON commerce.wholesale_purchase_items;
CREATE TRIGGER env_immutable_wholesale_purchase_items
  BEFORE UPDATE OF environment ON commerce.wholesale_purchase_items
  FOR EACH ROW EXECUTE FUNCTION ops.enforce_environment_immutable();

-- ─────────────────────────────────────────────
-- 5. VIEW DO RANKING DE FORNECEDOR ("de quem comprei mais / quem sumiu")
-- ─────────────────────────────────────────────
CREATE OR REPLACE VIEW commerce.wholesale_supplier_summary
WITH (security_invoker = true) AS
  SELECT
    s.id                                            AS supplier_id,
    s.environment,
    s.name,
    s.phone,
    count(p.id)                                     AS purchases_count,
    COALESCE(sum(p.total_amount), 0)                AS total_spent,
    max(p.purchased_at)                             AS last_purchase_at,
    (now()::date - max(p.purchased_at)::date)       AS days_since_last  -- NULL = nunca comprou
  FROM commerce.wholesale_suppliers s
  LEFT JOIN commerce.wholesale_purchases p
         ON p.supplier_id = s.id
        AND p.environment = s.environment
        AND p.status = 'confirmed'
  WHERE s.deleted_at IS NULL
  GROUP BY s.id, s.environment, s.name, s.phone;

COMMENT ON VIEW commerce.wholesale_supplier_summary IS
  'Base do ranking de fornecedor (0114): por fornecedor -> nº de compras, total gasto, ultima compra e dias desde. days_since_last NULL = cadastrado mas nunca comprou. security_invoker.';

-- ─────────────────────────────────────────────
-- 6. GRANTS — NENHUM pro parceiro (atacado é da matriz; a dona acessa como owner)
-- ─────────────────────────────────────────────
-- (De propósito SEM `GRANT ... TO farejador_partner_app`, igual 0110: o atacado é
--  single-tenant; o role do parceiro tem ZERO privilégio aqui — provado na §7.)

-- ─────────────────────────────────────────────
-- 7. VALIDAÇÃO PÓS-MIGRATION (tabelas existem + parceiro NÃO enxerga o atacado)
-- ─────────────────────────────────────────────
DO $check$
DECLARE
  v_tbls  INTEGER;
  v_sel   BOOLEAN;
  v_ins   BOOLEAN;
  t       TEXT;
BEGIN
  SELECT count(*) INTO v_tbls
    FROM information_schema.tables
   WHERE table_schema = 'commerce'
     AND table_name IN ('wholesale_suppliers', 'wholesale_purchases', 'wholesale_purchase_items');
  IF v_tbls <> 3 THEN
    RAISE EXCEPTION '0114 falhou: esperava 3 tabelas, achei %', v_tbls;
  END IF;

  FOREACH t IN ARRAY ARRAY['commerce.wholesale_suppliers',
                           'commerce.wholesale_purchases',
                           'commerce.wholesale_purchase_items'] LOOP
    SELECT has_table_privilege('farejador_partner_app', t, 'SELECT') INTO v_sel;
    SELECT has_table_privilege('farejador_partner_app', t, 'INSERT') INTO v_ins;
    IF v_sel OR v_ins THEN
      RAISE EXCEPTION '0114 falhou: farejador_partner_app NAO deveria acessar % (select=%, insert=%)', t, v_sel, v_ins;
    END IF;
  END LOOP;

  RAISE NOTICE '0114 OK: 3 tabelas de fornecedor/compra criadas, ranking view pronta, parceiro SEM acesso.';
END;
$check$;

-- ============================================================
-- ROLLBACK (manual, se precisar):
--   DROP VIEW  IF EXISTS commerce.wholesale_supplier_summary;
--   DROP TABLE IF EXISTS commerce.wholesale_purchase_items;
--   DROP TABLE IF EXISTS commerce.wholesale_purchases;
--   DROP TABLE IF EXISTS commerce.wholesale_suppliers;
-- (triggers/índices caem com as tabelas. Zero dado existente — fundação dormente.)
-- ============================================================
