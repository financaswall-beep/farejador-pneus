-- Comentários públicos: captura determinística, decisões de IA e execução separadas.
BEGIN;
CREATE TABLE ops.meta_comment_events (
  environment env_t NOT NULL,
  raw_event_id bigint NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','failed')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(environment,raw_event_id),
  FOREIGN KEY(environment,raw_event_id) REFERENCES raw.meta_messaging_events(environment,id)
);
CREATE TABLE core.meta_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment env_t NOT NULL,
  platform text NOT NULL CHECK (platform IN ('facebook','instagram')),
  account_id text NOT NULL,
  comment_id text NOT NULL,
  post_id text NOT NULL,
  parent_id text,
  author_id text,
  author_label text NOT NULL DEFAULT 'Visitante',
  body text NOT NULL,
  revision text NOT NULL,
  removed boolean NOT NULL DEFAULT false,
  occurred_at timestamptz NOT NULL,
  last_event_at timestamptz NOT NULL,
  raw_event_id bigint NOT NULL,
  UNIQUE(environment,id),
  UNIQUE(environment,platform,account_id,comment_id),
  FOREIGN KEY(environment,raw_event_id) REFERENCES raw.meta_messaging_events(environment,id)
);
CREATE TABLE analytics.meta_comment_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment env_t NOT NULL,
  comment_id uuid NOT NULL,
  revision text NOT NULL,
  action text NOT NULL CHECK (action IN ('reply','delete','ignore')),
  comment_snapshot text NOT NULL,
  sentiment text NOT NULL CHECK (sentiment IN ('positive','neutral','negative')),
  reply_text text NOT NULL,
  reason text NOT NULL,
  source text NOT NULL DEFAULT 'llm',
  extractor_version text NOT NULL,
  confidence_level text NOT NULL CHECK (confidence_level IN ('low','medium','high')),
  truth_type text NOT NULL DEFAULT 'inferred',
  source_reference text NOT NULL,
  model text NOT NULL,
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  superseded_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(environment,id),
  UNIQUE(environment,comment_id,id),
  FOREIGN KEY(environment,comment_id) REFERENCES core.meta_comments(environment,id),
  FOREIGN KEY(environment,comment_id,superseded_by) REFERENCES analytics.meta_comment_decisions(environment,comment_id,id),
  CHECK ((action='delete' AND sentiment='negative' AND reply_text='')
    OR (action='reply' AND sentiment<>'negative' AND length(reply_text) BETWEEN 1 AND 1000)
    OR (action='ignore' AND reply_text=''))
);
CREATE TABLE ops.meta_comment_actions (
  environment env_t NOT NULL,
  comment_id uuid NOT NULL,
  decision_id uuid,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN
    ('pending','generating','queued','sending','replied','deleted','ignored','failed','uncertain')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  provider_reply_id text,
  completion_source text CHECK (completion_source IN ('automation','page')),
  lease_id uuid,
  post_url text,
  error_code text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(environment,comment_id),
  FOREIGN KEY(environment,comment_id) REFERENCES core.meta_comments(environment,id),
  FOREIGN KEY(environment,comment_id,decision_id) REFERENCES analytics.meta_comment_decisions(environment,comment_id,id)
);
CREATE INDEX meta_comment_actions_pending ON ops.meta_comment_actions(environment,next_attempt_at)
  WHERE status IN ('pending','queued');
CREATE INDEX meta_comments_recent ON core.meta_comments(environment,occurred_at DESC,id);
CREATE TABLE ops.meta_comment_controls (
  environment env_t PRIMARY KEY,
  paused boolean NOT NULL DEFAULT false,
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Decisões não são reescritas; somente o encadeamento de supersessão pode mudar.
CREATE FUNCTION analytics.guard_meta_comment_decision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR (to_jsonb(NEW)-'superseded_by') IS DISTINCT FROM (to_jsonb(OLD)-'superseded_by')
    OR OLD.superseded_by IS NOT NULL THEN
    RAISE EXCEPTION 'Decisao de comentario imutavel';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER meta_comment_decision_immutable BEFORE UPDATE OR DELETE ON analytics.meta_comment_decisions
  FOR EACH ROW EXECUTE FUNCTION analytics.guard_meta_comment_decision();
DO $$ DECLARE relation text; role_name text; BEGIN
  FOREACH relation IN ARRAY ARRAY['ops.meta_comment_events','core.meta_comments',
    'analytics.meta_comment_decisions','ops.meta_comment_actions','ops.meta_comment_controls'] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY',relation);
    EXECUTE format('REVOKE ALL ON %s FROM PUBLIC,farejador_partner_app',relation);
    FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
      IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
        EXECUTE format('REVOKE ALL ON %s FROM %I',relation,role_name);
      END IF;
    END LOOP;
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
      EXECUTE format('GRANT SELECT,INSERT,UPDATE ON %s TO service_role',relation);
    END IF;
    EXECUTE format('CREATE TRIGGER environment_immutable BEFORE UPDATE OF environment ON %s
      FOR EACH ROW EXECUTE FUNCTION ops.enforce_environment_immutable()',relation);
  END LOOP;
END $$;
COMMIT;
