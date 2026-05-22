-- ============================================================
-- 0044_partner_rls_policies.sql
-- Etapa 5 da auditoria 2026-05-21 — V2 pos-revisao Codex.
--
-- O que essa migration faz:
--   1. Reconciliacao: recria network.current_partner_unit() e as 7 policies
--      que existem em prod mas nao aparecem nas migrations 0035-0043 do repo
--      (drift identificado pela auditoria — bloqueio 6 do Codex).
--
--   2. Helper novo: network.current_partner_core_unit() que resolve
--      partner_unit_id (network.partner_units.id) -> unit_id (core.units.id),
--      necessario porque tabelas commerce.* e finance.* usam unit_id
--      (bloqueio 2 do Codex).
--
--   3. Function nova: network.validate_partner_token() com SECURITY DEFINER
--      pra permitir login da role restrita sem dar SELECT direto em
--      partner_access_tokens. search_path = pg_catalog, network (bloqueio 4
--      do Codex). REVOKE FROM PUBLIC explicito.
--
--   4. RLS + policies em network.partners e network.partner_access_tokens
--      (que estavam SEM RLS — buraco identificado pela auditoria).
--
--   5. Policies ESTRITAS (sem IS NULL OR — bloqueio 1 do Codex):
--      - Sem GUC setado = zero linhas pra role restrita
--      - Admin/bot continuam vendo tudo via BYPASSRLS da role 'postgres'
--
--   6. security_invoker=true em views consumidas pelo portal restrito
--      (bloqueio 3 do Codex).
--
--   7. GRANTs minimos pra role 'farejador_partner_app' (criada via runbook
--      ANTES desta migration — ver RUNBOOK_ETAPA5_RLS_2026-05-21.md).
--
-- Idempotente: pode rodar 100x em prod sem efeito colateral.
-- Reconciliacao: rodar em banco fresh resulta no mesmo estado de prod.
--
-- Esta migration NAO cria role nem senha — runbook faz isso. Se a role
-- nao existir quando aplicar, o DO final levanta excecao com mensagem clara.
--
-- Assinatura: Claude (Opus 4.7), 2026-05-21 V2 pos-Codex
-- ============================================================

-- ─────────────────────────────────────────────
-- 1. Reconciliacao: function current_partner_unit() (existe em prod)
-- ─────────────────────────────────────────────
-- Le o GUC app.partner_unit_id que guarda network.partner_units.id.
-- Quando GUC nao esta setado, retorna NULL (e a policy estrita bloqueia).
CREATE OR REPLACE FUNCTION network.current_partner_unit()
RETURNS UUID
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.partner_unit_id', true), '')::UUID
$$;

COMMENT ON FUNCTION network.current_partner_unit() IS
  'Retorna network.partner_units.id do contexto atual da request (GUC app.partner_unit_id). NULL se nao setado.';

-- ─────────────────────────────────────────────
-- 2. Helper novo: current_partner_core_unit() (resposta bloqueio 2 Codex)
-- ─────────────────────────────────────────────
-- Resolve network.partner_units.id -> core.units.id.
-- Necessario porque tabelas commerce.partner_* e finance.partner_expenses
-- usam unit_id (= core.units.id), nao o id interno do network.partner_units.
-- STABLE: dentro da mesma transacao, retorna o mesmo valor — Postgres
-- pode cachear chamadas da policy.
CREATE OR REPLACE FUNCTION network.current_partner_core_unit()
RETURNS UUID
LANGUAGE sql
STABLE
AS $$
  SELECT pu.unit_id
  FROM network.partner_units pu
  WHERE pu.id = network.current_partner_unit()
$$;

COMMENT ON FUNCTION network.current_partner_core_unit() IS
  'Resolve network.partner_units.id (do GUC) para o respectivo core.units.id. Usado nas policies de commerce.partner_* e finance.partner_expenses.';

