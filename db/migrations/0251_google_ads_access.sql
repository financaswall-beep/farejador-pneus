-- Tabelas Google sao operacionais internas; acesso somente pelo servidor.
BEGIN;
DO $$ DECLARE relation text; role_name text; BEGIN
  FOREACH relation IN ARRAY ARRAY['google_accounts','google_campaigns','google_ads',
    'google_insights_daily','google_clicks','google_click_conversations',
    'google_order_attributions','google_conversion_outbox'] LOOP
    EXECUTE format('ALTER TABLE marketing.%I ENABLE ROW LEVEL SECURITY',relation);
    EXECUTE format('REVOKE ALL ON marketing.%I FROM PUBLIC',relation);
    FOREACH role_name IN ARRAY ARRAY['anon','authenticated','farejador_partner_app','partner_app'] LOOP
      IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
        EXECUTE format('REVOKE ALL ON marketing.%I FROM %I',relation,role_name);
      END IF;
    END LOOP;
  END LOOP;
END $$;
COMMIT;
