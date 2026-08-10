-- 0165 - "Recebe pedidos da Rede?" : chave por unidade parceira.
--
-- PROBLEMA (pedido do dono 2026-08): parceiro que quer SO o sistema (painel,
-- frente de caixa, estoque, clientes, financeiro) e NAO quer o bot mandando
-- cliente pra ele. Hoje nao existe como dizer isso: toda unidade ativa entra
-- no roteamento da Rede automaticamente.
--
-- CONTRATO DA COLUNA:
--   true  (padrao) = a unidade CONCORRE no roteamento do bot, exatamente como hoje.
--   false          = o bot NUNCA a escolhe pra pedido, indicacao de loja, reserva
--                    ou pedido de foto. Em compensacao NADA MUDA no sistema dela:
--                    login, painel inteiro, vendas proprias, estoque, financeiro,
--                    historico e pedidos ANTIGOS da Rede seguem visiveis e
--                    operaveis; a Matriz ainda pode mandar pedido MANUAL pra ela.
--
-- Nasce true pra TODAS as unidades (atuais e futuras) => este deploy NAO muda o
-- comportamento de nenhuma loja. A chave e virada uma a uma, pela Matriz.
--
-- QUEM ESCREVE: so a Matriz (rota admin owner-only). O pool restrito do portal
-- do parceiro (farejador_partner_app) segue apenas com o SELECT que ja tinha em
-- partner_units desde a 0044 - nao ganha escrita aqui (validado no bloco final).
--
-- ROLLBACK OPERACIONAL (sem deploy): religar a chave na Matriz.
-- ROLLBACK DE ESQUEMA:
--   ALTER TABLE network.partner_units DROP COLUMN accepts_network_orders;

-- Em etapas (padrao da casa, ver 0154): a migration e replayavel e se recupera
-- de aplicacao parcial. Preserva qualquer false que ja exista (re-execucao nao
-- religa loja que o dono desligou).
ALTER TABLE network.partner_units
  ADD COLUMN IF NOT EXISTS accepts_network_orders BOOLEAN;

UPDATE network.partner_units
   SET accepts_network_orders = true
 WHERE accepts_network_orders IS NULL;

ALTER TABLE network.partner_units
  ALTER COLUMN accepts_network_orders SET DEFAULT true,
  ALTER COLUMN accepts_network_orders SET NOT NULL;

COMMENT ON COLUMN network.partner_units.accepts_network_orders IS
  '0165: a unidade concorre no roteamento do bot? false = "so sistema" (painel inteiro, sem lead da Rede). Escrita so pela Matriz (rota admin owner-only); parceiro nao tem grant de escrita em partner_units.';

-- Indice parcial: as consultas do bot filtram por "= true" e a expectativa e que
-- a esmagadora maioria seja true. O indice serve pro caso inverso (achar as
-- desligadas na tela da Rede) sem custo em tabela pequena.
CREATE INDEX IF NOT EXISTS partner_units_network_orders_off_idx
  ON network.partner_units(environment)
  WHERE accepts_network_orders = false;

-- SMOKE DENTRO DA MIGRATION (padrao 0128/0129): se qualquer garantia falhar, a
-- migration ABORTA e nada e aplicado.
DO $$
DECLARE
  v_nulos INT;
  v_grants INT;
  v_default TEXT;
BEGIN
  SELECT count(*) INTO v_nulos
    FROM network.partner_units
   WHERE accepts_network_orders IS NULL;
  IF v_nulos <> 0 THEN
    RAISE EXCEPTION '0165: % unidade(s) ficaram com accepts_network_orders NULL', v_nulos;
  END IF;

  SELECT column_default INTO v_default
    FROM information_schema.columns
   WHERE table_schema = 'network' AND table_name = 'partner_units'
     AND column_name = 'accepts_network_orders';
  IF v_default IS NULL OR v_default NOT LIKE 'true%' THEN
    RAISE EXCEPTION '0165: DEFAULT da coluna nao ficou true (achei: %) - unidade nova nasceria fora da Rede', COALESCE(v_default, 'NULL');
  END IF;

  -- Zero grant de ESCRITA pro parceiro: a chave e contrato comercial da Matriz.
  SELECT count(*) INTO v_grants
    FROM information_schema.role_table_grants
   WHERE table_schema = 'network' AND table_name = 'partner_units'
     AND grantee = 'farejador_partner_app'
     AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE');
  IF v_grants <> 0 THEN
    RAISE EXCEPTION '0165: parceiro tem % grant(s) de escrita em partner_units - ele poderia religar a propria chave', v_grants;
  END IF;
END $$;
