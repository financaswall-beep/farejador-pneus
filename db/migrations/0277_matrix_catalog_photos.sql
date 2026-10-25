-- Permanent catalog media for the Matriz. Operational partner photos stay separate.
BEGIN;
CREATE TABLE commerce.matrix_photo_settings (
 environment env_t NOT NULL, product_id uuid NOT NULL REFERENCES commerce.products(id),
 enabled boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 1 CHECK(version>0),
 drive_folder_id text CHECK(drive_folder_id ~ '^[A-Za-z0-9_-]{10,200}$'),
 drive_enabled boolean NOT NULL DEFAULT false, drive_checked_at timestamptz,
 drive_error text, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(environment,product_id)
);
CREATE TABLE commerce.matrix_catalog_photos (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), environment env_t NOT NULL,
 product_id uuid NOT NULL REFERENCES commerce.products(id),
 angle text NOT NULL CHECK(angle IN ('front','side','detail')),
 is_primary boolean NOT NULL DEFAULT false,
 storage_path text NOT NULL, original_path text NOT NULL,
 sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
 width integer NOT NULL CHECK(width>0), height integer NOT NULL CHECK(height>0),
 source text NOT NULL CHECK(source IN ('upload','drive')),
 source_key text NOT NULL, actor_label text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), retired_at timestamptz,
 UNIQUE(environment,product_id,source_key)
);
CREATE UNIQUE INDEX matrix_photo_active_angle ON commerce.matrix_catalog_photos(environment,product_id,angle) WHERE retired_at IS NULL;
CREATE UNIQUE INDEX matrix_photo_primary ON commerce.matrix_catalog_photos(environment,product_id) WHERE retired_at IS NULL AND is_primary;
CREATE INDEX matrix_photo_drive_due ON commerce.matrix_photo_settings(environment,drive_checked_at) WHERE drive_enabled;
CREATE TRIGGER matrix_photo_settings_product_env BEFORE INSERT OR UPDATE ON commerce.matrix_photo_settings
 FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('commerce','products','product_id');
CREATE TRIGGER matrix_photo_product_env BEFORE INSERT OR UPDATE ON commerce.matrix_catalog_photos
 FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('commerce','products','product_id');
CREATE TRIGGER matrix_photo_settings_env_immutable BEFORE UPDATE OF environment ON commerce.matrix_photo_settings
 FOR EACH ROW EXECUTE FUNCTION ops.enforce_environment_immutable();
CREATE TRIGGER matrix_photo_env_immutable BEFORE UPDATE OF environment ON commerce.matrix_catalog_photos
 FOR EACH ROW EXECUTE FUNCTION ops.enforce_environment_immutable();
DO $$ DECLARE item text; role_name text; BEGIN
 FOREACH item IN ARRAY ARRAY['commerce.matrix_photo_settings','commerce.matrix_catalog_photos'] LOOP
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY',item);
  EXECUTE format('REVOKE ALL ON %s FROM PUBLIC',item);
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role','farejador_partner_app'] LOOP
   IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
    EXECUTE format('REVOKE ALL ON %s FROM %I',item,role_name);
   END IF;
  END LOOP;
 END LOOP;
END $$;
COMMIT;
