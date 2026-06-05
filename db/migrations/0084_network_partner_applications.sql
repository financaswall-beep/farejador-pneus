-- 0084: candidaturas de parceiro (Etapa 3 onboarding — funil de recrutamento).
--
-- Página pública "quero ser parceiro" insere aqui (status=pending). O dono vê a fila
-- na matriz e aprova → cria o parceiro (reusa createPartnerUnit) → marca approved.
-- Os termos comerciais (comissão/mensalidade) NÃO vêm do candidato — o dono define na aprovação.
-- Aditiva. Acesso só via backend confiável (mesma postura das demais tabelas centrais).

CREATE TABLE IF NOT EXISTS network.partner_applications (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment              text NOT NULL,
  trade_name               text NOT NULL,           -- nome da borracharia
  responsible_name         text,
  whatsapp_phone           text,
  email                    text,
  address                  text,
  municipios               text,                    -- cidades que ELE diz atender (desejo; dono confirma)
  message                  text,                    -- recado livre do candidato
  status                   text NOT NULL DEFAULT 'pending',
  created_at               timestamptz NOT NULL DEFAULT now(),
  reviewed_by              text,
  reviewed_at              timestamptz,
  review_notes             text,
  created_partner_unit_id  uuid,                    -- preenchido na aprovação (link pro parceiro criado)
  CONSTRAINT partner_applications_status_chk CHECK (status IN ('pending', 'approved', 'rejected'))
);

CREATE INDEX IF NOT EXISTS partner_applications_queue_idx
  ON network.partner_applications (environment, status, created_at DESC);

COMMENT ON TABLE network.partner_applications IS
  'Candidaturas "quero ser parceiro" (Etapa 3). Público insere pending; dono aprova na matriz → createPartnerUnit. Termos comerciais definidos na aprovação, não pelo candidato.';
