-- Matriz catalog: one final file per upload. Existing photo originals remain readable.
BEGIN;
ALTER TABLE commerce.matrix_catalog_photos ALTER COLUMN original_path DROP NOT NULL;
COMMENT ON COLUMN commerce.matrix_catalog_photos.original_path IS
 'Legacy sanitized original, when retained. New uploads keep only the branded WebP and use NULL here.';

CREATE TABLE commerce.matrix_catalog_videos (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), environment env_t NOT NULL,
 product_id uuid NOT NULL REFERENCES commerce.products(id),
 storage_path text NOT NULL, sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
 width integer NOT NULL CHECK(width>0 AND width<=1280),
 height integer NOT NULL CHECK(height>0 AND height<=1280),
 duration_seconds numeric(6,3) NOT NULL CHECK(duration_seconds>0 AND duration_seconds<=15.25),
 file_bytes integer NOT NULL CHECK(file_bytes>0 AND file_bytes<=8388608),
 source_bytes integer NOT NULL CHECK(source_bytes>0 AND source_bytes<=83886080),
 source text NOT NULL CHECK(source IN ('upload','drive')), source_key text NOT NULL,
 actor_label text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), retired_at timestamptz,
 UNIQUE(environment,product_id,source_key)
);
CREATE UNIQUE INDEX matrix_video_active_product ON commerce.matrix_catalog_videos(environment,product_id) WHERE retired_at IS NULL;
CREATE TRIGGER matrix_video_product_env BEFORE INSERT OR UPDATE ON commerce.matrix_catalog_videos
 FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('commerce','products','product_id');
CREATE TRIGGER matrix_video_env_immutable BEFORE UPDATE OF environment ON commerce.matrix_catalog_videos
 FOR EACH ROW EXECUTE FUNCTION ops.enforce_environment_immutable();
ALTER TABLE commerce.matrix_catalog_videos ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON commerce.matrix_catalog_videos FROM PUBLIC;
DO $$ DECLARE role_name text; BEGIN
 FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role','farejador_partner_app'] LOOP
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
   EXECUTE format('REVOKE ALL ON commerce.matrix_catalog_videos FROM %I',role_name);
  END IF;
 END LOOP;
END $$;
ALTER TABLE ops.outbound_messages DROP CONSTRAINT outbound_messages_kind_check;
ALTER TABLE ops.outbound_messages ADD CONSTRAINT outbound_messages_kind_check CHECK(kind IN
 ('agent_text','survey_text','photo_text','photo_attachment','video_attachment','conversation_resolution',
  'operator_text','operator_attachment','stock_text'));
COMMIT;
