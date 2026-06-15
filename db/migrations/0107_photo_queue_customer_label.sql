-- 0107_photo_queue_customer_label.sql
-- Card de "Avisos" passa a mostrar o NOME do cliente (pra o borracheiro
-- diferenciar as pessoas). Decisão do dono 2026-06-15: NOME apenas — sem
-- telefone/contato. Só o nome não permite contatar fora da Rede, então NÃO
-- fura a comissão (reverte SÓ o necessário do E16, que escondia tudo).
--
-- Fonte do nome = o BOT, no momento de criar o pedido (core.contacts.name via
-- a conversa). Gravado numa coluna nova `customer_label` na photo_requests —
-- confiável (não depende do fan-out do chat, que não cobre essas conversas).
--
-- Exposição: grant SELECT SÓ da coluna nova ao farejador_partner_app (o painel
-- lê por coluna; conversation_id/contact_id CONTINUAM sem grant = escondidos).
-- A view é security_invoker=true (PRESERVADO) → RLS por unidade segura tudo:
-- o parceiro só vê o nome de quem caiu PRA ELE. Telefone (customer_identifier)
-- NÃO é tocado. Idempotente.

ALTER TABLE commerce.photo_requests
  ADD COLUMN IF NOT EXISTS customer_label text;

GRANT SELECT (customer_label) ON commerce.photo_requests TO farejador_partner_app;

-- View recriada: mantém as colunas existentes NA MESMA ORDEM (regra do CREATE OR
-- REPLACE) e ADICIONA customer_name no fim. security_invoker preservado.
CREATE OR REPLACE VIEW commerce.partner_photo_queue
  WITH (security_invoker = true) AS
  SELECT pr.id,
         pr.unit_id,
         pr.tire_size,
         pr.brand,
         pr.note,
         pr.status,
         pr.was_late,
         pr.expires_at,
         pr.answered_at,
         pr.created_at,
         (EXISTS (
            SELECT 1 FROM commerce.photo_request_blobs b
             WHERE b.photo_request_id = pr.id
         )) AS has_photo,
         ((
            SELECT count(*) FROM commerce.photo_request_blobs b
             WHERE b.photo_request_id = pr.id
         ))::integer AS photo_count,
         pr.customer_label AS customer_name
    FROM commerce.photo_requests pr;
