-- 0194 - Correcoes da auditoria ponta a ponta da Rede.
--
-- Escopo:
--   1. consumir a chave bruta de primeiro acesso sem revogar a conta/sessoes;
--   2. impedir termos comerciais incompletos;
--   3. persistir a decisao deterministica de roteamento por conversa;
--   4. retirar unidades de fixture zz-teste-* do roteamento de producao.

-- ---------------------------------------------------------------------------
-- Chave bruta de primeiro acesso e recuperacao
-- ---------------------------------------------------------------------------

ALTER TABLE network.partner_access_tokens
  ADD COLUMN IF NOT EXISTS raw_access_consumed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS recovery_token_hash TEXT,
  ADD COLUMN IF NOT EXISTS recovery_token_consumed_at TIMESTAMPTZ;

-- Contas que ja definiram credenciais nao podem continuar aceitando a chave
-- bruta antiga como uma credencial permanente de proprietario.
UPDATE network.partner_access_tokens
   SET raw_access_consumed_at=COALESCE(login_password_set_at,last_used_at,now())
 WHERE role='owner'
   AND raw_access_consumed_at IS NULL
   AND (login_password_hash IS NOT NULL OR person_id IS NOT NULL);

COMMENT ON COLUMN network.partner_access_tokens.raw_access_consumed_at IS
  'Quando preenchido, o token_hash nao autentica mais diretamente. A linha continua ativa para usuario, senha e sessoes.';
COMMENT ON COLUMN network.partner_access_tokens.recovery_token_hash IS
  'Hash da chave temporaria de recuperacao. Rotaciona na mesma conta sem criar outro usuario ou revogar sessoes.';

CREATE UNIQUE INDEX IF NOT EXISTS partner_access_tokens_recovery_hash_uniq
  ON network.partner_access_tokens(environment,recovery_token_hash)
  WHERE recovery_token_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS partner_access_tokens_raw_access_idx
  ON network.partner_access_tokens(environment,partner_unit_id,role)
  WHERE revoked_at IS NULL AND raw_access_consumed_at IS NULL;

CREATE OR REPLACE FUNCTION network.guard_partner_raw_access_consumption()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.raw_access_consumed_at IS NOT NULL
     AND NEW.raw_access_consumed_at IS DISTINCT FROM OLD.raw_access_consumed_at THEN
    RAISE EXCEPTION 'partner_raw_access_consumption_immutable';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS partner_raw_access_consumption_immutable
  ON network.partner_access_tokens;
CREATE TRIGGER partner_raw_access_consumption_immutable
BEFORE UPDATE OF raw_access_consumed_at ON network.partner_access_tokens
FOR EACH ROW EXECUTE FUNCTION network.guard_partner_raw_access_consumption();

