-- 0100 — Permissão e comissão POR PESSOA (Bloco 2 da tela Equipe).
--
-- Contexto (decisão do dono 2026-06-12): hoje a permissão de funcionário é POR LOJA
-- (network.partner_unit_permissions, 1 linha por partner_unit_id) — todos os funcionários
-- da mesma loja veem as MESMAS telas. E a comissão não existe. O Bloco 2 quer:
--   (1) cada PESSOA (vínculo pessoa↔loja = um token de acesso) com SUAS telas;
--   (2) comissão por pessoa: % OU valor fixo, sobre o VALOR CHEIO da venda.
--
-- Chave = token_id (network.partner_access_tokens.id), que é o VÍNCULO pessoa↔loja
-- (0095): a mesma pessoa pode ser owner numa loja e funcionário noutra, com telas e
-- comissão diferentes em cada. É a mesma chave do carimbo da venda (0099,
-- commerce.partner_orders.operator_token_id) → a comissão lê o que a venda gravou.
--
-- ADITIVA e dormente:
--   - Permissão: a resolução no backend passa a ser per-token → SENÃO per-unidade (0087,
--     retrocompat) → SENÃO defaults. SEM linha per-token = comportamento de HOJE intacto.
--   - Comissão: SEM linha = sem comissão (0). Nada paga até o dono configurar.
--
-- GRANTS: nenhum ao pool restrito do portal (farejador_partner_app) — mesmo regime de
--   partner_unit_permissions/partner_people: lidas só pela role postgres (pool admin),
--   default deny. resolvePartnerPermissions e o cálculo de comissão já rodam no pool admin.
--
-- ─────────────────────────────────────────────
-- ROLLBACK (reverter o backend primeiro; o código 0087 lê só partner_unit_permissions):
--   DROP TABLE IF EXISTS network.partner_token_commission;
--   DROP TABLE IF EXISTS network.partner_token_permissions;
-- ─────────────────────────────────────────────

-- ── 1. Permissão por vínculo (pessoa↔loja) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS network.partner_token_permissions (
  token_id         UUID PRIMARY KEY REFERENCES network.partner_access_tokens(id) ON DELETE CASCADE,
  environment      env_t NOT NULL,
  partner_unit_id  UUID NOT NULL,
  allow_vendas     BOOLEAN NOT NULL DEFAULT true,
  allow_estoque    BOOLEAN NOT NULL DEFAULT true,
  allow_pedidos    BOOLEAN NOT NULL DEFAULT true,
  allow_clientes   BOOLEAN NOT NULL DEFAULT true,
  allow_entregas   BOOLEAN NOT NULL DEFAULT true,
  allow_retiradas  BOOLEAN NOT NULL DEFAULT true,
  allow_batepapo   BOOLEAN NOT NULL DEFAULT true,
  allow_resumo     BOOLEAN NOT NULL DEFAULT false,
  allow_financeiro BOOLEAN NOT NULL DEFAULT false,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by       TEXT
);

CREATE INDEX IF NOT EXISTS partner_token_permissions_unit_idx
  ON network.partner_token_permissions (environment, partner_unit_id);

COMMENT ON TABLE network.partner_token_permissions IS
  'Telas liberadas POR PESSOA (vínculo = token_id), Bloco 2 (0100). Resolução no backend: per-token → senão partner_unit_permissions (0087, por loja) → senão defaults. SEM linha = comportamento de hoje. Configurações NUNCA é liberável aqui (cadeado requireOwner cru). Só pool admin (postgres); pool restrito do portal não tem GRANT.';

-- env do vínculo (token) tem de bater com o env desta linha — defesa em profundidade.
DROP TRIGGER IF EXISTS env_match_partner_token_perms ON network.partner_token_permissions;
CREATE TRIGGER env_match_partner_token_perms
  BEFORE INSERT OR UPDATE OF token_id ON network.partner_token_permissions
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('network', 'partner_access_tokens', 'token_id');

-- ── 2. Comissão por vínculo ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS network.partner_token_commission (
  token_id         UUID PRIMARY KEY REFERENCES network.partner_access_tokens(id) ON DELETE CASCADE,
  environment      env_t NOT NULL,
  partner_unit_id  UUID NOT NULL,
  -- 'percent' → value = % (5.00 = 5%); 'fixed' → value = R$ por venda FINALIZADA.
  kind             TEXT NOT NULL DEFAULT 'percent' CHECK (kind IN ('percent', 'fixed')),
  value            NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (value >= 0),
  active           BOOLEAN NOT NULL DEFAULT true,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by       TEXT
);

CREATE INDEX IF NOT EXISTS partner_token_commission_unit_idx
  ON network.partner_token_commission (environment, partner_unit_id)
  WHERE active;

COMMENT ON TABLE network.partner_token_commission IS
  'Comissão POR PESSOA (vínculo = token_id), Bloco 2 (0100). kind=percent (value=%) | fixed (value=R$ por venda finalizada). Base = VALOR CHEIO (commerce.partner_orders.total_amount) das vendas REALIZADAS no mês (mesmo recorte de orders_month da view 0078: status<>cancelled, deleted_at NULL, entrega só se delivered). Comissão = despesa de competência → vira finance.partner_payables ao fechar o mês. SEM linha = 0. Só pool admin (postgres).';

DROP TRIGGER IF EXISTS env_match_partner_token_commission ON network.partner_token_commission;
CREATE TRIGGER env_match_partner_token_commission
  BEFORE INSERT OR UPDATE OF token_id ON network.partner_token_commission
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('network', 'partner_access_tokens', 'token_id');