-- ─────────────────────────────────────────────
-- 3. Function validate_partner_token (SECURITY DEFINER, bloqueios 4+5 Codex)
-- ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION network.validate_partner_token(
  p_environment TEXT,
  p_slug        TEXT,
  p_token       TEXT
) RETURNS TABLE (
  partner_unit_id  UUID,
  unit_id          UUID,
  partner_id       UUID,
  slug             TEXT,
  partner_name     TEXT,
  unit_name        TEXT,
  token_id         UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
-- search_path RESTRITO so a pg_catalog (builtins) + network (proprio schema da
-- function). Sem 'public' e sem 'extensions'. Pra isso, o hash e calculado
-- INLINE usando sha256() do pg_catalog em vez de digest() da pgcrypto (que
-- exigiria 'public'/'extensions' no path). Equivalencia matematicamente
-- garantida: encode(sha256(text::bytea), 'hex') = encode(digest(text, 'sha256'), 'hex'),
-- validado contra prod. Tokens existentes continuam validos.
SET search_path = pg_catalog, network
AS $$
DECLARE
  v_hash TEXT;
BEGIN
  -- Hash inline via sha256() nativo (pg_catalog) — NAO usa pgcrypto.
  -- Equivalente a network.hash_partner_token mas sem dependencia de schema
  -- fora de pg_catalog/network.
  v_hash := encode(sha256(p_token::bytea), 'hex');

  RETURN QUERY
  SELECT
    pu.id           AS partner_unit_id,
    pu.unit_id,
    p.id            AS partner_id,
    pu.slug,
    p.trade_name    AS partner_name,
    pu.display_name AS unit_name,
    pat.id          AS token_id
  FROM network.partner_units pu
  JOIN network.partners p
    ON p.id = pu.partner_id AND p.environment = pu.environment
  JOIN network.partner_access_tokens pat
    ON pat.partner_unit_id = pu.id AND pat.environment = pu.environment
  WHERE pu.environment = p_environment
    AND pu.slug = p_slug
    AND pu.status = 'active'
    AND p.status = 'active'
    AND pu.deleted_at IS NULL
    AND p.deleted_at IS NULL
    AND pat.revoked_at IS NULL
    AND pat.token_hash = v_hash
  LIMIT 1;

  IF FOUND THEN
    UPDATE network.partner_access_tokens
    SET last_used_at = now()
    WHERE token_hash = v_hash
      AND environment = p_environment
      AND revoked_at IS NULL;
  END IF;
END;
$$;

COMMENT ON FUNCTION network.validate_partner_token IS
  'Valida token de parceiro. SECURITY DEFINER permite role restrita validar sem SELECT direto em partner_access_tokens. EXECUTE so para farejador_partner_app (PUBLIC revogado). search_path restrito pra prevenir injection.';

-- Bloqueio 4 do Codex: revogar PUBLIC antes de conceder
REVOKE ALL ON FUNCTION network.validate_partner_token(TEXT, TEXT, TEXT) FROM PUBLIC;

-- ─────────────────────────────────────────────
-- 4. ENABLE ROW LEVEL SECURITY em 9 tabelas
--    (7 reconciliacao + 2 novas — bloqueio 6 do Codex)
-- ─────────────────────────────────────────────
ALTER TABLE commerce.partner_orders         ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.partner_order_items    ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.partner_purchases      ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.partner_purchase_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.partner_stock_levels   ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance.partner_expenses        ENABLE ROW LEVEL SECURITY;
ALTER TABLE network.partner_units           ENABLE ROW LEVEL SECURITY;
ALTER TABLE network.partners                ENABLE ROW LEVEL SECURITY;
ALTER TABLE network.partner_access_tokens   ENABLE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────
-- 5. Policies ESTRITAS (V2 — bloqueio 1 do Codex)
-- ─────────────────────────────────────────────

-- 5.1 network.partner_units (id = current_partner_unit)
DROP POLICY IF EXISTS partner_units_isolation ON network.partner_units;
CREATE POLICY partner_units_isolation ON network.partner_units
  FOR ALL
  USING       (network.current_partner_unit() IS NOT NULL AND id = network.current_partner_unit())
  WITH CHECK  (network.current_partner_unit() IS NOT NULL AND id = network.current_partner_unit());

-- 5.2 network.partners (id resolvido via subquery em partner_units)
DROP POLICY IF EXISTS partners_isolation ON network.partners;
CREATE POLICY partners_isolation ON network.partners
  FOR ALL
  USING (
    network.current_partner_unit() IS NOT NULL
    AND id = (
      SELECT partner_id FROM network.partner_units
      WHERE id = network.current_partner_unit()
      LIMIT 1
    )
  )
  WITH CHECK (
    network.current_partner_unit() IS NOT NULL
    AND id = (
      SELECT partner_id FROM network.partner_units
      WHERE id = network.current_partner_unit()
      LIMIT 1
    )
  );

-- 5.3 network.partner_access_tokens (partner_unit_id = current_partner_unit)
DROP POLICY IF EXISTS partner_access_tokens_isolation ON network.partner_access_tokens;
CREATE POLICY partner_access_tokens_isolation ON network.partner_access_tokens
  FOR ALL
  USING       (network.current_partner_unit() IS NOT NULL AND partner_unit_id = network.current_partner_unit())
  WITH CHECK  (network.current_partner_unit() IS NOT NULL AND partner_unit_id = network.current_partner_unit());

-- 5.4 commerce.partner_orders (unit_id = current_partner_core_unit)
DROP POLICY IF EXISTS partner_orders_isolation ON commerce.partner_orders;
CREATE POLICY partner_orders_isolation ON commerce.partner_orders
  FOR ALL
  USING       (network.current_partner_core_unit() IS NOT NULL AND unit_id = network.current_partner_core_unit())
  WITH CHECK  (network.current_partner_core_unit() IS NOT NULL AND unit_id = network.current_partner_core_unit());

-- 5.5 commerce.partner_order_items (via EXISTS no parent)
DROP POLICY IF EXISTS partner_order_items_isolation ON commerce.partner_order_items;
CREATE POLICY partner_order_items_isolation ON commerce.partner_order_items
  FOR ALL
  USING (
    network.current_partner_core_unit() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM commerce.partner_orders po
      WHERE po.id = partner_order_items.order_id
        AND po.unit_id = network.current_partner_core_unit()
    )
  )
  WITH CHECK (
    network.current_partner_core_unit() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM commerce.partner_orders po
      WHERE po.id = partner_order_items.order_id
        AND po.unit_id = network.current_partner_core_unit()
    )
  );

