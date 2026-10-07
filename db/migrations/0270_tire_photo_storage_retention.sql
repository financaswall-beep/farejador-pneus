-- Fotos operacionais compactas no Storage privado; metadados sobrevivem à limpeza.
ALTER TABLE commerce.photo_request_blobs
  ALTER COLUMN photo_bytes DROP NOT NULL,
  ADD COLUMN storage_path text,
  ADD COLUMN deleted_at timestamptz,
  ADD COLUMN sha256 text CHECK (sha256 IS NULL OR sha256 ~ '^[a-f0-9]{64}$'),
  ADD COLUMN width integer CHECK (width > 0),
  ADD COLUMN height integer CHECK (height > 0),
  ADD CONSTRAINT tire_photo_payload_check CHECK (
    (deleted_at IS NOT NULL AND photo_bytes IS NULL AND storage_path IS NULL)
    OR (deleted_at IS NULL AND ((photo_bytes IS NOT NULL)::int + (storage_path IS NOT NULL)::int) = 1)),
  ADD CONSTRAINT tire_photo_path_check CHECK (storage_path IS NULL OR storage_path =
    environment::text || '/' || unit_id::text || '/' || photo_request_id::text || '/' || id::text || '/photo.webp');

GRANT SELECT (storage_path, deleted_at) ON commerce.photo_request_blobs TO farejador_partner_app;
REVOKE INSERT ON commerce.photo_request_blobs FROM farejador_partner_app;
GRANT INSERT (photo_request_id,environment,unit_id,photo_bytes,photo_mime,photo_size_bytes)
  ON commerce.photo_request_blobs TO farejador_partner_app;
CREATE INDEX tire_photo_retention_idx ON commerce.photo_request_blobs (environment, created_at)
  WHERE deleted_at IS NULL;

-- Uploads diretos são intenções autenticadas, não fotos aprovadas. Só o worker
-- pode transformá-los em anexos, após verificar e reencodar os bytes reais.
CREATE TABLE commerce.photo_uploads (
  id uuid PRIMARY KEY,
  environment public.env_t NOT NULL,
  unit_id uuid NOT NULL REFERENCES core.units(id),
  photo_request_id uuid NOT NULL REFERENCES commerce.photo_requests(id),
  state text NOT NULL DEFAULT 'uploading' CHECK (state IN ('uploading','queued','ready','rejected')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  error_code text,
  temporary_deleted_at timestamptz
);
ALTER TABLE commerce.photo_uploads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON commerce.photo_uploads FROM PUBLIC, farejador_partner_app;
GRANT SELECT (id,environment,unit_id,photo_request_id,state,created_at,updated_at,error_code),
  INSERT (id,environment,unit_id,photo_request_id), UPDATE (state,updated_at)
  ON commerce.photo_uploads TO farejador_partner_app;
CREATE POLICY photo_upload_read ON commerce.photo_uploads FOR SELECT TO farejador_partner_app
USING (unit_id=network.current_partner_core_unit() AND EXISTS (
  SELECT 1 FROM commerce.photo_requests p WHERE p.id=photo_request_id
    AND p.environment=photo_uploads.environment AND p.unit_id=photo_uploads.unit_id));
CREATE POLICY photo_upload_insert ON commerce.photo_uploads FOR INSERT TO farejador_partner_app
WITH CHECK (state='uploading' AND unit_id=network.current_partner_core_unit() AND EXISTS (
  SELECT 1 FROM commerce.photo_requests p WHERE p.id=photo_request_id
    AND p.environment=photo_uploads.environment AND p.unit_id=photo_uploads.unit_id));
CREATE POLICY photo_upload_queue ON commerce.photo_uploads FOR UPDATE TO farejador_partner_app
USING (state IN ('uploading','queued') AND unit_id=network.current_partner_core_unit() AND EXISTS (
  SELECT 1 FROM commerce.photo_requests p WHERE p.id=photo_request_id
    AND p.environment=photo_uploads.environment AND p.unit_id=photo_uploads.unit_id))
WITH CHECK (state IN ('uploading','queued') AND unit_id=network.current_partner_core_unit() AND EXISTS (
  SELECT 1 FROM commerce.photo_requests p WHERE p.id=photo_request_id
    AND p.environment=photo_uploads.environment AND p.unit_id=photo_uploads.unit_id));
CREATE INDEX photo_upload_work_idx ON commerce.photo_uploads (environment, state, updated_at);

CREATE FUNCTION commerce.reject_purged_photo_upload() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,commerce AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM commerce.photo_request_blobs b
    WHERE b.photo_request_id=NEW.photo_request_id AND b.environment=NEW.environment AND b.deleted_at IS NOT NULL) THEN
    RAISE EXCEPTION 'photo_request_closed' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reject_purged_photo_upload BEFORE INSERT ON commerce.photo_request_blobs
  FOR EACH ROW EXECUTE FUNCTION commerce.reject_purged_photo_upload();

CREATE OR REPLACE VIEW commerce.partner_photo_queue WITH (security_invoker = true) AS
SELECT pr.id, pr.unit_id, pr.tire_size, pr.brand, pr.note, pr.status, pr.was_late,
       pr.expires_at, pr.answered_at, pr.created_at,
       EXISTS(SELECT 1 FROM commerce.photo_request_blobs b
         WHERE b.photo_request_id=pr.id AND b.deleted_at IS NULL) AS has_photo,
       (SELECT count(*) FROM commerce.photo_request_blobs b
         WHERE b.photo_request_id=pr.id AND b.deleted_at IS NULL)::integer AS photo_count,
       pr.customer_label AS customer_name, pr.photo_group_id, pr.tire_condition
