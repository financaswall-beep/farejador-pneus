-- ============================================================
-- 0110_wholesale_atacado_foundation.sql
-- ATACADO (Fase 1) — FUNDAÇÃO DE DADOS: registro de venda + ranking de recompra.
--
-- Contexto (negócio): a Matriz (unidade slug='main', NÃO é parceiro) vende pneu no
-- ATACADO pros borracheiros — o "filé" do dono, invisível na matriz até agora. Esta
-- migration cria SÓ o registro da venda e a base do ranking de recompra (quem compra
-- mais, última compra, quem sumiu). NÃO mexe em estoque nem financeiro.
--
-- Decisões do dono (2026-06-19) que moldam o desenho:
--   • EXISTE borracheiro só-atacado (compra pneu, fora do bot/comissão) → o comprador
--     pode ser (a) um parceiro que já existe (partner_id) OU (b) um cliente só-atacado
--     com cadastro leve (nome+telefone, partner_id NULL). UMA tabela cobre os dois.
--   • Preço DIGITADO por venda (negocia caso a caso) → unit_price livre por item,
--     SEM tabela de preço fixa.
--
-- Segurança: atacado é dado SÓ DA MATRIZ (single-tenant; a matriz conecta como dono
-- via DATABASE_URL e passa por cima de RLS). A regra de ouro: o painel do parceiro
-- (role farejador_partner_app) NÃO PODE enxergar o atacado do dono → ZERO grant a ele,
-- provado no bloco de validação (§7). Sem RLS de propósito (não há multi-parceiro a
-- isolar aqui; o único leitor é a dona). seguranca revisa antes do prod.
--
-- 100% ADITIVA. NÃO toca o contrato 0076/0077 (estoque/financeiro) nem nada do parceiro.
-- DORMENTE até a UI/backend da Fase 1 subir (esta migration só cria as tabelas vazias).
-- Rollback no fim do arquivo (comentado).
-- Assinatura: Orquestrador (Claude Opus 4.8) — banco/matriz, 2026-06-19
-- ============================================================

-- ─────────────────────────────────────────────
-- 1. FICHA DO COMPRADOR DE ATACADO (parceiro OU só-atacado)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS commerce.wholesale_customers (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment  env_t NOT NULL,

  -- Quem é o borracheiro. Se for parceiro da rede, partner_id aponta pra ficha dele
  -- (e name/phone podem espelhar o trade_name/whatsapp pra exibir rápido). Se for
  -- SÓ-ATACADO, partner_id é NULL e name/phone são o cadastro leve.
  partner_id   UUID REFERENCES network.partners(id),
  name         TEXT NOT NULL,
  phone        TEXT,
  notes        TEXT,

  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ
);

COMMENT ON TABLE commerce.wholesale_customers IS
  'Ficha do comprador de atacado da Matriz (0110). partner_id setado = borracheiro que TAMBEM e parceiro da rede; NULL = cliente so-atacado (cadastro leve nome+telefone). Dado SO da matriz: SEM grant pro farejador_partner_app.';

-- 1 ficha por parceiro (não duplicar o vínculo). Parcial: só quando é parceiro e está vivo.
CREATE UNIQUE INDEX IF NOT EXISTS wholesale_customers_partner_uniq
  ON commerce.wholesale_customers(environment, partner_id)
  WHERE partner_id IS NOT NULL AND deleted_at IS NULL;

-- Busca por nome no formulário/ranking.
CREATE INDEX IF NOT EXISTS wholesale_customers_name_idx
  ON commerce.wholesale_customers(environment, name)
  WHERE deleted_at IS NULL;

