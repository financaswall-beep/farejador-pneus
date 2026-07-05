-- ============================================================
-- 0125_entregador_portal.sql
-- PORTAL DO ENTREGADOR — fatia C da Logística (0121) + vínculo com
-- Colaboradores (0124). Decisão do dono 2026-07-04.
--
-- O entregador (colaborador job='entregador') loga no celular em /entregas e
-- opera SÓ a entrega: fila do dia, abrir a rota DELE (km), entregue/reporte,
-- fechar rota (km, gasolina, comprovante). Revisão de segurança pré-código
-- 07-04 (FIX-ANTES aplicado): posse da rota no WHERE de toda escrita; card
-- financeiramente cego; não-entregue só REPORTA (quem cancela é o dono).
--
-- 1. network.matriz_staff_sessions — sessão do STAFF da matriz (token es_,
--    hash sha256, TTL 7 dias). Validação SEMPRE numa query só com o colaborador
--    ATIVO job='entregador' no mesmo predicado → revogar o colaborador mata a
--    sessão NA HORA. Zero grant pro farejador_partner_app (DO abaixo).
-- 2. commerce.matriz_delivery_trips.courier_collaborator_id — a rota ganha
--    dono. Índice ÚNICO parcial = um entregador só tem UMA rota aberta (a
--    corrida de dois cliques morre na constraint, não em SELECT-then-INSERT).
--    Rota aberta pelo dono no painel segue NULL (texto livre) — o painel manda
--    em tudo; o portal só enxerga rota com dono.
-- 3. commerce.orders.delivery_failure_reason — motivo do NÃO-ENTREGUE
--    REPORTADO pelo entregador. O portal NÃO cancela pedido nem devolve galpão
--    (cancel_manual_order não tem freio de permissão — regra do seguranca):
--    o dono confirma no painel (aí sim o caminho atômico fdd9148 roda).
--
-- ADITIVA e DORMENTE (flag MATRIZ_ENTREGADOR_PORTAL default OFF; exige
-- MATRIZ_LOGISTICS on). Rollback comentado no fim.
-- ─────────────────────────────────────────────
-- ROLLBACK (reverter o backend primeiro):
--   ALTER TABLE commerce.orders DROP COLUMN delivery_failure_reason;
--   DROP INDEX commerce.matriz_trips_one_open_per_courier;
--   DROP TRIGGER env_match_matriz_trips_collab ON commerce.matriz_delivery_trips;
--   ALTER TABLE commerce.matriz_delivery_trips DROP COLUMN courier_collaborator_id;
--   DROP TRIGGER env_match_staff_sessions_person ON network.matriz_staff_sessions;
--   DROP TRIGGER env_immutable_staff_sessions ON network.matriz_staff_sessions;
--   DROP TABLE network.matriz_staff_sessions;
-- ─────────────────────────────────────────────
-- Assinatura: Orquestrador (Claude Fable 5) — banco/matriz/seguranca, 2026-07-04

-- ── 1. Sessão do staff da matriz ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS network.matriz_staff_sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment   env_t NOT NULL,
  person_id     UUID NOT NULL REFERENCES network.partner_people(id),
  session_hash  TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  last_used_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ
);

COMMENT ON TABLE network.matriz_staff_sessions IS
  '0125: sessão do STAFF da matriz (portal /entregas; token prefixo es_, banco guarda só o sha256). TTL 7 dias. A validação JUNTA o colaborador ativo job=entregador no mesmo predicado — revogar o colaborador (0124) mata a sessão na hora. SÓ matriz — zero grant pro farejador_partner_app.';

CREATE UNIQUE INDEX IF NOT EXISTS matriz_staff_sessions_hash_uq
  ON network.matriz_staff_sessions (session_hash);

CREATE INDEX IF NOT EXISTS matriz_staff_sessions_person_idx
  ON network.matriz_staff_sessions (person_id)
  WHERE revoked_at IS NULL;

