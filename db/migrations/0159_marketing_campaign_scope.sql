-- ============================================================
-- 0159_marketing_campaign_scope.sql
-- Escopo manual de campanhas Meta, leitura financeira central e defesa CAPI.
--
-- Regras:
-- - campanha nova nasce pending e nunca e classificada por heuristica;
-- - insights brutos continuam imutaveis/visiveis;
-- - financial_spend so considera campanhas da matriz;
-- - CAPI preserva outbox e pode suprimir evento antes do envio;
-- - nenhuma permissao e concedida ao portal parceiro.
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS marketing.campaign_scopes (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment           env_t NOT NULL,
  ad_account_id         TEXT NOT NULL,
  campaign_id           TEXT NOT NULL,
  campaign_name         TEXT,
  scope                 TEXT NOT NULL DEFAULT 'pending'
                        CHECK (scope IN ('pending','matrix','external')),
  classification_reason TEXT,
  classified_by         TEXT,
  classified_at         TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (environment, ad_account_id, campaign_id),
  UNIQUE (environment, id),
  CHECK (
    (scope = 'pending' AND classified_at IS NULL)
    OR
    (scope <> 'pending' AND classified_at IS NOT NULL
      AND classified_by IS NOT NULL AND classification_reason IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS campaign_scopes_status_idx
  ON marketing.campaign_scopes(environment, scope, updated_at DESC);

DROP TRIGGER IF EXISTS env_immutable_campaign_scopes ON marketing.campaign_scopes;
CREATE TRIGGER env_immutable_campaign_scopes
  BEFORE UPDATE OF environment ON marketing.campaign_scopes
  FOR EACH ROW EXECUTE FUNCTION ops.enforce_environment_immutable();

CREATE OR REPLACE FUNCTION marketing.ensure_campaign_scope_from_insight()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO marketing.campaign_scopes (
    environment,ad_account_id,campaign_id,campaign_name
  ) VALUES (
    NEW.environment,NEW.ad_account_id,NEW.campaign_id,NEW.campaign_name
  )
  ON CONFLICT (environment,ad_account_id,campaign_id) DO UPDATE
    SET campaign_name=COALESCE(EXCLUDED.campaign_name,
        marketing.campaign_scopes.campaign_name),
        updated_at=CASE
          WHEN EXCLUDED.campaign_name IS DISTINCT FROM
               marketing.campaign_scopes.campaign_name
          THEN now() ELSE marketing.campaign_scopes.updated_at END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ensure_campaign_scope_from_insight
  ON marketing.meta_insights_daily;
CREATE TRIGGER ensure_campaign_scope_from_insight
  AFTER INSERT OR UPDATE OF ad_account_id,campaign_id,campaign_name
  ON marketing.meta_insights_daily
  FOR EACH ROW EXECUTE FUNCTION marketing.ensure_campaign_scope_from_insight();

-- Todo historico conhecido entra explicitamente como pendente. A decisao e humana.
INSERT INTO marketing.campaign_scopes (
  environment, ad_account_id, campaign_id, campaign_name
)
SELECT i.environment,i.ad_account_id,i.campaign_id,
       max(i.campaign_name) FILTER (WHERE i.campaign_name IS NOT NULL)
  FROM marketing.meta_insights_daily i
 GROUP BY i.environment,i.ad_account_id,i.campaign_id
ON CONFLICT (environment,ad_account_id,campaign_id) DO UPDATE
  SET campaign_name=COALESCE(EXCLUDED.campaign_name,
      marketing.campaign_scopes.campaign_name),
      updated_at=now();

-- Fonte unica: mantem o insight bruto e calcula separadamente o valor financeiro.
CREATE OR REPLACE VIEW marketing.meta_insights_daily_scoped AS
SELECT i.*,
       s.id AS campaign_scope_id,
       COALESCE(s.scope,'pending') AS campaign_scope,
       CASE WHEN s.scope='matrix' THEN i.spend ELSE 0::numeric END
         AS financial_spend,
       s.classified_at AS scope_classified_at
  FROM marketing.meta_insights_daily i
  LEFT JOIN marketing.campaign_scopes s
    ON s.environment=i.environment
   AND s.ad_account_id=i.ad_account_id
   AND s.campaign_id=i.campaign_id;

COMMENT ON TABLE marketing.campaign_scopes IS
  'Decisao manual e auditavel sobre quais campanhas pertencem a matriz.';
COMMENT ON VIEW marketing.meta_insights_daily_scoped IS
  'Insights Meta brutos com escopo manual e gasto financeiro desejado.';

-- Eventos podem ser impedidos na ultima milha se a campanha sair do escopo.
ALTER TABLE marketing.capi_outbox
  ADD COLUMN IF NOT EXISTS campaign_scope_id UUID,
  ADD COLUMN IF NOT EXISTS suppressed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS suppression_reason TEXT;

ALTER TABLE marketing.capi_outbox
  DROP CONSTRAINT IF EXISTS capi_outbox_status_check;
ALTER TABLE marketing.capi_outbox
  ADD CONSTRAINT capi_outbox_status_check
  CHECK (status IN (
    'pending','processing','sent','failed','dead_letter','suppressed'
  ));

DO $$ BEGIN
  ALTER TABLE marketing.capi_outbox
    ADD CONSTRAINT capi_outbox_campaign_scope_fk
    FOREIGN KEY (campaign_scope_id)
    REFERENCES marketing.campaign_scopes(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS capi_outbox_scope_idx
  ON marketing.capi_outbox(environment,campaign_scope_id,status)
  WHERE campaign_scope_id IS NOT NULL;

DROP TRIGGER IF EXISTS env_match_capi_campaign_scope ON marketing.capi_outbox;
CREATE TRIGGER env_match_capi_campaign_scope
  BEFORE INSERT OR UPDATE OF campaign_scope_id ON marketing.capi_outbox
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match(
    'marketing','campaign_scopes','campaign_scope_id'
  );

REVOKE ALL ON marketing.campaign_scopes FROM PUBLIC;
REVOKE ALL ON marketing.meta_insights_daily_scoped FROM PUBLIC;
REVOKE ALL ON FUNCTION marketing.ensure_campaign_scope_from_insight() FROM PUBLIC;

DO $security$
DECLARE
  restricted_role TEXT;
BEGIN
  FOREACH restricted_role IN ARRAY ARRAY['partner_app', 'farejador_partner_app']
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = restricted_role) THEN
      EXECUTE format('REVOKE ALL ON marketing.campaign_scopes FROM %I', restricted_role);
      EXECUTE format('REVOKE ALL ON marketing.meta_insights_daily_scoped FROM %I', restricted_role);
      EXECUTE format(
        'REVOKE ALL ON FUNCTION marketing.ensure_campaign_scope_from_insight() FROM %I',
        restricted_role
      );
    END IF;
  END LOOP;
END
$security$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM marketing.campaign_scopes
     GROUP BY environment,ad_account_id,campaign_id HAVING count(*)>1
  ) THEN
    RAISE EXCEPTION '0159: campaign_scope duplicado';
  END IF;
  IF EXISTS (
    SELECT 1 FROM marketing.meta_insights_daily_scoped
     WHERE campaign_scope NOT IN ('pending','matrix','external')
  ) THEN
    RAISE EXCEPTION '0159: campaign_scope invalido na view';
  END IF;
END $$;

COMMIT;