-- 5.6 commerce.partner_stock_levels
DROP POLICY IF EXISTS partner_stock_isolation ON commerce.partner_stock_levels;
CREATE POLICY partner_stock_isolation ON commerce.partner_stock_levels
  FOR ALL
  USING       (network.current_partner_core_unit() IS NOT NULL AND unit_id = network.current_partner_core_unit())
  WITH CHECK  (network.current_partner_core_unit() IS NOT NULL AND unit_id = network.current_partner_core_unit());

-- 5.7 commerce.partner_purchases
DROP POLICY IF EXISTS partner_purchases_isolation ON commerce.partner_purchases;
CREATE POLICY partner_purchases_isolation ON commerce.partner_purchases
  FOR ALL
  USING       (network.current_partner_core_unit() IS NOT NULL AND unit_id = network.current_partner_core_unit())
  WITH CHECK  (network.current_partner_core_unit() IS NOT NULL AND unit_id = network.current_partner_core_unit());

-- 5.8 commerce.partner_purchase_items (via EXISTS no parent)
DROP POLICY IF EXISTS partner_purchase_items_isolation ON commerce.partner_purchase_items;
CREATE POLICY partner_purchase_items_isolation ON commerce.partner_purchase_items
  FOR ALL
  USING (
    network.current_partner_core_unit() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM commerce.partner_purchases pp
      WHERE pp.id = partner_purchase_items.purchase_id
        AND pp.unit_id = network.current_partner_core_unit()
    )
  )
  WITH CHECK (
    network.current_partner_core_unit() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM commerce.partner_purchases pp
      WHERE pp.id = partner_purchase_items.purchase_id
        AND pp.unit_id = network.current_partner_core_unit()
    )
  );

-- 5.9 finance.partner_expenses
DROP POLICY IF EXISTS partner_expenses_isolation ON finance.partner_expenses;
CREATE POLICY partner_expenses_isolation ON finance.partner_expenses
  FOR ALL
  USING       (network.current_partner_core_unit() IS NOT NULL AND unit_id = network.current_partner_core_unit())
  WITH CHECK  (network.current_partner_core_unit() IS NOT NULL AND unit_id = network.current_partner_core_unit());

