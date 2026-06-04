-- 0083: cobertura de região por TABELA (substitui PARTNER_COVERAGE hardcoded em fulfillment.ts)
--       + coluna `role` no token de acesso (prepara níveis dono/funcionário).
--
-- Etapa 1 do PLANO_ONBOARDING_REDE_2026-06-04: adicionar parceiro = dado, não código.
-- Aditiva: cria tabela nova + coluna nova com default; não altera comportamento até o
-- código do bot passar a LER daqui (mudança separada).

CREATE TABLE IF NOT EXISTS network.unit_coverage (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment text NOT NULL,
  unit_id     uuid NOT NULL REFERENCES core.units(id),
  municipio   text NOT NULL,  -- NORMALIZADO: sem acento, minúsculo (igual normalizeRegion no app)
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT unit_coverage_unique UNIQUE (environment, unit_id, municipio)
);
COMMENT ON TABLE network.unit_coverage IS
  'Municípios que cada unidade parceira cobre. Substitui PARTNER_COVERAGE hardcoded. municipio normalizado (sem acento, minúsculo). Adicionar parceiro numa região = inserir linha aqui.';

-- Papel do token: prepara níveis de acesso (dono vê financeiro; funcionário, não).
-- Default 'owner' não quebra tokens existentes (todos viram dono).
ALTER TABLE network.partner_access_tokens
  ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'owner';
ALTER TABLE network.partner_access_tokens
  ADD CONSTRAINT partner_access_tokens_role_chk CHECK (role IN ('owner', 'funcionario'));

-- Seed: a cobertura que estava hardcoded (Borracharia Rio do Ouro -> Itaboraí).
INSERT INTO network.unit_coverage (environment, unit_id, municipio)
VALUES ('prod', '36203e18-c3fb-4201-bca1-b15c605faa37', 'itaborai')
ON CONFLICT (environment, unit_id, municipio) DO NOTHING;
