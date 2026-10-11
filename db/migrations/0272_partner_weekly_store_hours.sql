BEGIN;

-- NULL = ainda usa o texto antigo; [] = explicitamente fechada todos os dias.
ALTER TABLE network.partner_units ADD COLUMN IF NOT EXISTS opening_hours_weekly JSONB;
COMMENT ON COLUMN network.partner_units.opening_hours_weekly IS
  'Funcionamento semanal presencial/retirada, em America/Sao_Paulo. Array de {day,opens_at,closes_at}; domingo=0. Ausência do dia significa fechado. NULL não cadastrado. Não contém intervalos nem feriados.';

CREATE OR REPLACE FUNCTION network.valid_weekly_store_hours(value JSONB)
RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE item JSONB; seen INTEGER[]='{}'; weekday INTEGER;
BEGIN
  IF value IS NULL THEN RETURN TRUE; END IF;
  IF jsonb_typeof(value)<>'array' THEN RETURN FALSE; END IF;
  IF jsonb_array_length(value)>7 THEN RETURN FALSE; END IF;
  FOR item IN SELECT * FROM jsonb_array_elements(value) LOOP
    IF jsonb_typeof(item)<>'object' THEN RETURN FALSE; END IF;
    IF jsonb_typeof(item->'day') IS DISTINCT FROM 'number'
       OR COALESCE(item->>'day','') !~ '^[0-6]$'
       OR jsonb_typeof(item->'opens_at') IS DISTINCT FROM 'string'
       OR jsonb_typeof(item->'closes_at') IS DISTINCT FROM 'string'
       OR COALESCE(item->>'opens_at','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
       OR COALESCE(item->>'closes_at','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
       OR (item->>'closes_at')<=(item->>'opens_at')
       OR (item-'day'-'opens_at'-'closes_at')<>'{}'::jsonb THEN RETURN FALSE; END IF;
    weekday=(item->>'day')::INTEGER;
    IF weekday=ANY(seen) THEN RETURN FALSE; END IF;
    seen=array_append(seen,weekday);
  END LOOP;
  RETURN TRUE;
END $$;

ALTER TABLE network.partner_units ADD CONSTRAINT partner_units_weekly_store_hours_valid
  CHECK(network.valid_weekly_store_hours(opening_hours_weekly));

-- Uma edição pelo painel antigo não pode deixar o bot lendo horários anteriores.
CREATE OR REPLACE FUNCTION network.invalidate_weekly_hours_on_text_change()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.opening_hours_text IS DISTINCT FROM OLD.opening_hours_text
     AND NEW.opening_hours_weekly IS NOT DISTINCT FROM OLD.opening_hours_weekly THEN
    NEW.opening_hours_weekly=NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invalidate_weekly_hours_on_text_change
  BEFORE UPDATE OF opening_hours_text ON network.partner_units
  FOR EACH ROW EXECUTE FUNCTION network.invalidate_weekly_hours_on_text_change();

-- Reusa o isolamento RLS existente de partner_units. Não concede UPDATE de
-- endereço, modo, cobertura nem outros dados da loja; a API continua só-dono.
GRANT UPDATE(opening_hours_weekly,opening_hours_text) ON network.partner_units TO farejador_partner_app;

COMMIT;
