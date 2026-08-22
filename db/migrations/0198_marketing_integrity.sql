-- ============================================================
-- 0198_marketing_integrity.sql
-- Marketing: ciclo de sincronizacao, filas e causalidade ponta a ponta.
-- ============================================================

BEGIN;

-- Uma queda do processo nao pode deixar a integracao eternamente "rodando".
WITH ranked AS (
  SELECT id,environment,
         row_number() OVER (
           PARTITION BY environment,source ORDER BY started_at DESC,id DESC
         ) AS position
    FROM marketing.meta_sync_runs
   WHERE status='running'
)
UPDATE marketing.meta_sync_runs r
   SET status='failed',error_code=COALESCE(r.error_code,'meta_sync_superseded'),
       error_summary=COALESCE(r.error_summary,'Sincronizacao concorrente substituida'),
       finished_at=now()
  FROM ranked x
 WHERE r.environment=x.environment AND r.id=x.id AND x.position>1;

UPDATE marketing.meta_sync_runs
   SET status='failed',error_code=COALESCE(error_code,'meta_sync_stale'),
       error_summary=COALESCE(error_summary,'Sincronizacao interrompida sem finalizacao'),
       finished_at=now()
 WHERE status='running' AND started_at<now()-interval '1 hour';

UPDATE marketing.meta_sync_runs
   SET finished_at=COALESCE(finished_at,started_at)
 WHERE status IN ('succeeded','failed') AND finished_at IS NULL;

UPDATE marketing.meta_sync_runs
   SET finished_at=NULL
 WHERE status='running' AND finished_at IS NOT NULL;

ALTER TABLE marketing.meta_sync_runs
  DROP CONSTRAINT IF EXISTS meta_sync_runs_lifecycle_check;
ALTER TABLE marketing.meta_sync_runs
  ADD CONSTRAINT meta_sync_runs_lifecycle_check CHECK (
    (status='running' AND finished_at IS NULL)
    OR (status IN ('succeeded','failed') AND finished_at IS NOT NULL)
  );

CREATE UNIQUE INDEX IF NOT EXISTS meta_sync_runs_one_running_uniq
  ON marketing.meta_sync_runs(environment,source)
  WHERE status='running';

-- Referral direto sem mensagem correspondente expira para nao bloquear a fila.
 UPDATE marketing.meta_messaging_referrals
   SET status='unmatched',updated_at=now()
 WHERE status='pending' AND created_at<now()-interval '7 days';

ALTER TABLE marketing.meta_messaging_referrals
  DROP CONSTRAINT IF EXISTS meta_messaging_provider_key_shape_check;
ALTER TABLE marketing.meta_messaging_referrals
  ADD CONSTRAINT meta_messaging_provider_key_shape_check
  CHECK (provider_event_key ~ '^[a-f0-9]{64}$');

-- A mensagem de origem e a conversa do referral precisam ser a mesma cadeia.
CREATE OR REPLACE FUNCTION marketing.validate_ad_referral_causality()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  message_conversation UUID;
BEGIN
  SELECT m.conversation_id
    INTO message_conversation
    FROM core.messages m
   WHERE m.environment=NEW.environment AND m.id=NEW.source_message_id
   ORDER BY m.sent_at
   LIMIT 1;
  IF message_conversation IS NULL THEN
    RAISE EXCEPTION 'marketing referral: mensagem de origem ausente no ambiente';
  END IF;
  IF message_conversation<>NEW.conversation_id THEN
    RAISE EXCEPTION 'marketing referral: mensagem nao pertence a conversa informada';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ad_referral_causality_guard ON marketing.ad_referrals;
CREATE TRIGGER ad_referral_causality_guard
  BEFORE INSERT OR UPDATE OF conversation_id,source_message_id
  ON marketing.ad_referrals
  FOR EACH ROW EXECUTE FUNCTION marketing.validate_ad_referral_causality();

CREATE OR REPLACE FUNCTION marketing.enforce_ad_referral_identity_immutable()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.conversation_id IS DISTINCT FROM NEW.conversation_id
     OR OLD.source_message_id IS DISTINCT FROM NEW.source_message_id
     OR OLD.captured_at IS DISTINCT FROM NEW.captured_at
     OR OLD.channel IS DISTINCT FROM NEW.channel
     OR OLD.referral_key IS DISTINCT FROM NEW.referral_key THEN
    RAISE EXCEPTION 'marketing referral: identidade observada e imutavel'
      USING ERRCODE='restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ad_referral_identity_immutability_guard
  ON marketing.ad_referrals;
CREATE TRIGGER ad_referral_identity_immutability_guard
  BEFORE UPDATE ON marketing.ad_referrals
  FOR EACH ROW EXECUTE FUNCTION marketing.enforce_ad_referral_identity_immutable();

