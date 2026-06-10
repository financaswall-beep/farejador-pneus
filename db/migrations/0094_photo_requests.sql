-- ============================================================
-- 0094_photo_requests.sql
-- Foto sob demanda de pneu usado — fundação de dados (Tijolo 1).
--
-- Contexto: docs/PLANO_FOTO_SOB_DEMANDA_2026-06-10.md (+ ANEXO_ARTEFATOS).
--   Cliente pede foto no WhatsApp -> bot cria "pedido de foto" amarrado à
--   conversa -> card na aba Bate-papo do painel -> borracheiro fotografa ->
--   o sistema manda a foto pro cliente sozinho (Chatwoot) -> 10min sem
--   resposta = fallback honesto. Ao fechar o pedido, a foto gruda no item
--   e aparece no card "Em separação".
--
-- DECISÕES DE ARQUITETURA:
--   - Foto em Postgres BYTEA (não Supabase Storage no MVP), em TABELA
--     SEPARADA (photo_request_blobs 1:1) pra fila/expirador/backup nunca
--     arrastarem blob (decisão do banco, 2ª rodada).
--   - CORREÇÃO sobre o desenho da 2ª rodada (furo achado na implementação):
--     function INVOKER exige grants do invoker, e view security_invoker
--     exige SELECT na tabela base. Fix no padrão da casa (0040/0090 +
--     exigência E2/E6 do seguranca): GRANTS POR COLUNA pro
--     farejador_partner_app — SELECT sem conversation_id/contact_id
--     (anti-bypass vira FÍSICO), UPDATE só em status/was_late/answered_at,
--     INSERT só no blob (RLS WITH CHECK amarra a unidade). INSERT na fila
--     continua EXCLUSIVO do bot-pool (E4).
--
-- 100% ADITIVA. NÃO toca o contrato 0076/0077 (estoque/financeiro).
-- Flag de runtime: PHOTO_REQUESTS (default OFF) — migration dormente.
-- Rollback no fim do arquivo (comentado).
-- Assinatura: Orquestrador + banco (Claude Fable 5 / Opus 4.8), 2026-06-10
-- ============================================================

-- ─────────────────────────────────────────────
-- 1. FILA / MÁQUINA DE ESTADOS (leve — SEM bytes)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS commerce.photo_requests (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment         env_t NOT NULL,
  unit_id             UUID NOT NULL REFERENCES core.units(id),

  -- Endereço de volta (por onde o dispatcher manda a foto ao cliente).
  -- IDs do Chatwoot (BIGINT, coerente com 0070). SEM grant de leitura pro
  -- parceiro (anti-bypass de comissão, E2). Não é FK de propósito: o pedido
  -- pode nascer antes da conversa espelhada existir em partner_conversations.
  conversation_id     BIGINT NOT NULL,
  contact_id          BIGINT,

  -- O que o card mostra (dado de produto, não de cliente).
  tire_size           TEXT NOT NULL,
  brand               TEXT,
  note                TEXT,

  status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN (
                          'pending',              -- criado, esperando foto
                          'answered',             -- borracheiro anexou
                          'sent',                 -- foto despachada pro cliente
                          'expired',              -- 10min sem foto -> fallback enviado
                          'expired_after_answer', -- respondeu mas cliente sumiu
                          'cancelled'             -- pedido fechou sem foto / desistiu
                        )),
  was_late            BOOLEAN NOT NULL DEFAULT false,

  expires_at          TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '10 minutes'),
  answered_at         TIMESTAMPTZ,
  sent_to_customer_at TIMESTAMPTZ,

  -- Amarração pós-venda (bot-pool preenche quando o pedido fecha; card de
  -- separação acha a foto por aqui — SEM coluna nova em partner_order_items).
  order_item_id       UUID REFERENCES commerce.partner_order_items(id),

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE commerce.photo_requests IS
  'Fila/maquina de estados dos pedidos de foto de pneu usado (0094). LEVE: sem bytes (photo_request_blobs 1:1). INSERT/dispatch so bot-pool; parceiro le via partner_photo_queue (grants POR COLUNA, sem conversation_id) e anexa via attach_partner_photo. order_item_id amarra ao item da venda. Flag PHOTO_REQUESTS.';