-- ─────────────────────────────────────────────
-- 2. VENDA DE ATACADO (cabeçalho)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS commerce.wholesale_orders (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment   env_t NOT NULL,

  buyer_id      UUID NOT NULL REFERENCES commerce.wholesale_customers(id),

  sold_at       TIMESTAMPTZ NOT NULL DEFAULT now(),   -- data da venda (pode retroagir)
  total_amount  NUMERIC(12, 2) NOT NULL DEFAULT 0
                  CHECK (total_amount >= 0),           -- somatório dos itens (app preenche)
  status        TEXT NOT NULL DEFAULT 'confirmed'
                  CHECK (status IN ('confirmed', 'cancelled')),  -- cancela sem apagar
  created_by    TEXT,                                  -- quem registrou (trilha; matriz)
  notes         TEXT,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE commerce.wholesale_orders IS
  'Venda de atacado da Matriz (0110, Fase 1). Cabecalho: comprador, data, total, status. NAO mexe em estoque/financeiro (isso e Fase 2/3). Dado SO da matriz: SEM grant pro farejador_partner_app.';

-- Ranking de recompra: agrupar por comprador, mais recente primeiro.
CREATE INDEX IF NOT EXISTS wholesale_orders_buyer_idx
  ON commerce.wholesale_orders(environment, buyer_id, sold_at DESC)
  WHERE status = 'confirmed';

-- Linha do tempo geral das vendas de atacado.
CREATE INDEX IF NOT EXISTS wholesale_orders_sold_idx
  ON commerce.wholesale_orders(environment, sold_at DESC);

-- ─────────────────────────────────────────────
-- 3. ITENS DA VENDA (os pneus) — preço DIGITADO por venda
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS commerce.wholesale_order_items (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment  env_t NOT NULL,

  order_id     UUID NOT NULL REFERENCES commerce.wholesale_orders(id) ON DELETE CASCADE,

  measure      TEXT NOT NULL,                          -- medida do pneu (ex.: '80/90-21')
  brand        TEXT,                                   -- marca (opcional)
  quantity     INTEGER NOT NULL CHECK (quantity > 0),
  unit_price   NUMERIC(12, 2) NOT NULL CHECK (unit_price >= 0),  -- digitado por venda
  line_total   NUMERIC(12, 2) GENERATED ALWAYS AS (quantity * unit_price) STORED,

  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE commerce.wholesale_order_items IS
  'Itens da venda de atacado (0110). measure/brand livres (atacado vende medida fora de catalogo); preco DIGITADO por venda (unit_price), line_total gerado. Catalogo/estoque so na Fase 2.';

CREATE INDEX IF NOT EXISTS wholesale_order_items_order_idx
  ON commerce.wholesale_order_items(order_id);

-- ─────────────────────────────────────────────
-- 4. TRIGGERS — updated_at + invariante de ambiente (padrão 0105)
-- ─────────────────────────────────────────────
DROP TRIGGER IF EXISTS wholesale_customers_set_updated_at ON commerce.wholesale_customers;
CREATE TRIGGER wholesale_customers_set_updated_at
  BEFORE UPDATE ON commerce.wholesale_customers
  FOR EACH ROW EXECUTE FUNCTION network.set_updated_at();

DROP TRIGGER IF EXISTS wholesale_orders_set_updated_at ON commerce.wholesale_orders;
CREATE TRIGGER wholesale_orders_set_updated_at
  BEFORE UPDATE ON commerce.wholesale_orders
  FOR EACH ROW EXECUTE FUNCTION network.set_updated_at();

-- env-match: o vínculo parceiro tem que ser do mesmo ambiente (NULL é ignorado pela função).
DROP TRIGGER IF EXISTS env_match_wholesale_customers_partner ON commerce.wholesale_customers;
CREATE TRIGGER env_match_wholesale_customers_partner
  BEFORE INSERT OR UPDATE OF environment, partner_id ON commerce.wholesale_customers
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('network', 'partners', 'partner_id');

DROP TRIGGER IF EXISTS env_match_wholesale_orders_buyer ON commerce.wholesale_orders;
CREATE TRIGGER env_match_wholesale_orders_buyer
  BEFORE INSERT OR UPDATE OF environment, buyer_id ON commerce.wholesale_orders
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('commerce', 'wholesale_customers', 'buyer_id');

DROP TRIGGER IF EXISTS env_match_wholesale_items_order ON commerce.wholesale_order_items;
CREATE TRIGGER env_match_wholesale_items_order
  BEFORE INSERT OR UPDATE OF environment, order_id ON commerce.wholesale_order_items
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('commerce', 'wholesale_orders', 'order_id');

-- environment IMUTÁVEL após INSERT (senão dá pra burlar o env_match invertendo só o
-- ambiente da linha — padrão 0021, obrigatório em toda tabela env_t que sofre UPDATE).
DROP TRIGGER IF EXISTS env_immutable_wholesale_customers ON commerce.wholesale_customers;
CREATE TRIGGER env_immutable_wholesale_customers
  BEFORE UPDATE OF environment ON commerce.wholesale_customers
  FOR EACH ROW EXECUTE FUNCTION ops.enforce_environment_immutable();

DROP TRIGGER IF EXISTS env_immutable_wholesale_orders ON commerce.wholesale_orders;
CREATE TRIGGER env_immutable_wholesale_orders
  BEFORE UPDATE OF environment ON commerce.wholesale_orders
  FOR EACH ROW EXECUTE FUNCTION ops.enforce_environment_immutable();

DROP TRIGGER IF EXISTS env_immutable_wholesale_items ON commerce.wholesale_order_items;
CREATE TRIGGER env_immutable_wholesale_items
  BEFORE UPDATE OF environment ON commerce.wholesale_order_items
  FOR EACH ROW EXECUTE FUNCTION ops.enforce_environment_immutable();

-- ─────────────────────────────────────────────
-- 5. VIEW DO RANKING DE RECOMPRA (a base do "quem compra / quem sumiu")
-- ─────────────────────────────────────────────
CREATE OR REPLACE VIEW commerce.wholesale_buyer_summary
WITH (security_invoker = true) AS
  SELECT
    c.id                                            AS buyer_id,
    c.environment,
    c.partner_id,
    c.name,
    c.phone,
    (c.partner_id IS NOT NULL)                      AS is_partner,
    count(o.id)                                     AS orders_count,
    COALESCE(sum(o.total_amount), 0)                AS total_bought,
    max(o.sold_at)                                  AS last_purchase_at,
    (now()::date - max(o.sold_at)::date)            AS days_since_last  -- NULL = nunca comprou
  FROM commerce.wholesale_customers c
  LEFT JOIN commerce.wholesale_orders o
         ON o.buyer_id = c.id
        AND o.environment = c.environment
        AND o.status = 'confirmed'
  WHERE c.deleted_at IS NULL
  GROUP BY c.id, c.environment, c.partner_id, c.name, c.phone;

COMMENT ON VIEW commerce.wholesale_buyer_summary IS
  'Base do ranking de recompra do atacado (0110): por comprador -> nº de compras, total comprado, ultima compra e dias desde. days_since_last NULL = cadastrado mas nunca comprou. O alerta "sumiu" (limiar de dias) e aplicado no app. security_invoker.';

-- ─────────────────────────────────────────────
-- 6. GRANTS — NENHUM pro parceiro (atacado é da matriz; a dona acessa como owner)
-- ─────────────────────────────────────────────
-- (De propósito SEM `GRANT ... TO farejador_partner_app`. A matriz conecta como
--  postgres/owner via DATABASE_URL e já lê/escreve direto. Provado na §7 que o role
--  do parceiro tem ZERO privilégio nestas tabelas — regra de ouro do atacado.)

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
     AND table_name IN ('wholesale_customers', 'wholesale_orders', 'wholesale_order_items');
  IF v_tbls <> 3 THEN
    RAISE EXCEPTION '0110 falhou: esperava 3 tabelas wholesale_*, achei %', v_tbls;
  END IF;

  -- Regra de ouro: o role do parceiro NÃO pode ler nem escrever o atacado do dono.
  FOREACH t IN ARRAY ARRAY['commerce.wholesale_customers',
                           'commerce.wholesale_orders',
                           'commerce.wholesale_order_items'] LOOP
    SELECT has_table_privilege('farejador_partner_app', t, 'SELECT') INTO v_sel;
    SELECT has_table_privilege('farejador_partner_app', t, 'INSERT') INTO v_ins;
    IF v_sel OR v_ins THEN
      RAISE EXCEPTION '0110 falhou: farejador_partner_app NAO deveria acessar % (select=%, insert=%)', t, v_sel, v_ins;
    END IF;
  END LOOP;

  RAISE NOTICE '0110 OK: 3 tabelas wholesale_* criadas, ranking view pronta, parceiro SEM acesso ao atacado.';
END;
$check$;

-- ============================================================
-- ROLLBACK (manual, se precisar):
--   DROP VIEW  IF EXISTS commerce.wholesale_buyer_summary;
--   DROP TABLE IF EXISTS commerce.wholesale_order_items;
--   DROP TABLE IF EXISTS commerce.wholesale_orders;
--   DROP TABLE IF EXISTS commerce.wholesale_customers;
-- (triggers/índices caem com as tabelas. Zero dado existente — fundação dormente.)
-- ============================================================
