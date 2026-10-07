-- Agrupa fotos da mesma conversa/unidade sem expor IDs do Chatwoot ou telefone.
ALTER TABLE commerce.photo_requests
  ADD COLUMN IF NOT EXISTS photo_group_id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE commerce.photo_requests
  ADD COLUMN IF NOT EXISTS tire_condition text CHECK (tire_condition IN ('novo','meia_vida','remold'));

-- Backfill somente dos pedidos ativos, isolado por ambiente e unidade.
WITH groups AS (
  SELECT environment, unit_id, conversation_id, min(id::text)::uuid AS group_id
    FROM commerce.photo_requests WHERE status IN ('pending', 'answered')
   GROUP BY environment, unit_id, conversation_id
)
UPDATE commerce.photo_requests pr SET photo_group_id = groups.group_id
  FROM groups WHERE pr.environment = groups.environment AND pr.unit_id = groups.unit_id
    AND pr.conversation_id = groups.conversation_id AND pr.status IN ('pending', 'answered');

GRANT SELECT (photo_group_id, tire_condition) ON commerce.photo_requests TO farejador_partner_app;
CREATE OR REPLACE VIEW commerce.partner_photo_queue WITH (security_invoker = true) AS
SELECT pr.id, pr.unit_id, pr.tire_size, pr.brand, pr.note, pr.status, pr.was_late,
       pr.expires_at, pr.answered_at, pr.created_at,
       EXISTS(SELECT 1 FROM commerce.photo_request_blobs b WHERE b.photo_request_id = pr.id) AS has_photo,
       (SELECT count(*) FROM commerce.photo_request_blobs b WHERE b.photo_request_id = pr.id)::integer AS photo_count,
       pr.customer_label AS customer_name, pr.photo_group_id, pr.tire_condition
  FROM commerce.photo_requests pr;
GRANT SELECT (photo_group_id, tire_condition) ON commerce.partner_photo_queue TO farejador_partner_app;