-- ─────────────────────────────────────────────
-- 2. BLOB (tabela separada, 1:1) — bytes vivem AQUI e só aqui
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS commerce.photo_request_blobs (
  photo_request_id UUID PRIMARY KEY
                     REFERENCES commerce.photo_requests(id) ON DELETE CASCADE,
  environment      env_t NOT NULL,
  unit_id          UUID NOT NULL REFERENCES core.units(id),
  photo_bytes      BYTEA NOT NULL,
  photo_mime       TEXT  NOT NULL
                     CHECK (photo_mime IN ('image/jpeg', 'image/png', 'image/webp')),
  photo_size_bytes INTEGER NOT NULL
                     CHECK (photo_size_bytes > 0 AND photo_size_bytes <= 8388608),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE commerce.photo_request_blobs IS
  'Bytes da foto (BYTEA) 1:1 com photo_requests (PK=FK, ON DELETE CASCADE). Tabela SEPARADA pra fila/backup nunca arrastarem blob. RLS por unidade. Servida so pelo painel (GET image). Migrar pro Storage quando volume justificar.';
COMMENT ON COLUMN commerce.photo_request_blobs.photo_bytes IS
  'JPEG/PNG/WebP re-encodado/comprimido pelo backend (sharp, max 1600px, EXIF strippado). Nunca projetado na fila/view.';

-- ─────────────────────────────────────────────
-- 3. ÍNDICES
-- ─────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS photo_requests_queue_idx
  ON commerce.photo_requests(environment, unit_id, created_at DESC)
  WHERE status IN ('pending', 'answered');

CREATE INDEX IF NOT EXISTS photo_requests_expiring_idx
  ON commerce.photo_requests(expires_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS photo_requests_conversation_idx
  ON commerce.photo_requests(environment, conversation_id);

CREATE INDEX IF NOT EXISTS photo_requests_order_item_idx
  ON commerce.photo_requests(order_item_id)
  WHERE order_item_id IS NOT NULL;

-- ─────────────────────────────────────────────
-- 4. TRIGGERS (updated_at + invariante de ambiente — padrão 0070)
-- ─────────────────────────────────────────────
DROP TRIGGER IF EXISTS photo_requests_set_updated_at ON commerce.photo_requests;
CREATE TRIGGER photo_requests_set_updated_at
  BEFORE UPDATE ON commerce.photo_requests
  FOR EACH ROW EXECUTE FUNCTION network.set_updated_at();

DROP TRIGGER IF EXISTS env_match_photo_requests_unit ON commerce.photo_requests;
CREATE TRIGGER env_match_photo_requests_unit
  BEFORE INSERT OR UPDATE OF environment, unit_id ON commerce.photo_requests
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('core', 'units', 'unit_id');

DROP TRIGGER IF EXISTS env_match_photo_request_blobs_unit ON commerce.photo_request_blobs;
CREATE TRIGGER env_match_photo_request_blobs_unit
  BEFORE INSERT OR UPDATE OF environment, unit_id ON commerce.photo_request_blobs
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('core', 'units', 'unit_id');

-- ─────────────────────────────────────────────
-- 5. RLS — isolamento por unidade (cópia da 0070), nas DUAS tabelas
-- ─────────────────────────────────────────────
ALTER TABLE commerce.photo_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS photo_requests_isolation ON commerce.photo_requests;
CREATE POLICY photo_requests_isolation ON commerce.photo_requests
  FOR ALL
  USING (
    network.current_partner_core_unit() IS NOT NULL
    AND unit_id = network.current_partner_core_unit()
  )
  WITH CHECK (
    network.current_partner_core_unit() IS NOT NULL
    AND unit_id = network.current_partner_core_unit()
  );

ALTER TABLE commerce.photo_request_blobs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS photo_request_blobs_isolation ON commerce.photo_request_blobs;
CREATE POLICY photo_request_blobs_isolation ON commerce.photo_request_blobs
  FOR ALL
  USING (
    network.current_partner_core_unit() IS NOT NULL
    AND unit_id = network.current_partner_core_unit()
  )
  WITH CHECK (
    network.current_partner_core_unit() IS NOT NULL
    AND unit_id = network.current_partner_core_unit()
  );

-- ─────────────────────────────────────────────
-- 6. VIEW DA FILA — whitelist do que o parceiro lê (E2/E16)
-- ─────────────────────────────────────────────
-- security_invoker: permissões e RLS checadas como o PARCEIRO nas tabelas
-- base -> exige os grants POR COLUNA da seção 8 (e é exatamente o que
-- garante que conversation_id/contact_id são ILEGÍVEIS até em query direta).
CREATE OR REPLACE VIEW commerce.partner_photo_queue
WITH (security_invoker = true) AS
  SELECT
    pr.id,
    pr.unit_id,
    pr.tire_size,
    pr.brand,
    pr.note,
    pr.status,
    pr.was_late,
    pr.expires_at,
    pr.answered_at,
    pr.created_at,
    EXISTS (
      SELECT 1 FROM commerce.photo_request_blobs b WHERE b.photo_request_id = pr.id
    ) AS has_photo
  FROM commerce.photo_requests pr;

COMMENT ON VIEW commerce.partner_photo_queue IS
  'Fila de pedidos de foto visivel ao parceiro (0094). security_invoker -> RLS por unidade. WHITELIST: sem conversation_id/contact_id (anti-bypass, E2) nem bytes. has_photo derivada sem expor o BYTEA.';

-- ─────────────────────────────────────────────
-- 7. FUNCTION — anexar a foto (idempotente, FOR UPDATE, INVOKER)
-- ─────────────────────────────────────────────
-- INVOKER (padrão da casa, 0090/cancel_partner_local_order): roda como a
-- role do parceiro DENTRO de withPartnerContext -> RLS esconde linha de
-- outra unidade (FOR UPDATE nem a encontra) e os grants por coluna (§8)
-- limitam o que ela pode escrever. Atomicidade + regra de estado aqui.
CREATE OR REPLACE FUNCTION commerce.attach_partner_photo(
  p_photo_request_id UUID,
  p_photo_bytes      BYTEA,
  p_photo_mime       TEXT,
  p_photo_size_bytes INTEGER
)
RETURNS TABLE (out_status TEXT, out_was_late BOOLEAN, out_attached BOOLEAN)
LANGUAGE plpgsql
SET search_path = commerce, network, pg_temp
AS $function$
DECLARE
  -- public.env_t qualificado: o SET search_path da function nao inclui public
  -- (e nao deve — superficie minima), entao o tipo precisa do schema explicito.
  v_environment public.env_t;
  v_unit_id     UUID;
  v_status      TEXT;
  v_has_blob    BOOLEAN;
  v_was_late    BOOLEAN;
BEGIN
  -- Trava a linha (anti duplo-clique / 2 aparelhos). RLS: linha de outra
  -- unidade é invisível -> NOT FOUND (mesma resposta, não vaza existência).
  SELECT pr.environment, pr.unit_id, pr.status,
         EXISTS (SELECT 1 FROM commerce.photo_request_blobs b
                 WHERE b.photo_request_id = pr.id)
    INTO v_environment, v_unit_id, v_status, v_has_blob
  FROM commerce.photo_requests pr
  WHERE pr.id = p_photo_request_id
  FOR UPDATE;

  IF v_environment IS NULL THEN
    RAISE EXCEPTION 'Pedido de foto nao encontrado (ou de outra unidade): %', p_photo_request_id
      USING ERRCODE = '42501';
  END IF;

  -- Defesa em profundidade (o backend já validou magic bytes + re-encode).
  IF p_photo_bytes IS NULL OR length(p_photo_bytes) = 0 THEN
    RAISE EXCEPTION 'Foto vazia para o pedido %', p_photo_request_id USING ERRCODE = '23514';
  END IF;
  IF p_photo_mime NOT IN ('image/jpeg', 'image/png', 'image/webp') THEN
    RAISE EXCEPTION 'MIME nao permitido (%) para o pedido %', p_photo_mime, p_photo_request_id
      USING ERRCODE = '23514';
  END IF;

  -- Idempotência: já tem foto OU estado terminal -> no-op (devolve estado).
  IF v_has_blob OR v_status IN ('sent', 'cancelled') THEN
    RETURN QUERY SELECT v_status, false, false;
    RETURN;
  END IF;

  v_was_late := v_status IN ('expired', 'expired_after_answer');

  INSERT INTO commerce.photo_request_blobs (
    photo_request_id, environment, unit_id, photo_bytes, photo_mime, photo_size_bytes
  ) VALUES (
    p_photo_request_id, v_environment, v_unit_id, p_photo_bytes, p_photo_mime, p_photo_size_bytes
  );

  UPDATE commerce.photo_requests
  SET status      = 'answered',
      was_late    = (was_late OR v_was_late),
      answered_at = now()
  WHERE id = p_photo_request_id;

  RETURN QUERY SELECT 'answered'::TEXT, v_was_late, true;
END;
$function$;

REVOKE ALL ON FUNCTION commerce.attach_partner_photo(UUID, BYTEA, TEXT, INTEGER) FROM PUBLIC;

COMMENT ON FUNCTION commerce.attach_partner_photo(UUID, BYTEA, TEXT, INTEGER) IS
  'Anexa a foto ao pedido (0094). INVOKER dentro de withPartnerContext -> RLS isola por unidade; grants por coluna limitam a escrita. FOR UPDATE + idempotencia (duplo-clique = no-op). expired -> answered com was_late=true (dispatcher manda chegou-atrasado). Retorna (status, was_late, attached).';

-- ─────────────────────────────────────────────
-- 8. GRANTS — POR COLUNA (anti-bypass físico) + view + function
-- ─────────────────────────────────────────────
-- Fila: leitura SEM as colunas de contato (conversation_id/contact_id ficam
-- ilegíveis até em SELECT direto na tabela — E2 vira física, não convenção).
GRANT SELECT (id, environment, unit_id, tire_size, brand, note, status,
              was_late, expires_at, answered_at, sent_to_customer_at,
              order_item_id, created_at, updated_at)
  ON commerce.photo_requests TO farejador_partner_app;

-- Resposta: só as 3 colunas que a function escreve (E6). FOR UPDATE exige
-- UPDATE em >=1 coluna — coberto por estas.
GRANT UPDATE (status, was_late, answered_at)
  ON commerce.photo_requests TO farejador_partner_app;

-- Blob: INSERT (via function; RLS WITH CHECK amarra a unidade) + SELECT
-- (servir GET image + EXISTS da view). SEM UPDATE/DELETE.
GRANT SELECT, INSERT ON commerce.photo_request_blobs TO farejador_partner_app;

-- View de conveniência (mesmas colunas permitidas da base).
GRANT SELECT ON commerce.partner_photo_queue TO farejador_partner_app;

-- Anexar: pela function (regra de estado + trava).
GRANT EXECUTE ON FUNCTION commerce.attach_partner_photo(UUID, BYTEA, TEXT, INTEGER)
  TO farejador_partner_app;

-- (SEM GRANT INSERT em photo_requests pro parceiro — criar pedido de foto é
--  EXCLUSIVO do bot-pool/owner, E4. Validado na seção 10.)

-- ─────────────────────────────────────────────
-- 9. (reservado — purga de blobs antigos entra como job no Tijolo 5;
--     política proposta: bytes de expired/cancelled > 30d, vendidos > 90d)
-- ─────────────────────────────────────────────

-- ─────────────────────────────────────────────
-- 10. VALIDAÇÃO PÓS-MIGRATION (padrão 0044)
-- ─────────────────────────────────────────────
DO $check$
DECLARE
  v_rls_pr    BOOLEAN;
  v_rls_blob  BOOLEAN;
  v_pol       INTEGER;
  v_can_ins   BOOLEAN;
  v_can_conv  BOOLEAN;
BEGIN
  SELECT relrowsecurity INTO v_rls_pr
    FROM pg_class WHERE oid = 'commerce.photo_requests'::regclass;
  SELECT relrowsecurity INTO v_rls_blob
    FROM pg_class WHERE oid = 'commerce.photo_request_blobs'::regclass;
  SELECT count(*) INTO v_pol
    FROM pg_policies
   WHERE schemaname = 'commerce'
     AND tablename IN ('photo_requests', 'photo_request_blobs');

  IF NOT v_rls_pr OR NOT v_rls_blob THEN
    RAISE EXCEPTION '0094 falhou: RLS nao habilitado (pr=%, blob=%)', v_rls_pr, v_rls_blob;
  END IF;
  IF v_pol < 2 THEN
    RAISE EXCEPTION '0094 falhou: esperava >=2 policies, achei %', v_pol;
  END IF;

  -- E4: parceiro NAO pode criar pedido de foto (INSERT negado na fila).
  SELECT has_table_privilege('farejador_partner_app', 'commerce.photo_requests', 'INSERT')
    INTO v_can_ins;
  IF v_can_ins THEN
    RAISE EXCEPTION '0094 falhou: farejador_partner_app NAO deveria ter INSERT em photo_requests';
  END IF;

  -- E2: parceiro NAO le o endereco de volta (nem a coluna).
  SELECT has_column_privilege('farejador_partner_app', 'commerce.photo_requests',
                              'conversation_id', 'SELECT')
    INTO v_can_conv;
  IF v_can_conv THEN
    RAISE EXCEPTION '0094 falhou: farejador_partner_app NAO deveria ler conversation_id';
  END IF;

  RAISE NOTICE '0094 OK: RLS nas 2 tabelas, % policies, INSERT negado, conversation_id ilegivel.', v_pol;
END;
$check$;

-- ============================================================
-- ROLLBACK (manual, se precisar):
--   DROP FUNCTION IF EXISTS commerce.attach_partner_photo(UUID, BYTEA, TEXT, INTEGER);
--   DROP VIEW     IF EXISTS commerce.partner_photo_queue;
--   DROP TABLE    IF EXISTS commerce.photo_request_blobs;
--   DROP TABLE    IF EXISTS commerce.photo_requests;
-- (triggers/policies/indices/grants caem com as tabelas. Zero dado existente.)
-- ============================================================