DROP TRIGGER IF EXISTS env_immutable_staff_sessions ON network.matriz_staff_sessions;
CREATE TRIGGER env_immutable_staff_sessions
  BEFORE UPDATE OF environment ON network.matriz_staff_sessions
  FOR EACH ROW EXECUTE FUNCTION ops.enforce_environment_immutable();

DROP TRIGGER IF EXISTS env_match_staff_sessions_person ON network.matriz_staff_sessions;
CREATE TRIGGER env_match_staff_sessions_person
  BEFORE INSERT OR UPDATE OF person_id ON network.matriz_staff_sessions
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('network', 'partner_people', 'person_id');

-- ── 2. A rota ganha dono (colaborador) ───────────────────────────────────────
ALTER TABLE commerce.matriz_delivery_trips
  ADD COLUMN IF NOT EXISTS courier_collaborator_id UUID REFERENCES network.matriz_collaborators(id);

COMMENT ON COLUMN commerce.matriz_delivery_trips.courier_collaborator_id IS
  '0125: o DONO da rota (colaborador 0124, job entregador) quando aberta pelo portal /entregas. NULL = rota aberta pelo painel do dono (texto livre) — invisível pro portal. A POSSE de toda escrita do portal é este id no WHERE.';

-- Um entregador só tem UMA rota aberta (dois cliques → o segundo morre aqui).
CREATE UNIQUE INDEX IF NOT EXISTS matriz_trips_one_open_per_courier
  ON commerce.matriz_delivery_trips (environment, courier_collaborator_id)
  WHERE status = 'open' AND courier_collaborator_id IS NOT NULL AND deleted_at IS NULL;

DROP TRIGGER IF EXISTS env_match_matriz_trips_collab ON commerce.matriz_delivery_trips;
CREATE TRIGGER env_match_matriz_trips_collab
  BEFORE INSERT OR UPDATE OF courier_collaborator_id ON commerce.matriz_delivery_trips
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('network', 'matriz_collaborators', 'courier_collaborator_id');

-- ── 3. Motivo do não-entregue REPORTADO (dono confirma no painel) ────────────
ALTER TABLE commerce.orders
  ADD COLUMN IF NOT EXISTS delivery_failure_reason TEXT;

COMMENT ON COLUMN commerce.orders.delivery_failure_reason IS
  '0125: motivo do NÃO-ENTREGUE reportado pelo entregador no portal. Pedido fica delivery_status=failed SEM cancelar (galpão intocado) até o dono CONFIRMAR no painel (aí roda o caminho atômico de cancelamento fdd9148) ou RECOLOCAR na fila.';

-- ── PROVA (molde 0121/0124): tudo existe e o pool do parceiro NÃO alcança ────
DO $$
DECLARE
  v_sel BOOLEAN;
  v_ins BOOLEAN;
BEGIN
  IF to_regclass('network.matriz_staff_sessions') IS NULL THEN
    RAISE EXCEPTION '0125 falhou: network.matriz_staff_sessions nao existe';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'commerce' AND table_name = 'matriz_delivery_trips'
                    AND column_name = 'courier_collaborator_id') THEN
    RAISE EXCEPTION '0125 falhou: courier_collaborator_id nao existe em matriz_delivery_trips';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'commerce' AND table_name = 'orders'
                    AND column_name = 'delivery_failure_reason') THEN
    RAISE EXCEPTION '0125 falhou: delivery_failure_reason nao existe em orders';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'farejador_partner_app') THEN
    SELECT has_table_privilege('farejador_partner_app', 'network.matriz_staff_sessions', 'SELECT') INTO v_sel;
    SELECT has_table_privilege('farejador_partner_app', 'network.matriz_staff_sessions', 'INSERT') INTO v_ins;
    IF v_sel OR v_ins THEN
      RAISE EXCEPTION '0125 falhou: farejador_partner_app NAO deveria acessar matriz_staff_sessions (select=%, insert=%)', v_sel, v_ins;
    END IF;
  END IF;

  RAISE NOTICE '0125 OK: portal do entregador pronto (dormente, flag MATRIZ_ENTREGADOR_PORTAL); parceiro sem acesso.';
END $$;