-- ─────────────────────────────────────────────
-- 6. security_invoker=true em views consumidas pelo portal (bloqueio 3 Codex)
-- ─────────────────────────────────────────────
ALTER VIEW network.partner_unit_summary SET (security_invoker = true);
ALTER VIEW commerce.partner_orders_full SET (security_invoker = true);

-- ─────────────────────────────────────────────
-- 7. GRANTs minimos pra role 'farejador_partner_app'
-- ─────────────────────────────────────────────
-- A role tem que ja existir (criada via runbook). Se nao existir, esses
-- comandos falham aqui com mensagem 'role does not exist'.

-- 7.1 Uso dos schemas
GRANT USAGE ON SCHEMA network  TO farejador_partner_app;
GRANT USAGE ON SCHEMA commerce TO farejador_partner_app;
GRANT USAGE ON SCHEMA finance  TO farejador_partner_app;
GRANT USAGE ON SCHEMA audit    TO farejador_partner_app;
-- USAGE em 'core' e necessario porque os triggers env_match_partner_*_unit
-- (criados pelas migrations 0035 e 0043) executam SELECT em core.units pra
-- validar consistencia de environment. Sem USAGE, INSERT em partner_orders
-- falha com 'permission denied for schema core'.
GRANT USAGE ON SCHEMA core     TO farejador_partner_app;

-- 7.2 Tabelas que portal le/escreve (CRUD basico)
GRANT SELECT, INSERT, UPDATE ON commerce.partner_stock_levels   TO farejador_partner_app;
GRANT SELECT, INSERT, UPDATE ON commerce.partner_orders         TO farejador_partner_app;
GRANT SELECT, INSERT, UPDATE ON commerce.partner_order_items    TO farejador_partner_app;
GRANT SELECT, INSERT, UPDATE ON commerce.partner_purchases      TO farejador_partner_app;
GRANT SELECT, INSERT, UPDATE ON commerce.partner_purchase_items TO farejador_partner_app;
GRANT SELECT, INSERT, UPDATE ON finance.partner_expenses        TO farejador_partner_app;

-- 7.3 Tabelas read-only pra portal (resumo / login)
GRANT SELECT ON network.partner_units TO farejador_partner_app;
GRANT SELECT ON network.partners      TO farejador_partner_app;
-- NAO ha GRANT em network.partner_access_tokens — acesso via function

-- 7.3.1 SELECT em core.units — TRADE-OFF DOCUMENTADO
--
-- Necessario porque os triggers env_match_partner_*_unit (criados pelas
-- migrations 0035 e 0043) executam SELECT em core.units pra validar
-- consistencia de environment quando INSERT/UPDATE em commerce.partner_orders,
-- partner_stock_levels, partner_purchases e finance.partner_expenses.
--
-- EXPOSICAO: a role 'farejador_partner_app' passa a poder fazer SELECT em
-- TODAS as linhas de core.units, incluindo:
--   - id, environment, slug, name
--   - address (TEXT — endereco completo da unidade)
--   - phone (TEXT — telefone da unidade)
--   - is_active, created_at, updated_at
--
-- O que isso significa na pratica:
--   - Parceiro com token valido pode descobrir slug/nome/endereco/telefone
--     de OUTRAS unidades da rede (incluindo a matriz e outros parceiros)
--   - NAO ve dados financeiros (vendas, compras, despesas) dessas unidades —
--     esses continuam protegidos por RLS estrita nas tabelas partner_*
--   - Em pratica, slug/nome dificilmente sao secretos (Wallace ja conhece
--     todos os parceiros). Endereco/phone sao informacoes operacionais.
--
-- TRADE-OFF ACEITO PELA EQUIPE pq:
--   - Trigger env_match nao pode ser bypassed sem quebrar invariante de
--     isolamento prod/test (que e mais critico)
--   - Solucao alternativa (view security_invoker em core.units filtrando
--     por unit do contexto) exigiria refator maior fora do escopo da auditoria
--   - Risco real e baixo: parceiro nao tem rota direta pra fazer SELECT
--     arbitrario em core.units pelo portal (so via SQL injection ou
--     comprometimento de credencial)
--
-- Quando a rede crescer pra > 20 parceiros, vale reavaliar: criar view
-- restritiva ou mover validacao de environment pra constraint declarativa.
GRANT SELECT ON core.units TO farejador_partner_app;

