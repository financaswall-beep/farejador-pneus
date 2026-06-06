-- 0087: Configurações da Loja + Área de entrega por bairro + Permissões de tela.
--       Camada de dados da FASE 1 do PLANO_CONFIG_LOJA_E_ROTEAMENTO_REDE_2026-06-05.
--
-- Uma tela "Configurações da Loja" passa a guardar, por parceiro: dados da loja
-- (endereço estruturado, horário em texto), MODO de atendimento (entrega/retirada/
-- os dois) e ÁREA de entrega por bairro. O bot lê isso pra responder e (Fase 2)
-- rotear. Esta migration é só a fundação de dados.
--
-- 100% ADITIVA / RETROCOMPATÍVEL: só ADD COLUMN IF NOT EXISTS, CREATE TABLE,
-- troca de UNIQUE por índice funcional, CHECKs e backfill. ZERO DROP de dado.
-- Todo default REPRODUZ o comportamento de HOJE — os 2 parceiros vivos
-- (Anderson/Niterói, Rio do Ouro/Itaboraí) roteiam IDÊNTICO até o dono editar.
--
-- Arbitragens do orquestrador honradas (PLANO §7):
--   A — Horário em TEXTO (não jsonb): o bot só DIZ o horário, não calcula "aberto agora".
--   B — Modo guardado como ENUM service_mode (a régua SQL usa); UI mostra 2 checkboxes.
--   C — Permissões em COLUNAS BOOLEANAS (não jsonb): é autorização, lida todo request,
--       tem que ser explícita, auditável e impossível de vir com chave inesperada.
--
-- ⚠️ COORDENAÇÃO (mesmo deploy): a troca do índice único de network.unit_coverage
-- quebra o `ON CONFLICT (environment, unit_id, municipio)` de createPartnerUnit
-- (src/admin/painel/queries.ts). O ajuste do ON CONFLICT (chave de 4 colunas) SOBE
-- NO MESMO DEPLOY desta migration, senão o cadastro de parceiro novo quebra.
--
-- ─────────────────────────────────────────────
-- ROLLBACK (na ordem):
--   1. (índice) DROP INDEX network.unit_coverage_unit_municipio_bairro_uq;
--      recriar o UNIQUE antigo:
--      ALTER TABLE network.unit_coverage
--        ADD CONSTRAINT unit_coverage_unique UNIQUE (environment, unit_id, municipio);
--      (só é seguro se não houver 2 linhas que colidam na chave antiga — na Fase 1,
--       como ninguém preenche bairro ainda, não há colisão.)
--   2. DROP TABLE network.partner_unit_permissions;
--   3. ALTER TABLE network.unit_coverage DROP COLUMN coverage_kind, DROP COLUMN neighborhood_canonical;
--   4. ALTER TABLE network.partner_units DROP COLUMN service_mode, ... (demais colunas novas).
--   O backend novo (ON CONFLICT de 4 col + leitura das colunas) tem que ser revertido
--   ANTES desta migration — reverter backend primeiro, depois a migration.
-- ─────────────────────────────────────────────

-- ── 1. network.partner_units: dados da loja + modo de atendimento ────────────
-- service_mode default 'both' = atende entrega E retirada, igual hoje (nenhum
-- parceiro é filtrado por modo na Fase 1). opening_hours_text NULL = bot não fala
-- horário. Endereço estruturado prepara a localização futura (reusa o naming que
-- commerce.partner_customers já tem: address_street/number/neighborhood/city).
ALTER TABLE network.partner_units
  ADD COLUMN IF NOT EXISTS service_mode          TEXT NOT NULL DEFAULT 'both',
  ADD COLUMN IF NOT EXISTS opening_hours_text    TEXT,
  ADD COLUMN IF NOT EXISTS address_street        TEXT,
  ADD COLUMN IF NOT EXISTS address_number        TEXT,
  ADD COLUMN IF NOT EXISTS address_neighborhood  TEXT,
  ADD COLUMN IF NOT EXISTS address_city          TEXT,
  ADD COLUMN IF NOT EXISTS address_complement    TEXT,
  ADD COLUMN IF NOT EXISTS cep                   TEXT,
  ADD COLUMN IF NOT EXISTS address_confirmed_at  TIMESTAMPTZ;

-- CHECK do service_mode adicionado à parte (ADD COLUMN não aceita IF NOT EXISTS no
-- CONSTRAINT). DROP IF EXISTS antes torna o re-run idempotente.
ALTER TABLE network.partner_units
  DROP CONSTRAINT IF EXISTS partner_units_service_mode_chk;
ALTER TABLE network.partner_units
  ADD CONSTRAINT partner_units_service_mode_chk
  CHECK (service_mode IN ('delivery', 'pickup', 'both'));

