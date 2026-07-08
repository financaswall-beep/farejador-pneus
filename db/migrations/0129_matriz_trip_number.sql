-- ============================================================
-- 0129_matriz_trip_number.sql
-- LOGÍSTICA — NÚMERO AMIGÁVEL DA ROTA (ROTA-0001, ROTA-0002, ...).
--
-- Contexto (auditoria da aba Logística, 2026-07-08 — pedido do dono): a rota
-- só tinha UUID interno + nome do entregador + data. Pra AUDITAR (conferir
-- despesa↔rota no Financeiro, falar "rota 12" com o entregador, achar no
-- histórico), ganha um número humano — MESMO molde do PED-XXXX dos pedidos
-- (0057: sequence + default + backfill + UNIQUE).
--
-- Decisões:
--   • Backfill em ORDEM CRONOLÓGICA (started_at) — as rotas já fechadas em
--     prod ganham número na ordem em que saíram (auditoria retroativa limpa);
--     depois a sequence continua do ponto certo (setval).
--   • Sequence ÚNICA pro banco (test e prod pulam números entre si) — igual
--     ao PED (0057). Consistência da casa > numeração contígua por env.
--
-- 100% ADITIVA. Zero grant pro parceiro (tabela 0121 já nasce sem grant).
-- Rollback no fim. Assinatura: Orquestrador (Claude Fable 5) — banco/matriz, 2026-07-08
-- ============================================================

-- ─────────────────────────────────────────────
-- 1. SEQUENCE + COLUNA
-- ─────────────────────────────────────────────
CREATE SEQUENCE IF NOT EXISTS commerce.trip_number_seq START 1 INCREMENT 1;

ALTER TABLE commerce.matriz_delivery_trips
  ADD COLUMN IF NOT EXISTS trip_number text;

COMMENT ON COLUMN commerce.matriz_delivery_trips.trip_number IS
  'Numero amigavel da rota (0129): ROTA-0001, ... — molde do PED (0057). Backfill cronologico por started_at; novas rotas via DEFAULT da sequence.';

-- ─────────────────────────────────────────────
-- 2. BACKFILL cronológico (started_at) + sequence segue do ponto certo
-- ─────────────────────────────────────────────
WITH ordenadas AS (
  SELECT id, row_number() OVER (ORDER BY started_at ASC, created_at ASC) AS rn
    FROM commerce.matriz_delivery_trips
   WHERE trip_number IS NULL
)
UPDATE commerce.matriz_delivery_trips t
   SET trip_number = 'ROTA-' || lpad(o.rn::text, 4, '0')
  FROM ordenadas o
 WHERE t.id = o.id;

SELECT setval('commerce.trip_number_seq',
              GREATEST((SELECT count(*) FROM commerce.matriz_delivery_trips), 1),
              (SELECT count(*) > 0 FROM commerce.matriz_delivery_trips));

-- ─────────────────────────────────────────────
-- 3. NOT NULL + DEFAULT + UNIQUE (novas rotas numeram sozinhas)
-- ─────────────────────────────────────────────
ALTER TABLE commerce.matriz_delivery_trips
  ALTER COLUMN trip_number SET NOT NULL,
  ALTER COLUMN trip_number SET DEFAULT ('ROTA-' || lpad(nextval('commerce.trip_number_seq')::text, 4, '0'));

DO $uniq$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'matriz_trips_trip_number_unique') THEN
    ALTER TABLE commerce.matriz_delivery_trips
      ADD CONSTRAINT matriz_trips_trip_number_unique UNIQUE (trip_number);
  END IF;
END;
$uniq$;

-- ─────────────────────────────────────────────
-- 4. VALIDAÇÃO — coluna preenchida, default vivo, unicidade, parceiro sem grant
-- ─────────────────────────────────────────────
DO $check$
DECLARE
  v_null INTEGER;
  v_def  TEXT;
  v_sel  BOOLEAN;
BEGIN
  SELECT count(*) INTO v_null FROM commerce.matriz_delivery_trips WHERE trip_number IS NULL;
  IF v_null > 0 THEN
    RAISE EXCEPTION '0129 falhou: % rota(s) sem numero apos backfill', v_null;
  END IF;

  SELECT column_default INTO v_def
    FROM information_schema.columns
   WHERE table_schema='commerce' AND table_name='matriz_delivery_trips' AND column_name='trip_number';
  IF v_def IS NULL OR v_def NOT LIKE '%trip_number_seq%' THEN
    RAISE EXCEPTION '0129 falhou: default da sequence nao ficou (%)', v_def;
  END IF;

  SELECT has_table_privilege('farejador_partner_app', 'commerce.matriz_delivery_trips', 'SELECT') INTO v_sel;
  IF v_sel THEN
    RAISE EXCEPTION '0129 falhou: farejador_partner_app NAO deveria ler matriz_delivery_trips';
  END IF;

  RAISE NOTICE '0129 OK: rotas numeradas (ROTA-XXXX), default vivo, parceiro sem acesso.';
END;
$check$;

-- ============================================================
-- ROLLBACK (manual, se precisar):
--   ALTER TABLE commerce.matriz_delivery_trips
--     DROP CONSTRAINT IF EXISTS matriz_trips_trip_number_unique,
--     ALTER COLUMN trip_number DROP NOT NULL,
--     ALTER COLUMN trip_number DROP DEFAULT;
--   ALTER TABLE commerce.matriz_delivery_trips DROP COLUMN IF EXISTS trip_number;
--   DROP SEQUENCE IF EXISTS commerce.trip_number_seq;
-- ============================================================
