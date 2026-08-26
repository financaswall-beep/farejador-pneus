-- 0210_collaborator_panel_module_permissions.sql
-- Permissões por módulo do painel unificado. A Matriz ganha a mesma granularidade
-- que o parceiro; o parceiro deixa de herdar Compras/Catálogo de Estoque.

ALTER TABLE network.matriz_collaborator_operation_permissions
  ADD COLUMN IF NOT EXISTS allow_resumo BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS allow_bot BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS allow_retiradas BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS allow_clientes BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS allow_compras BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS allow_logistica BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS allow_rede BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS allow_marketing BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS allow_colaboradores BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS allow_catalogo BOOLEAN NOT NULL DEFAULT false;

-- Preserva o acesso que um administrador já possuía antes desta migration.
INSERT INTO network.matriz_collaborator_operation_permissions (
  collaborator_id, environment, allow_vendas, allow_estoque, allow_entregas,
  allow_financeiro, allow_resumo, allow_bot, allow_retiradas, allow_clientes,
  allow_compras, allow_logistica, allow_rede, allow_marketing,
  allow_colaboradores, allow_catalogo, updated_by
)
SELECT mc.id, mc.environment,
       mc.job='vendedor' AND mc.work_area='sales',
       mc.job='vendedor' AND mc.work_area='sales',
       mc.job='entregador', true,
       true, true, false, true, true, true, true, false, false, true,
       'migration:0210'
  FROM network.matriz_collaborators mc
 WHERE mc.panel_role='admin' AND mc.revoked_at IS NULL
ON CONFLICT (collaborator_id) DO UPDATE SET
  allow_resumo=true,
  allow_bot=true,
  allow_clientes=true,
  allow_compras=true,
  allow_logistica=true,
  allow_rede=true,
  allow_catalogo=true,
  updated_at=now(),
  updated_by='migration:0210';

ALTER TABLE network.partner_token_permissions
  ADD COLUMN IF NOT EXISTS allow_compras BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS allow_colaboradores BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS allow_catalogo BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE network.partner_unit_permissions
  ADD COLUMN IF NOT EXISTS allow_compras BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS allow_colaboradores BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS allow_catalogo BOOLEAN NOT NULL DEFAULT false;

-- Compatibilidade: quem já podia operar Estoque mantém as leituras que antes
-- eram acopladas a ele. Colaboradores continua fechado até o dono liberar.
UPDATE network.partner_token_permissions
   SET allow_compras=allow_estoque,
       allow_catalogo=allow_estoque,
       updated_at=now()
 WHERE allow_compras=false AND allow_catalogo=false;

UPDATE network.partner_unit_permissions
   SET allow_compras=allow_estoque,
       allow_catalogo=allow_estoque,
       updated_at=now()
 WHERE allow_compras=false AND allow_catalogo=false;

COMMENT ON COLUMN network.partner_token_permissions.allow_colaboradores IS
  'Libera o módulo de equipe da própria unidade; escritas sensíveis continuam restritas ao proprietário.';
COMMENT ON COLUMN network.partner_token_permissions.allow_catalogo IS
  'Libera a leitura do catálogo e compatibilidades da própria unidade.';
COMMENT ON COLUMN network.partner_token_permissions.allow_compras IS
  'Libera compras e recebimentos da própria unidade, separadamente de Estoque.';
