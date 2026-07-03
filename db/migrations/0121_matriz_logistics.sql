-- ============================================================
-- 0121_matriz_logistics.sql
-- LOGÍSTICA DA MATRIZ — entregas nos moldes do parceiro + diário de rota.
--
-- Contexto (negócio, decisões do dono 2026-07-03):
--   1. A matriz passa a ter a aba Logística: pedido de ENTREGA da matriz
--      (bot ou balcão) vira card com termômetro — em separação → saiu →
--      entregue / não entregue — espelho do parceiro (0068/0069/0082).
--   2. O entregador trabalha por ROTA/SAÍDA do dia (decisão do dono): sai com
--      o carro (km inicial), faz N entregas, volta (km final), informa a
--      gasolina e anexa COMPROVANTES. As entregas do dia penduram na rota.
--   3. O comprovante pode ser lido por IA (flag MATRIZ_RECEIPT_AI) que lança
--      a despesa em commerce.matriz_expenses (0120) SOZINHA, amarrada ao
--      comprovante. Sem confiança → não lança (ai_status 'unreadable').
--
-- ANTI-DUPLA-CONTAGEM (regra de ouro desta obra): a despesa financeira de
-- combustível nasce por UM caminho só —
--   · comprovante lido pela IA (receipts.ai_expense_id), OU
--   · fechamento da rota (trips.fuel_expense_id) quando NENHUM comprovante
--     da rota virou despesa.
-- fuel_spent é o DADO do diário (consumo da rota); não é, por si, lançamento.
--
-- Termômetro × dinheiro: marcar 'delivered' NÃO muda faturamento (a régua do
-- varejo 0117 conta pedido não-cancelado — régua intocada). 'failed' NÃO é
-- estado terminal financeiro: o caminho de verdade é CANCELAR o pedido
-- (cancel_manual_order + devolução do galpão guiada por trilha, conserto
-- fdd9148) — o código marca failed E cancela na mesma transação.
--
-- Regra de ouro do dado: SÓ matriz. ZERO grant pro farejador_partner_app
-- (provado no DO abaixo). Blob de comprovante em tabela SEPARADA (molde 0094:
-- lista/fila nunca arrastam BYTEA; migrar pro Storage quando o volume pedir).
--
-- 100% ADITIVA e DORMENTE (flag MATRIZ_LOGISTICS default OFF; IA atrás de
-- MATRIZ_RECEIPT_AI default OFF). Rollback comentado no fim.
-- Assinatura: Orquestrador (Claude Fable 5) — banco/matriz, 2026-07-03
-- ============================================================

-- ------------------------------------------------------------
-- 1. ROTA do dia (a "saída" do entregador)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS commerce.matriz_delivery_trips (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment     env_t NOT NULL,
  courier_name    TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  km_start        NUMERIC(9,1) CHECK (km_start IS NULL OR km_start >= 0),
  km_end          NUMERIC(9,1) CHECK (km_end IS NULL OR km_end >= 0),
  fuel_spent      NUMERIC(10,2) CHECK (fuel_spent IS NULL OR fuel_spent >= 0),
  fuel_expense_id UUID REFERENCES commerce.matriz_expenses(id),
  notes           TEXT,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at        TIMESTAMPTZ,
  created_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ,
  CHECK (km_end IS NULL OR km_start IS NULL OR km_end >= km_start),
  CHECK (status = 'open' OR ended_at IS NOT NULL)
);

COMMENT ON TABLE commerce.matriz_delivery_trips IS
  '0121: rota/saída do entregador da MATRIZ (decisão do dono: diário por SAÍDA, não por entrega). km_start/km_end = odômetro; fuel_spent = gasolina da rota (dado do diário). fuel_expense_id = despesa 0120 lançada no FECHAMENTO (só quando nenhum comprovante da rota virou despesa — anti-dupla-contagem). SÓ matriz, zero grant parceiro.';
COMMENT ON COLUMN commerce.matriz_delivery_trips.fuel_expense_id IS
  '0121: despesa (0120, categoria combustivel) nascida no fechamento da rota. NULL se a despesa veio de comprovante lido pela IA (receipts.ai_expense_id) ou se fuel_spent não foi informado.';

CREATE INDEX IF NOT EXISTS matriz_trips_open_idx
  ON commerce.matriz_delivery_trips (environment, started_at DESC)
  WHERE status = 'open' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS matriz_trips_recent_idx
  ON commerce.matriz_delivery_trips (environment, started_at DESC)
  WHERE deleted_at IS NULL;

-- ------------------------------------------------------------
-- 2. COMPROVANTES da rota (meta) + blob SEPARADO (molde 0094)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS commerce.matriz_trip_receipts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment   env_t NOT NULL,
  trip_id       UUID NOT NULL REFERENCES commerce.matriz_delivery_trips(id) ON DELETE CASCADE,
  mime          TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL CHECK (size_bytes > 0),
  ai_status     TEXT NOT NULL DEFAULT 'pending'
                  CHECK (ai_status IN ('pending','parsed','unreadable','skipped')),
  ai_expense_id UUID REFERENCES commerce.matriz_expenses(id),
  ai_summary    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ai_status <> 'parsed' OR ai_expense_id IS NOT NULL)
);

COMMENT ON TABLE commerce.matriz_trip_receipts IS
  '0121: comprovante anexado à rota (meta, SEM bytes). ai_status: pending = na fila da IA (ou IA off → skipped); parsed = IA leu e LANÇOU a despesa (ai_expense_id obrigatório); unreadable = IA não teve certeza e NÃO lançou (lançar na mão). ai_summary = o que a IA leu, pra tela mostrar ao lado da foto.';