-- Uma atribuicao so e valida para a mesma conversa e ate 7 dias do referral.
CREATE OR REPLACE FUNCTION marketing.validate_order_attribution_causality()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  referral_conversation UUID;
  referral_captured_at TIMESTAMPTZ;
BEGIN
  SELECT r.conversation_id,r.captured_at
    INTO referral_conversation,referral_captured_at
    FROM marketing.ad_referrals r
   WHERE r.environment=NEW.environment AND r.id=NEW.referral_id;
  IF referral_conversation IS NULL THEN
    RAISE EXCEPTION 'marketing attribution: referral ausente no ambiente';
  END IF;
  IF referral_conversation<>NEW.conversation_id THEN
    RAISE EXCEPTION 'marketing attribution: conversa diverge do referral';
  END IF;
  IF NEW.realized_at<referral_captured_at
     OR NEW.realized_at>=referral_captured_at+interval '7 days' THEN
    RAISE EXCEPTION 'marketing attribution: venda fora da janela causal de 7 dias';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS order_attribution_causality_guard
  ON marketing.order_attributions;
CREATE TRIGGER order_attribution_causality_guard
  BEFORE INSERT OR UPDATE OF referral_id,conversation_id,realized_at
  ON marketing.order_attributions
  FOR EACH ROW EXECUTE FUNCTION marketing.validate_order_attribution_causality();

-- O casamento Messenger/Instagram tambem precisa apontar para a mesma conversa.
CREATE OR REPLACE FUNCTION marketing.validate_meta_messaging_match()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  message_conversation UUID;
BEGIN
  IF NEW.status<>'matched' THEN RETURN NEW; END IF;
  SELECT m.conversation_id
    INTO message_conversation
    FROM core.messages m
   WHERE m.environment=NEW.environment AND m.id=NEW.matched_message_id
   ORDER BY m.sent_at
   LIMIT 1;
  IF message_conversation IS NULL OR message_conversation<>NEW.matched_conversation_id THEN
    RAISE EXCEPTION 'marketing Meta referral: mensagem e conversa nao correspondem';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS meta_messaging_match_causality_guard
  ON marketing.meta_messaging_referrals;
CREATE TRIGGER meta_messaging_match_causality_guard
  BEFORE INSERT OR UPDATE OF status,matched_message_id,matched_conversation_id
  ON marketing.meta_messaging_referrals
  FOR EACH ROW EXECUTE FUNCTION marketing.validate_meta_messaging_match();

ALTER TABLE marketing.campaign_scopes
  DROP CONSTRAINT IF EXISTS campaign_scopes_classification_text_check;
ALTER TABLE marketing.campaign_scopes
  ADD CONSTRAINT campaign_scopes_classification_text_check CHECK (
    scope='pending'
    OR (length(btrim(classified_by))>0 AND length(btrim(classification_reason))>0)
  );

REVOKE ALL ON FUNCTION marketing.validate_ad_referral_causality() FROM PUBLIC;
REVOKE ALL ON FUNCTION marketing.enforce_ad_referral_identity_immutable() FROM PUBLIC;
REVOKE ALL ON FUNCTION marketing.validate_order_attribution_causality() FROM PUBLIC;
REVOKE ALL ON FUNCTION marketing.validate_meta_messaging_match() FROM PUBLIC;

DO $security$
DECLARE restricted_role TEXT;
BEGIN
  FOREACH restricted_role IN ARRAY ARRAY['partner_app','farejador_partner_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=restricted_role) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION marketing.validate_ad_referral_causality() FROM %I',restricted_role);
      EXECUTE format('REVOKE ALL ON FUNCTION marketing.enforce_ad_referral_identity_immutable() FROM %I',restricted_role);
      EXECUTE format('REVOKE ALL ON FUNCTION marketing.validate_order_attribution_causality() FROM %I',restricted_role);
      EXECUTE format('REVOKE ALL ON FUNCTION marketing.validate_meta_messaging_match() FROM %I',restricted_role);
    END IF;
  END LOOP;
END
$security$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM marketing.ad_referrals r
    LEFT JOIN core.messages m
      ON m.environment=r.environment AND m.id=r.source_message_id
    WHERE m.id IS NULL OR m.conversation_id<>r.conversation_id
  ) THEN
    RAISE EXCEPTION '0198: referral ligado a mensagem/conversa divergente';
  END IF;
  IF EXISTS (
    SELECT 1 FROM marketing.order_attributions a
    JOIN marketing.ad_referrals r
      ON r.environment=a.environment AND r.id=a.referral_id
    WHERE a.conversation_id<>r.conversation_id
       OR a.realized_at<r.captured_at
       OR a.realized_at>=r.captured_at+interval '7 days'
  ) THEN
    RAISE EXCEPTION '0198: atribuicao fora da cadeia causal';
  END IF;
END $$;

COMMIT;
