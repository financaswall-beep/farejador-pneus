-- 0106: FOTO SOB DEMANDA — até 3 fotos por card (1:1 → 1:N)
-- Motivo (decisão Wallace 2026-06-14): pneu usado precisa de vários ângulos
-- (banda / lateral-DOT / geral). Hoje o card aceita 1 foto; passa a aceitar até 3.
-- BACKWARD-COMPATIBLE: o fluxo de 1 foto continua idêntico; o teto de 3 é garantido
-- na função attach_partner_photo. O envio pro cliente segue foto-a-foto (lado bot).

-- ── 1) photo_request_blobs: 1:1 (PK = photo_request_id) → 1:N (PK = id surrogate) ──
-- A FK photo_request_id→photo_requests(id) ON DELETE CASCADE e as CHECK de mime/size
-- continuam. RLS (isolation por unit_id) e os grants POR COLUNA ficam intactos: o
-- parceiro NÃO insere nem lê a coluna `id` (a função insere colunas explícitas; a
-- leitura é por ordinal/created_at) → não concedo SELECT(id) (superfície mínima).
ALTER TABLE commerce.photo_request_blobs DROP CONSTRAINT photo_request_blobs_pkey;
ALTER TABLE commerce.photo_request_blobs ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE commerce.photo_request_blobs ADD CONSTRAINT photo_request_blobs_pkey PRIMARY KEY (id);
CREATE INDEX IF NOT EXISTS photo_request_blobs_request_idx
  ON commerce.photo_request_blobs (photo_request_id);

-- ── 2) attach_partner_photo: aceita ATÉ 3 fotos por card (era 1) ──
-- Mantém: trava FOR UPDATE (anti duplo-clique/2 aparelhos da MESMA foto fica a cargo
-- do front photoSending), validação de mime/size, caminho de 'expired' (was_late) e
-- RLS (linha de outra unidade = invisível → NOT FOUND, não vaza existência).
-- Muda: em vez de "já tem foto → no-op", agora "tem < 3 → anexa". Status NÃO regride
-- ('answered'/'sent' permanecem); pending/expired → answered no 1º anexo.
CREATE OR REPLACE FUNCTION commerce.attach_partner_photo(
  p_photo_request_id uuid, p_photo_bytes bytea, p_photo_mime text, p_photo_size_bytes integer)
 RETURNS TABLE(out_status text, out_was_late boolean, out_attached boolean)
 LANGUAGE plpgsql
 SET search_path TO 'commerce', 'network', 'pg_temp'
AS $function$
DECLARE
  v_environment public.env_t;
  v_unit_id     UUID;
  v_status      TEXT;
  v_count       INT;
  v_was_late    BOOLEAN;
BEGIN
  SELECT pr.environment, pr.unit_id, pr.status,
         (SELECT count(*) FROM commerce.photo_request_blobs b WHERE b.photo_request_id = pr.id)
    INTO v_environment, v_unit_id, v_status, v_count
  FROM commerce.photo_requests pr
  WHERE pr.id = p_photo_request_id
  FOR UPDATE;

  IF v_environment IS NULL THEN
    RAISE EXCEPTION 'Pedido de foto nao encontrado (ou de outra unidade): %', p_photo_request_id
      USING ERRCODE = '42501';
  END IF;

  IF p_photo_bytes IS NULL OR length(p_photo_bytes) = 0 THEN
    RAISE EXCEPTION 'Foto vazia para o pedido %', p_photo_request_id USING ERRCODE = '23514';
  END IF;
  IF p_photo_mime NOT IN ('image/jpeg', 'image/png', 'image/webp') THEN
    RAISE EXCEPTION 'MIME nao permitido (%) para o pedido %', p_photo_mime, p_photo_request_id
      USING ERRCODE = '23514';
  END IF;

  -- Card cancelado (o pedido fechou) → não aceita mais foto.
  IF v_status = 'cancelled' THEN
    RETURN QUERY SELECT v_status, false, false;
    RETURN;
  END IF;

  -- Teto de 3 fotos por card → no-op (o front já esconde o botão; isto é a trava física).
  IF v_count >= 3 THEN
    RETURN QUERY SELECT v_status, false, false;
    RETURN;
  END IF;

  v_was_late := v_status IN ('expired', 'expired_after_answer');

  INSERT INTO commerce.photo_request_blobs (
    photo_request_id, environment, unit_id, photo_bytes, photo_mime, photo_size_bytes
  ) VALUES (
    p_photo_request_id, v_environment, v_unit_id, p_photo_bytes, p_photo_mime, p_photo_size_bytes
  );

  UPDATE commerce.photo_requests
     SET status      = CASE WHEN status IN ('pending', 'expired', 'expired_after_answer')
                            THEN 'answered' ELSE status END,
         was_late    = (was_late OR v_was_late),
         answered_at = COALESCE(answered_at, now())
   WHERE id = p_photo_request_id;

  RETURN QUERY SELECT 'answered'::TEXT, v_was_late, true;
END;
$function$;

-- ── 3) view da fila: adiciona photo_count (PRESERVA security_invoker — senão a RLS
-- de baixo não vale e vaza foto entre parceiros). Grant da coluna nova pro role do
-- parceiro (os grants são POR COLUNA). has_photo continua (compat).
CREATE OR REPLACE VIEW commerce.partner_photo_queue
  WITH (security_invoker = true) AS
  SELECT pr.id, pr.unit_id, pr.tire_size, pr.brand, pr.note, pr.status, pr.was_late,
         pr.expires_at, pr.answered_at, pr.created_at,
         (EXISTS (SELECT 1 FROM commerce.photo_request_blobs b WHERE b.photo_request_id = pr.id)) AS has_photo,
         (SELECT count(*) FROM commerce.photo_request_blobs b WHERE b.photo_request_id = pr.id)::int AS photo_count
  FROM commerce.photo_requests pr;

GRANT SELECT (photo_count) ON commerce.partner_photo_queue TO farejador_partner_app;