FROM commerce.photo_requests pr;

-- Encerramento operacional: pagamento sozinho NÃO encerra retirada/entrega.
-- Conversa reaberta, pedido ativo e qualquer envio pendente impedem a limpeza.
-- A view é administrativa e jamais concedida ao parceiro (não expõe Chatwoot).
CREATE VIEW commerce.tire_photo_retention AS
SELECT pr.id AS photo_request_id, pr.environment, pr.unit_id,
  GREATEST(pr.answered_at, pr.created_at, CASE WHEN c.current_status='resolved' THEN c.resolved_at END,
    CASE
      WHEN po.id IS NOT NULL THEN CASE
        WHEN po.status='cancelled' THEN po.updated_at
        WHEN po.fulfillment_mode='delivery' THEN po.delivered_at
        WHEN NOT po.awaiting_pickup AND po.status IN ('paid','delivered') THEN COALESCE(po.retrieved_at,po.closed_at)
      END
      WHEN matrix_orders.n > 0 THEN matrix_orders.closed_at
      WHEN c.current_status='resolved' THEN COALESCE(c.resolved_at,c.updated_at)
      WHEN c.id IS NULL AND pr.conversation_id < 0 AND pr.expires_at < now()
        THEN GREATEST(pr.expires_at,pr.answered_at)
      WHEN c.id IS NULL AND pr.status IN ('expired','cancelled','expired_after_answer') THEN pr.updated_at
    END) AS closed_at,
  (po.id IS NOT NULL AND po.status<>'cancelled' AND (
    (po.fulfillment_mode='delivery' AND po.delivered_at IS NULL)
    OR (po.fulfillment_mode='pickup' AND (po.awaiting_pickup OR po.status IN ('open','confirmed')))))
  OR COALESCE(matrix_orders.active,false)
  OR (c.id IS NOT NULL AND c.current_status<>'resolved')
  OR (po.id IS NULL AND matrix_orders.n=0 AND c.id IS NULL
    AND NOT (pr.conversation_id<0 AND pr.expires_at<now())
    AND pr.status NOT IN ('expired','cancelled','expired_after_answer'))
  OR EXISTS (SELECT 1 FROM commerce.photo_uploads u WHERE u.environment=pr.environment
      AND u.photo_request_id=pr.id AND u.state IN ('uploading','queued')
      AND u.created_at>now()-interval '24 hours')
  OR EXISTS (SELECT 1 FROM ops.outbound_messages m WHERE m.environment=pr.environment
      AND m.status IN ('pending','sending','failed','dead_letter')
      AND ((CASE WHEN m.kind='photo_attachment' THEN m.body::jsonb->>'photo_request_id' END=pr.id::text)
        OR (m.kind='operator_attachment' AND EXISTS (SELECT 1 FROM ops.operator_messages om
          WHERE om.environment=m.environment AND om.outbound_id=m.id AND om.photo_request_id=pr.id)))) AS protected
FROM commerce.photo_requests pr
LEFT JOIN commerce.partner_order_items poi ON poi.id=pr.order_item_id AND poi.environment=pr.environment
LEFT JOIN commerce.partner_orders po ON po.id=poi.order_id AND po.environment=pr.environment
LEFT JOIN core.conversations c ON c.environment=pr.environment AND c.chatwoot_conversation_id=pr.conversation_id
LEFT JOIN LATERAL (
  SELECT count(*) AS n,
    bool_or(CASE WHEN linked.id IS NOT NULL THEN linked.status<>'cancelled' AND (
      (linked.fulfillment_mode='delivery' AND linked.delivered_at IS NULL)
      OR (linked.fulfillment_mode='pickup' AND (linked.awaiting_pickup OR linked.status IN ('open','confirmed'))))
    ELSE o.status<>'cancelled' AND (
      (o.fulfillment_mode='delivery' AND o.delivered_at IS NULL)
      OR (o.fulfillment_mode='pickup' AND o.retrieved_at IS NULL)) END) AS active,
    max(CASE WHEN linked.id IS NOT NULL THEN CASE
      WHEN linked.status='cancelled' THEN linked.updated_at
      WHEN linked.fulfillment_mode='delivery' THEN linked.delivered_at
      WHEN NOT linked.awaiting_pickup AND linked.status IN ('paid','delivered') THEN COALESCE(linked.retrieved_at,linked.closed_at) END
    WHEN o.status='cancelled' THEN o.updated_at
    WHEN o.fulfillment_mode='delivery' THEN o.delivered_at ELSE o.retrieved_at END) AS closed_at
  FROM commerce.orders o LEFT JOIN commerce.partner_orders linked ON linked.id=o.partner_order_id AND linked.environment=o.environment
  WHERE o.environment=pr.environment AND o.source_conversation_id=c.id
) matrix_orders ON true;
REVOKE ALL ON commerce.tire_photo_retention FROM PUBLIC, farejador_partner_app;

COMMENT ON TABLE commerce.photo_uploads IS 'Intenções opacas de upload privado. Validação determinística em worker; sem dados do cliente.';
COMMENT ON COLUMN commerce.photo_request_blobs.deleted_at IS 'Imagem eliminada 48h após encerramento operacional; metadados mínimos preservados.';
