-- 0092: Gancho do valor da INSTALAÇÃO (mão de obra do borracheiro) por loja, em
--       network.partner_units. O cliente que retira/recebe pode instalar na hora; a
--       mão de obra é cobrada à parte (decisão Wallace 2026-06-08).
--
-- GANCHO DORMENTE: o dono ainda vai alinhar o valor com cada borracheiro. Por isso a
-- coluna nasce VAZIA (NULL) e o bot, enquanto vazia, só confirma "instala sim, valor
-- à parte a confirmar" — NUNCA inventa preço e NÃO altera o total de nenhum pedido.
-- Quando o dono preencher o valor de uma loja, o bot passa a cotar "a instalação fica
-- R$ X, paga na loja". A entrada do valor no TOTAL do pedido (contrato financeiro) é um
-- passo SEPARADO e futuro — esta migration só cria a costura, sem ligá-la ao dinheiro.
--
-- 100% ADITIVA / RETROCOMPATÍVEL: só ADD COLUMN IF NOT EXISTS. ZERO DROP de dado.
-- NULL = não configurado → comportamento de hoje, intocado.
--
--   installation_fee_brl = valor da mão de obra de instalação, em reais (NUMERIC).
--               POR loja (cada borracheiro pode cobrar diferente). NULL = não
--               configurado (bot diz "à parte, te confirmo"); 0 = instala de graça.
--
-- ─────────────────────────────────────────────
-- ROLLBACK (reverter o backend que lê esta coluna ANTES da migration):
--   ALTER TABLE network.partner_units
--     DROP COLUMN IF EXISTS installation_fee_brl;
-- ─────────────────────────────────────────────

ALTER TABLE network.partner_units
  ADD COLUMN IF NOT EXISTS installation_fee_brl NUMERIC(10,2);

COMMENT ON COLUMN network.partner_units.installation_fee_brl IS
  'Valor da mão de obra de instalação do pneu (borracheiro), em reais, POR loja. NULL = não configurado: o bot só confirma que instala e diz que o valor é à parte/a confirmar, sem cotar número. Quando preenchido, o bot cota "a instalação fica R$ X, paga na loja". NÃO entra no total do pedido por ora (gancho dormente, decisão Wallace 2026-06-08).';
