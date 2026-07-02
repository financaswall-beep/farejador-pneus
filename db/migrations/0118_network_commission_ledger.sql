-- 0118 — COMISSÃO vira LANÇAMENTO (fatia 1 da cobrança da Rede).
-- Regras do dono (2026-07-02, decididas nesta data):
--   1. A comissão NASCE quando a venda REALIZA — mesma régua 0077/0090 do faturamento do
--      parceiro (entrega só quando ENTREGOU; retirada só quando o cliente LEVOU; balcão no
--      fechamento; cancelada nunca).
--   2. Venda cancelada depois → o lançamento ESTORNA sozinho (trilha; não apaga). Se já
--      estava PAGO, fica marcado (status reversed + settled_at preservado = acerto por fora).
--   3. O % vem da FICHA do parceiro (network.partners.commission_percent) e fica CONGELADO
--      no lançamento — mudar a ficha depois NÃO mexe no passado.
--   4. Base = SÓ venda de origem 2W (source_tag='2w' — o que a matriz trouxe); modelo
--      comercial precisa cobrar comissão ('commission' ou 'hybrid').
--   5. FRETE FORA da base (decisão 07-02): frete é serviço de entrega do parceiro —
--      order_total abaixo guarda a BASE (total_amount − freight_amount, clamp em 0).
-- Preenchida por VARREDURA idempotente (sweep no GET da tela; UNIQUE por venda) — nenhum
-- gancho no fluxo do parceiro/bot; auto-corrige o que ficou pra trás.
-- Dado SÓ da matriz: ZERO grant pro farejador_partner_app (regra de ouro; o app do
-- parceiro tem SELECT em partners/partner_units, mas NÃO nesta tabela).
CREATE TABLE IF NOT EXISTS network.commission_entries (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment        text NOT NULL,
  partner_id         uuid NOT NULL,
  partner_unit_id    uuid,
  unit_id            uuid NOT NULL,
  partner_order_id   uuid NOT NULL,
  order_total        numeric NOT NULL,
  commission_percent numeric NOT NULL,
  commission_amount  numeric NOT NULL,
  status             text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'settled', 'reversed')),
  realized_at        timestamptz NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  settled_at         timestamptz,
  settled_by         text,
  reversed_at        timestamptz,
  reversed_reason    text,
  CONSTRAINT commission_entries_order_uniq UNIQUE (environment, partner_order_id)
);

CREATE INDEX IF NOT EXISTS commission_entries_partner_open_idx
  ON network.commission_entries (environment, partner_id)
  WHERE status = 'open';

COMMENT ON TABLE network.commission_entries IS
  'Lançamentos de comissão da Rede (0118): 1 linha por venda 2W REALIZADA do parceiro. % congelado da ficha no momento do lançamento; estorno automático se a venda cancelar. SÓ matriz (zero grant pro parceiro).';
