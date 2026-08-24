-- ============================================================
-- 0205 - Telemetria minima do Estoque no painel moderno
--
-- Apenas amplia os valores aceitos pelo canario. Nao altera estoque,
-- reservas, custos, vendas ou permissoes da unidade.
-- ============================================================

ALTER TABLE ops.partner_panel_canary_events
  DROP CONSTRAINT IF EXISTS partner_panel_canary_events_page_check;

ALTER TABLE ops.partner_panel_canary_events
  ADD CONSTRAINT partner_panel_canary_events_page_check
  CHECK (page IN ('resumo','retiradas','estoque'));

ALTER TABLE ops.partner_panel_canary_events
  DROP CONSTRAINT IF EXISTS partner_panel_canary_events_operation_check;

ALTER TABLE ops.partner_panel_canary_events
  ADD CONSTRAINT partner_panel_canary_events_operation_check
  CHECK (operation IS NULL OR operation IN (
    'load_summary','load_pickups','confirm_pickup','cancel_pickup',
    'load_stock','load_stock_detail','request_stock_count'
  ));

DO $smoke$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid='ops.partner_panel_canary_events'::regclass
       AND conname='partner_panel_canary_events_page_check'
       AND pg_get_constraintdef(oid) ILIKE '%estoque%'
  ) THEN
    RAISE EXCEPTION 'smoke 0205: pagina estoque ausente da telemetria';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid='ops.partner_panel_canary_events'::regclass
       AND conname='partner_panel_canary_events_operation_check'
       AND pg_get_constraintdef(oid) ILIKE '%request_stock_count%'
  ) THEN
    RAISE EXCEPTION 'smoke 0205: operacoes de estoque ausentes da telemetria';
  END IF;
END
$smoke$;