COMMENT ON COLUMN network.partner_units.service_mode IS
  'Modo de atendimento da unidade: delivery|pickup|both. Default both = atende tudo (= comportamento de hoje; nenhum parceiro filtrado por modo na Fase 1). UI mostra 2 checkboxes (entrega/retirada) e mapeia pra este enum (PLANO arbitragem B).';
COMMENT ON COLUMN network.partner_units.opening_hours_text IS
  'Horário de funcionamento em TEXTO LIVRE v1 (ex.: "Seg–Sex 8h–18h, Sáb 8h–12h"). NULL = bot não fala horário. Texto (não jsonb) porque o bot só DIZ o horário, não calcula "aberto agora" (PLANO arbitragem A).';
COMMENT ON COLUMN network.partner_units.address_street IS
  'Rua do endereço da unidade parceira (endereço estruturado; mesmo naming de commerce.partner_customers). NULL = não preenchido.';
COMMENT ON COLUMN network.partner_units.address_number IS
  'Número do endereço da unidade parceira.';
COMMENT ON COLUMN network.partner_units.address_neighborhood IS
  'Bairro do endereço da unidade parceira.';
COMMENT ON COLUMN network.partner_units.address_city IS
  'Município/cidade do endereço da unidade parceira.';
COMMENT ON COLUMN network.partner_units.address_complement IS
  'Complemento do endereço da unidade parceira (referência, ponto de apoio).';
COMMENT ON COLUMN network.partner_units.cep IS
  'CEP do endereço da unidade parceira (texto, sem máscara obrigatória).';
COMMENT ON COLUMN network.partner_units.address_confirmed_at IS
  'Auditoria leve: quando o dono revisou/confirmou o endereço da loja. NULL = nunca confirmado.';

-- ── 2. network.unit_coverage: cobertura por bairro (declarativa na Fase 1) ────
-- neighborhood_canonical NULL = cobre a CIDADE INTEIRA (= comportamento de hoje).
-- Preenchido = cobre só aquele bairro (normalizado lower(unaccent), igual
-- commerce.resolve_neighborhood). coverage_kind default 'city' = as linhas atuais
-- continuam cobrindo a cidade inteira sem nenhuma mudança de match.
ALTER TABLE network.unit_coverage
  ADD COLUMN IF NOT EXISTS neighborhood_canonical TEXT,
  ADD COLUMN IF NOT EXISTS coverage_kind          TEXT NOT NULL DEFAULT 'city';

-- Backfill explícito: toda linha existente (todas sem bairro hoje) é cobertura de
-- cidade. O DEFAULT 'city' já carimba o valor no ADD COLUMN acima; este UPDATE
-- apenas torna a intenção explícita e o resultado idempotente (re-run seguro).
-- WHERE neighborhood_canonical IS NULL garante que NÃO sobrescreve um eventual
-- bairro já preenchido (não existe hoje, mas é a guarda correta).
UPDATE network.unit_coverage
  SET coverage_kind = 'city'
  WHERE neighborhood_canonical IS NULL
    AND coverage_kind IS DISTINCT FROM 'city';

-- CHECK casado kind⇄bairro: 'city' ⇒ bairro NULL; 'neighborhood' ⇒ bairro NOT NULL.
ALTER TABLE network.unit_coverage
  DROP CONSTRAINT IF EXISTS unit_coverage_kind_chk;
ALTER TABLE network.unit_coverage
  ADD CONSTRAINT unit_coverage_kind_chk CHECK (
    (coverage_kind = 'city'         AND neighborhood_canonical IS NULL) OR
    (coverage_kind = 'neighborhood' AND neighborhood_canonical IS NOT NULL)
  );

-- Troca do índice único: a chave antiga (environment, unit_id, municipio) não
-- distingue bairros. Vira índice funcional com coalesce(bairro,'') pra permitir
-- "cidade inteira" (bairro NULL → '') + N bairros no mesmo município sem colidir.
-- DROP da CONSTRAINT antiga (criada como UNIQUE na 0083) + CREATE do índice novo.
ALTER TABLE network.unit_coverage
  DROP CONSTRAINT IF EXISTS unit_coverage_unique;
CREATE UNIQUE INDEX IF NOT EXISTS unit_coverage_unit_municipio_bairro_uq
  ON network.unit_coverage (environment, unit_id, municipio, coalesce(neighborhood_canonical, ''));

COMMENT ON COLUMN network.unit_coverage.neighborhood_canonical IS
  'Bairro canônico (lower(unaccent), igual commerce.resolve_neighborhood) que a unidade cobre. NULL = cobre a CIDADE INTEIRA (= comportamento de hoje). Preenchido = cobre só esse bairro. Fase 1: DECLARATIVO (grava/exibe; o bot ainda não filtra por bairro).';
