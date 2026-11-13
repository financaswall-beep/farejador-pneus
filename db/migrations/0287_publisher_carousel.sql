BEGIN;

-- A primeira mídia continua em publisher_posts.media_id, inclusive nas publicações antigas.
CREATE TABLE ops.publisher_post_photos (
  environment env_t NOT NULL,
  post_id uuid NOT NULL,
  position smallint NOT NULL CHECK (position BETWEEN 2 AND 10),
  media_id uuid NOT NULL,
  PRIMARY KEY (environment, post_id, position),
  UNIQUE (environment, post_id, media_id),
  FOREIGN KEY (environment, post_id) REFERENCES ops.publisher_posts(environment,id) ON DELETE CASCADE,
  FOREIGN KEY (environment, media_id) REFERENCES ops.publisher_media(environment,id)
);
CREATE INDEX publisher_photo_usage ON ops.publisher_post_photos(environment,media_id);
ALTER TABLE ops.publisher_post_photos ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ops.publisher_post_photos FROM PUBLIC, farejador_partner_app;
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN REVOKE ALL ON ops.publisher_post_photos FROM anon; END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN REVOKE ALL ON ops.publisher_post_photos FROM authenticated; END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname='service_role') THEN GRANT SELECT,INSERT,DELETE ON ops.publisher_post_photos TO service_role; END IF;
END $$;
CREATE TRIGGER environment_immutable BEFORE UPDATE OF environment ON ops.publisher_post_photos
  FOR EACH ROW EXECUTE FUNCTION ops.enforce_environment_immutable();
ALTER TABLE ops.publisher_destinations ADD COLUMN child_container_ids text[] NOT NULL DEFAULT '{}'
  CHECK (cardinality(child_container_ids) <= 10);
COMMIT;