-- 7.3.2 SELECT em commerce.products — TRADE-OFF DOCUMENTADO
--
-- Necessario pelos triggers env_match_partner_stock_product e env_match_
-- partner_purchase_items_product. Tabela e o catalogo de produtos da matriz
-- (modelos de pneu, marcas, codigos). Expor parceiro ao catalogo da matriz
-- e aceitavel — eles ja conhecem a maioria pela operacao do dia-a-dia.
--
-- EXPOSICAO: TODOS os produtos da matriz (product_name, brand, codigo, etc.).
-- NAO inclui preco ou estoque (esses estao em current_prices e stock_levels —
-- nao concedido).
GRANT SELECT ON commerce.products TO farejador_partner_app;

-- 7.4 Audit (so INSERT, registra eventos)
GRANT INSERT ON audit.events TO farejador_partner_app;

-- 7.5 Views consumidas pelo portal (com security_invoker do passo 6)
GRANT SELECT ON network.partner_unit_summary TO farejador_partner_app;
GRANT SELECT ON commerce.partner_orders_full TO farejador_partner_app;

-- 7.6 Functions
GRANT EXECUTE ON FUNCTION network.validate_partner_token(TEXT, TEXT, TEXT)   TO farejador_partner_app;
GRANT EXECUTE ON FUNCTION network.current_partner_unit()                      TO farejador_partner_app;
GRANT EXECUTE ON FUNCTION network.current_partner_core_unit()                 TO farejador_partner_app;
GRANT EXECUTE ON FUNCTION network.hash_partner_token(TEXT)                    TO farejador_partner_app;
GRANT EXECUTE ON FUNCTION commerce.register_partner_local_order(
  TEXT, UUID, TEXT, TEXT, JSONB, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT
) TO farejador_partner_app;
GRANT EXECUTE ON FUNCTION commerce.cancel_partner_local_order(UUID, TEXT, TEXT) TO farejador_partner_app;

-- 7.7 Sequences (garantia futura — gen_random_uuid nao usa)
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA commerce TO farejador_partner_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA finance  TO farejador_partner_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA audit    TO farejador_partner_app;

-- ─────────────────────────────────────────────
-- 8. Validacoes pos-migration (executam dentro da migration)
-- ─────────────────────────────────────────────
DO $$
DECLARE
  v_count INTEGER;
BEGIN
  -- Confirma que role existe e nao tem BYPASSRLS
  SELECT count(*) INTO v_count
  FROM pg_roles
  WHERE rolname = 'farejador_partner_app' AND rolbypassrls = false;
  IF v_count = 0 THEN
    RAISE EXCEPTION '0044 falhou: role farejador_partner_app nao existe ou tem BYPASSRLS. Rode o runbook antes.';
  END IF;

  -- Confirma que RLS esta enable nas 9 tabelas
  SELECT count(*) INTO v_count
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind = 'r'
    AND c.relrowsecurity = true
    AND (
      (n.nspname = 'commerce' AND c.relname IN ('partner_orders', 'partner_order_items',
        'partner_purchases', 'partner_purchase_items', 'partner_stock_levels'))
      OR (n.nspname = 'finance' AND c.relname = 'partner_expenses')
      OR (n.nspname = 'network' AND c.relname IN ('partner_units', 'partners', 'partner_access_tokens'))
    );
  IF v_count <> 9 THEN
    RAISE EXCEPTION '0044 falhou: esperado RLS em 9 tabelas, achou %', v_count;
  END IF;

  -- Confirma que 9 policies foram criadas
  SELECT count(*) INTO v_count
  FROM pg_policies
  WHERE schemaname IN ('commerce', 'finance', 'network')
    AND tablename IN ('partner_orders', 'partner_order_items', 'partner_purchases',
      'partner_purchase_items', 'partner_stock_levels', 'partner_expenses',
      'partner_units', 'partners', 'partner_access_tokens');
  IF v_count <> 9 THEN
    RAISE EXCEPTION '0044 falhou: esperado 9 policies, achou %', v_count;
  END IF;
END $$;