-- A assinatura permanece igual, mas a linha consumida deixa de autenticar pela
-- chave bruta. Login por usuario/senha e sessoes continuam lendo a mesma linha.
CREATE OR REPLACE FUNCTION network.validate_partner_token(
  p_environment TEXT,
  p_slug TEXT,
  p_token TEXT
) RETURNS TABLE (
  partner_unit_id UUID,
  unit_id UUID,
  partner_id UUID,
  slug TEXT,
  partner_name TEXT,
  unit_name TEXT,
  token_id UUID,
  role TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,network
AS $function$
DECLARE
  v_hash TEXT;
BEGIN
  v_hash := encode(sha256(p_token::bytea),'hex');
  RETURN QUERY
  SELECT pu.id,pu.unit_id,p.id,pu.slug,p.trade_name,pu.display_name,pat.id,pat.role
    FROM network.partner_units pu
    JOIN network.partners p
      ON p.id=pu.partner_id AND p.environment=pu.environment
    JOIN network.partner_access_tokens pat
      ON pat.partner_unit_id=pu.id AND pat.environment=pu.environment
   WHERE pu.environment=p_environment
     AND pu.slug=p_slug
     AND pu.status='active' AND p.status='active'
     AND pu.deleted_at IS NULL AND p.deleted_at IS NULL
     AND pat.revoked_at IS NULL
     AND ((pat.raw_access_consumed_at IS NULL AND pat.token_hash=v_hash)
       OR (pat.recovery_token_consumed_at IS NULL
         AND pat.recovery_token_hash=v_hash))
   LIMIT 1;
  IF FOUND THEN
    UPDATE network.partner_access_tokens
       SET last_used_at=now()
     WHERE environment=p_environment AND revoked_at IS NULL
       AND ((raw_access_consumed_at IS NULL AND token_hash=v_hash)
         OR (recovery_token_consumed_at IS NULL
           AND recovery_token_hash=v_hash));
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION network.validate_partner_token(TEXT,TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION network.validate_partner_token(TEXT,TEXT,TEXT)
  TO farejador_partner_app;

-- ---------------------------------------------------------------------------
-- Termos comerciais completos e explicitos
-- ---------------------------------------------------------------------------

-- Preserva o efeito economico anterior (NULL era tratado como zero), mas deixa
-- o zero explicito e remove valores que nao pertencem ao modelo escolhido.
UPDATE network.partners
   SET commission_percent=CASE
         WHEN commercial_model IN ('commission','hybrid')
           THEN COALESCE(commission_percent,0)
         ELSE NULL END,
       monthly_fee=CASE
         WHEN commercial_model IN ('monthly','hybrid')
           THEN COALESCE(monthly_fee,0)
         ELSE NULL END
 WHERE (commercial_model IN ('commission','hybrid') AND commission_percent IS NULL)
    OR (commercial_model='monthly' AND commission_percent IS NOT NULL)
    OR (commercial_model IN ('monthly','hybrid') AND monthly_fee IS NULL)
    OR (commercial_model='commission' AND monthly_fee IS NOT NULL);

ALTER TABLE network.partners
  ALTER COLUMN commission_percent SET DEFAULT 0;

ALTER TABLE network.partners
  DROP CONSTRAINT IF EXISTS partner_commercial_terms_complete_check;
ALTER TABLE network.partners
  ADD CONSTRAINT partner_commercial_terms_complete_check CHECK (
    (commercial_model='commission'
      AND commission_percent IS NOT NULL AND monthly_fee IS NULL)
    OR
    (commercial_model='monthly'
      AND commission_percent IS NULL AND monthly_fee IS NOT NULL)
    OR
    (commercial_model='hybrid'
      AND commission_percent IS NOT NULL AND monthly_fee IS NOT NULL)
  );

-- Fixtures antigas eram unidades ativas de prod e participavam da selecao do
-- bot. O portal continua acessivel; somente a entrada de novos leads e desligada.
UPDATE network.partner_units
   SET accepts_network_orders=false,updated_at=now()
 WHERE environment='prod' AND slug LIKE 'zz-teste-%'
   AND deleted_at IS NULL AND accepts_network_orders IS DISTINCT FROM false;

-- ---------------------------------------------------------------------------
-- Fonte causal do funil da Rede
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ops.partner_routing_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment env_t NOT NULL,
  conversation_id UUID NOT NULL REFERENCES core.conversations(id) ON DELETE CASCADE,
  unit_id UUID REFERENCES core.units(id),
  decision_kind TEXT NOT NULL
    CHECK (decision_kind IN ('partner','matrix','only_far','unresolved')),
  municipio TEXT,
  modality TEXT CHECK (modality IS NULL OR modality IN ('delivery','pickup','quote')),
  first_decided_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (environment,conversation_id),
  CHECK ((decision_kind IN ('partner','only_far') AND unit_id IS NOT NULL)
      OR (decision_kind IN ('matrix','unresolved') AND unit_id IS NULL))
);

COMMENT ON TABLE ops.partner_routing_decisions IS
  'Ultima decisao deterministica de roteamento da conversa. Fonte causal do funil da Rede antes de existir pedido.';

CREATE INDEX IF NOT EXISTS partner_routing_decisions_unit_date_idx
  ON ops.partner_routing_decisions(environment,unit_id,decided_at DESC);

DROP TRIGGER IF EXISTS env_match_partner_routing_conversation
  ON ops.partner_routing_decisions;
CREATE TRIGGER env_match_partner_routing_conversation
BEFORE INSERT OR UPDATE OF environment,conversation_id
ON ops.partner_routing_decisions
FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match(
  'core','conversations','conversation_id');

DROP TRIGGER IF EXISTS env_match_partner_routing_unit
  ON ops.partner_routing_decisions;
CREATE TRIGGER env_match_partner_routing_unit
BEFORE INSERT OR UPDATE OF environment,unit_id
ON ops.partner_routing_decisions
FOR EACH ROW WHEN (NEW.unit_id IS NOT NULL)
EXECUTE FUNCTION ops.validate_env_match('core','units','unit_id');

DROP TRIGGER IF EXISTS env_immutable_partner_routing_decisions
  ON ops.partner_routing_decisions;
CREATE TRIGGER env_immutable_partner_routing_decisions
BEFORE UPDATE OF environment ON ops.partner_routing_decisions
FOR EACH ROW EXECUTE FUNCTION ops.enforce_environment_immutable();

-- Pedidos antigos sao prova definitiva da unidade escolhida.
INSERT INTO ops.partner_routing_decisions
  (environment,conversation_id,unit_id,decision_kind,modality,
   first_decided_at,decided_at)
SELECT DISTINCT ON (o.environment,o.source_conversation_id)
       o.environment,o.source_conversation_id,po.unit_id,'partner',
       po.fulfillment_mode,po.created_at,po.created_at
  FROM commerce.orders o
  JOIN commerce.partner_orders po
    ON po.id=o.partner_order_id AND po.environment=o.environment
 WHERE o.source_conversation_id IS NOT NULL
 ORDER BY o.environment,o.source_conversation_id,po.created_at DESC,po.id DESC
ON CONFLICT (environment,conversation_id) DO NOTHING;

-- Conversas antigas que chegaram a informar municipio, mas nao possuem pedido,
-- ficam visiveis como nao atribuidas; nunca sao inventadas para uma unidade.
INSERT INTO ops.partner_routing_decisions
  (environment,conversation_id,unit_id,decision_kind,municipio,
   first_decided_at,decided_at)
SELECT DISTINCT ON (cf.environment,cf.conversation_id)
       cf.environment,cf.conversation_id,NULL,'unresolved',
       trim(both '"' from cf.fact_value::text),
       COALESCE(cf.observed_at,cf.created_at),COALESCE(cf.observed_at,cf.created_at)
  FROM analytics.conversation_facts cf
 WHERE cf.fact_key='municipio_entrega' AND cf.superseded_by IS NULL
 ORDER BY cf.environment,cf.conversation_id,
          COALESCE(cf.observed_at,cf.created_at) DESC,cf.created_at DESC,cf.id DESC
ON CONFLICT (environment,conversation_id) DO NOTHING;

-- O papel restrito do parceiro nao recebe GRANT nesta tabela de roteamento.