CREATE INDEX IF NOT EXISTS matriz_trip_receipts_trip_idx
  ON commerce.matriz_trip_receipts (trip_id, created_at DESC);

CREATE TABLE IF NOT EXISTS commerce.matriz_trip_receipt_blobs (
  receipt_id  UUID PRIMARY KEY REFERENCES commerce.matriz_trip_receipts(id) ON DELETE CASCADE,
  environment env_t NOT NULL,
  bytes       BYTEA NOT NULL
);

COMMENT ON TABLE commerce.matriz_trip_receipt_blobs IS
  '0121: bytes do comprovante (JPEG re-encodado pelo servidor — mesmo funil blindado da foto de pneu: magic bytes + re-encode + EXIF fora). 1:1 com matriz_trip_receipts (PK=FK, CASCADE). Tabela separada pra lista nunca arrastar blob (molde 0094).';

-- ------------------------------------------------------------
-- 3. TERMÔMETRO de entrega no pedido da matriz (espelho do 0068)
-- ------------------------------------------------------------
ALTER TABLE commerce.orders
  ADD COLUMN IF NOT EXISTS delivery_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (delivery_status IN ('pending','dispatched','delivered','failed')),
  ADD COLUMN IF NOT EXISTS delivery_courier TEXT,
  ADD COLUMN IF NOT EXISTS dispatched_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS trip_id UUID REFERENCES commerce.matriz_delivery_trips(id);

COMMENT ON COLUMN commerce.orders.delivery_status IS
  '0121: termômetro OPERACIONAL da entrega da MATRIZ (pending|dispatched|delivered|failed), espelho do partner_orders 0068. NÃO muda a régua de faturamento (0117 conta não-cancelado). failed anda JUNTO do cancelamento (galpão volta via trilha fdd9148).';
COMMENT ON COLUMN commerce.orders.trip_id IS
  '0121: rota do entregador que levou este pedido (NULL = fora de rota / retirada / pedido de parceiro).';

-- Backfill honesto: pedido que o sistema já dava por entregue (status do
-- PEDIDO = delivered) não pode renascer como "em separação" na tela nova.
UPDATE commerce.orders
   SET delivery_status = 'delivered',
       delivered_at    = COALESCE(delivered_at, closed_at, updated_at)
 WHERE status = 'delivered'
   AND fulfillment_mode = 'delivery'
   AND delivery_status = 'pending';

-- Fila da logística: entregas ABERTAS da matriz (unit main resolve no JOIN).
CREATE INDEX IF NOT EXISTS orders_delivery_open_idx
  ON commerce.orders (environment, unit_id, created_at DESC)
  WHERE fulfillment_mode = 'delivery'
    AND status <> 'cancelled'
    AND delivery_status IN ('pending','dispatched');

-- ------------------------------------------------------------
-- VALIDAÇÃO PÓS-MIGRATION (tabelas existem + regra de ouro: parceiro ZERO acesso)
-- ------------------------------------------------------------
DO $check$
DECLARE
  t TEXT;
  v_sel BOOLEAN;
  v_ins BOOLEAN;
BEGIN
  IF to_regclass('commerce.matriz_delivery_trips') IS NULL THEN
    RAISE EXCEPTION '0121 falhou: commerce.matriz_delivery_trips nao existe';
  END IF;
  IF to_regclass('commerce.matriz_trip_receipts') IS NULL THEN
    RAISE EXCEPTION '0121 falhou: commerce.matriz_trip_receipts nao existe';
  END IF;
  IF to_regclass('commerce.matriz_trip_receipt_blobs') IS NULL THEN
    RAISE EXCEPTION '0121 falhou: commerce.matriz_trip_receipt_blobs nao existe';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'farejador_partner_app') THEN
    FOREACH t IN ARRAY ARRAY[
      'commerce.matriz_delivery_trips',
      'commerce.matriz_trip_receipts',
      'commerce.matriz_trip_receipt_blobs'
    ] LOOP
      SELECT has_table_privilege('farejador_partner_app', t, 'SELECT') INTO v_sel;
      SELECT has_table_privilege('farejador_partner_app', t, 'INSERT') INTO v_ins;
      IF v_sel OR v_ins THEN
        RAISE EXCEPTION '0121 falhou: farejador_partner_app NAO deveria acessar % (select=%, insert=%)', t, v_sel, v_ins;
      END IF;
    END LOOP;
  END IF;

  RAISE NOTICE '0121 OK: logistica da matriz pronta (dormente, flags MATRIZ_LOGISTICS / MATRIZ_RECEIPT_AI); parceiro sem acesso.';
END;
$check$;

-- ============================================================
-- ROLLBACK (manual, se precisar):
--   DROP INDEX IF EXISTS commerce.orders_delivery_open_idx;
--   ALTER TABLE commerce.orders
--     DROP COLUMN IF EXISTS trip_id,
--     DROP COLUMN IF EXISTS delivered_at,
--     DROP COLUMN IF EXISTS dispatched_at,
--     DROP COLUMN IF EXISTS delivery_courier,
--     DROP COLUMN IF EXISTS delivery_status;
--   DROP TABLE IF EXISTS commerce.matriz_trip_receipt_blobs;
--   DROP TABLE IF EXISTS commerce.matriz_trip_receipts;
--   DROP TABLE IF EXISTS commerce.matriz_delivery_trips;
-- (Aditiva e dormente: com as flags OFF ninguém escreve aqui — rollback seguro.)
-- ============================================================