COMMENT ON COLUMN network.unit_coverage.coverage_kind IS
  'city | neighborhood. Default city = cidade inteira (= hoje). CHECK casado: city⇒neighborhood NULL; neighborhood⇒neighborhood NOT NULL. Contrato p/ o bot (Fase 2): bairro declarado vence cidade-inteira; sem bairro, régua de cidade idêntica à de hoje.';

-- ── 3. network.partner_unit_permissions: permissões de tela ("um perfil só") ──
-- Tabela 1:1 com a unidade (PK = partner_unit_id). COLUNAS BOOLEANAS explícitas
-- (não jsonb): é AUTORIZAÇÃO lida em todo request de funcionário — tem que ser
-- auditável e impossível de vir com chave inesperada (PLANO arbitragem C).
--
-- Defaults reproduzem a Etapa 4 de HOJE: operacional ON; Resumo e Financeiro OFF.
-- NÃO existe coluna 'config': Configurações é cadeado duro — nunca liberável via
-- permissão. A trava real é no backend (requireScreen/requireOwner), não no menu.
--
-- ⚠️ LINHA AUSENTE = comportamento de hoje. O código aplica os MESMOS defaults da
-- Etapa 4 quando não há linha pra unidade — NÃO é preciso existir linha pra valer
-- o comportamento atual. A linha só passa a existir quando o dono salva permissões.
CREATE TABLE IF NOT EXISTS network.partner_unit_permissions (
  partner_unit_id  UUID PRIMARY KEY REFERENCES network.partner_units(id),
  environment      env_t NOT NULL,
  -- Operacional: ON por default (= funcionário de hoje vê tudo isso).
  allow_vendas     BOOLEAN NOT NULL DEFAULT true,
  allow_estoque    BOOLEAN NOT NULL DEFAULT true,
  allow_pedidos    BOOLEAN NOT NULL DEFAULT true,
  allow_clientes   BOOLEAN NOT NULL DEFAULT true,
  allow_entregas   BOOLEAN NOT NULL DEFAULT true,
  allow_batepapo   BOOLEAN NOT NULL DEFAULT true,
  -- Dinheiro: OFF por default (= Etapa 4 de hoje; dono PODE ligar, decisão dele).
  allow_resumo     BOOLEAN NOT NULL DEFAULT false,
  allow_financeiro BOOLEAN NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE network.partner_unit_permissions IS
  'Permissões de tela do FUNCIONÁRIO por unidade ("um perfil só"), 1:1 com partner_units. Colunas booleanas (não jsonb) porque é autorização lida todo request — auditável e à prova de chave inesperada (PLANO arbitragem C). LINHA AUSENTE = aplicar os defaults da Etapa 4 no código (operacional ON, Resumo/Financeiro OFF); não precisa existir linha pro comportamento de hoje valer. NÃO há coluna config: Configurações é cadeado duro (nunca via permissão; trava no backend). Para owner, todas as telas valem sempre (resolvido no código, não aqui).';
COMMENT ON COLUMN network.partner_unit_permissions.allow_resumo IS
  'Funcionário vê a tela Resumo? Default false (= Etapa 4 de hoje). O dono pode ligar (decisão dele).';
COMMENT ON COLUMN network.partner_unit_permissions.allow_financeiro IS
  'Funcionário vê a tela Financeiro? Default false (= Etapa 4 de hoje). O dono pode ligar (decisão dele).';

-- updated_at automático (mesmo helper das demais tabelas network.*).
DROP TRIGGER IF EXISTS partner_unit_permissions_set_updated_at ON network.partner_unit_permissions;
CREATE TRIGGER partner_unit_permissions_set_updated_at
  BEFORE UPDATE ON network.partner_unit_permissions
  FOR EACH ROW EXECUTE FUNCTION network.set_updated_at();

-- env da linha tem de bater com o env da unidade (defesa em profundidade, mesmo
-- padrão de partner_units/partner_sessions).
DROP TRIGGER IF EXISTS env_match_partner_unit_permissions_unit ON network.partner_unit_permissions;
CREATE TRIGGER env_match_partner_unit_permissions_unit
  BEFORE INSERT OR UPDATE OF partner_unit_id ON network.partner_unit_permissions
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('network', 'partner_units', 'partner_unit_id');

DROP TRIGGER IF EXISTS env_immutable_partner_unit_permissions ON network.partner_unit_permissions;
CREATE TRIGGER env_immutable_partner_unit_permissions
  BEFORE UPDATE OF environment ON network.partner_unit_permissions
  FOR EACH ROW EXECUTE FUNCTION ops.enforce_environment_immutable();
