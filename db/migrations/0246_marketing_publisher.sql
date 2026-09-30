-- Publicações operacionais; conteúdos de IA permanecem separados em analytics.
BEGIN;
CREATE TABLE ops.publisher_media (
  environment env_t NOT NULL,
  id uuid NOT NULL,
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 180),
  kind text NOT NULL CHECK(kind IN ('photo','video')),
  mime text NOT NULL,
  bytes bigint NOT NULL CHECK(bytes BETWEEN 1 AND 524288000),
  status text NOT NULL DEFAULT 'uploading' CHECK(status IN ('uploading','ready','deleting','deleted','failed')),
  original_path text NOT NULL,
  publish_path text,
  thumbnail_path text,
  width integer CHECK(width BETWEEN 1 AND 16384),
  height integer CHECK(height BETWEEN 1 AND 16384),
  duration numeric CHECK(duration BETWEEN 0 AND 1200),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  PRIMARY KEY(environment,id),
  UNIQUE(environment,original_path)
);
CREATE TABLE ops.publisher_posts (
  environment env_t NOT NULL,
  id uuid NOT NULL,
  media_id uuid,
  title text NOT NULL CHECK(length(title) BETWEEN 1 AND 180),
  caption text NOT NULL DEFAULT '' CHECK(length(caption)<=2200),
  destinations jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(destinations)='array'),
  status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','scheduled','publishing','published','partial','failed','cancelled')),
  scheduled_at timestamptz,
  delete_after_publish boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(environment,id),
  FOREIGN KEY(environment,media_id) REFERENCES ops.publisher_media(environment,id)
);
CREATE TABLE ops.publisher_destinations (
  environment env_t NOT NULL,
  post_id uuid NOT NULL,
  platform text NOT NULL CHECK(platform IN ('facebook','instagram')),
  account_id text NOT NULL,
  format text NOT NULL CHECK(format IN ('feed','reel','story')),
  caption text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK(status IN
    ('queued','preparing','processing','publishing','verifying','published','failed','uncertain','cancelled')),
  container_id text,
  provider_id text,
  post_url text,
  error_code text,
  lease_id uuid,
  lease_until timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(environment,post_id,platform),
  FOREIGN KEY(environment,post_id) REFERENCES ops.publisher_posts(environment,id)
);
CREATE INDEX publisher_queue ON ops.publisher_destinations(environment,next_attempt_at)
  WHERE status IN ('queued','preparing','processing','publishing','verifying');
CREATE INDEX publisher_posts_recent ON ops.publisher_posts(environment,updated_at DESC);
CREATE TABLE ops.publisher_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment env_t NOT NULL,
  post_id uuid,
  event text NOT NULL,
  actor text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(environment,post_id) REFERENCES ops.publisher_posts(environment,id)
);
CREATE TABLE analytics.publisher_captions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment env_t NOT NULL,
  brief text NOT NULL,
  caption text NOT NULL,
  source text NOT NULL DEFAULT 'llm',
  extractor_version text NOT NULL,
  confidence_level text NOT NULL CHECK(confidence_level IN ('low','medium','high')),
  truth_type text NOT NULL DEFAULT 'suggested',
  model text NOT NULL,
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  superseded_by uuid REFERENCES analytics.publisher_captions(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION analytics.guard_publisher_caption() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR (to_jsonb(NEW)-'superseded_by') IS DISTINCT FROM (to_jsonb(OLD)-'superseded_by') THEN
    RAISE EXCEPTION 'publisher_caption_immutable';
  END IF;
  IF NEW.superseded_by IS NOT NULL AND NOT EXISTS(SELECT 1 FROM analytics.publisher_captions
    WHERE id=NEW.superseded_by AND environment=NEW.environment) THEN RAISE EXCEPTION 'publisher_caption_environment'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER publisher_caption_immutable BEFORE UPDATE OR DELETE ON analytics.publisher_captions
  FOR EACH ROW EXECUTE FUNCTION analytics.guard_publisher_caption();
DO $$ DECLARE relation text; role_name text; BEGIN
  FOREACH relation IN ARRAY ARRAY['ops.publisher_media','ops.publisher_posts','ops.publisher_destinations',
    'ops.publisher_events','analytics.publisher_captions'] LOOP
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
