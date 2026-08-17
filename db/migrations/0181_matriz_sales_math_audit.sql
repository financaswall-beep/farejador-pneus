-- 0181: auditoria matemática formal de Vendas da Matriz.
-- Garante centavos/limites também na função SQL legada, alinha o perfil do
-- cliente à régua de venda realizada e expõe uma reconciliação somente leitura.

CREATE OR REPLACE FUNCTION commerce.register_manual_order(
  p_environment        TEXT,
  p_contact_id         UUID,
  p_conversation_id    UUID,
  p_draft_id           UUID,
  p_unit_id            UUID,
  p_items              JSONB,
  p_payment_method     TEXT,
  p_fulfillment_mode   TEXT,
  p_delivery_address   TEXT,
  p_actor_label        TEXT,
  p_idempotency_key    TEXT,
  p_source_tag         TEXT DEFAULT NULL
) RETURNS UUID AS $$
DECLARE
  v_order_id   UUID;
  v_existing   UUID;
  v_unit_id    UUID;
  v_total      NUMERIC := 0;
  v_line_total NUMERIC;
  v_item       JSONB;
  v_qty_raw    NUMERIC;
  v_qty        INTEGER;
  v_price      NUMERIC;
  v_discount   NUMERIC;
  v_source     TEXT;
BEGIN
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) < 8 THEN
    RAISE EXCEPTION 'idempotency_key obrigatorio (min 8 chars)';
  END IF;

  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array'
     OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'sale_items_required' USING ERRCODE = '23514';
  END IF;
  IF jsonb_array_length(p_items) > 100 THEN
    RAISE EXCEPTION 'sale_items_limit' USING ERRCODE = '23514';
  END IF;

  v_unit_id := p_unit_id;
  IF v_unit_id IS NULL THEN
    SELECT id INTO v_unit_id
      FROM core.units
     WHERE environment = p_environment AND slug = 'main' AND is_active
     LIMIT 1;
  END IF;
  IF v_unit_id IS NULL THEN
    RAISE EXCEPTION 'unit_id obrigatorio ou unidade main ausente para environment=%',
      p_environment;
  END IF;

  IF p_source_tag IS NULL THEN
    v_source := CASE WHEN p_draft_id IS NOT NULL
      THEN 'chatwoot_com_bot' ELSE 'chatwoot_sem_bot' END;
  ELSE
    v_source := p_source_tag;
  END IF;
  IF v_source NOT IN ('chatwoot_com_bot', 'chatwoot_sem_bot') THEN
    RAISE EXCEPTION 'source_tag invalido para venda Chatwoot: %', v_source;
  END IF;

  SELECT id INTO v_existing
    FROM commerce.orders
   WHERE environment = p_environment::env_t
     AND idempotency_key = p_idempotency_key;
  IF v_existing IS NOT NULL THEN
    RETURN v_existing;
  END IF;

  IF p_draft_id IS NOT NULL THEN
    PERFORM 1 FROM agent.order_drafts WHERE id = p_draft_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Draft nao encontrado: %', p_draft_id;
    END IF;
    IF (SELECT promoted_order_id FROM agent.order_drafts WHERE id = p_draft_id) IS NOT NULL THEN
      RAISE EXCEPTION 'Pedido ja registrado para este draft (draft_id=%)', p_draft_id
        USING ERRCODE = 'unique_violation';
    END IF;
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    BEGIN
      v_qty_raw := (v_item->>'quantity')::NUMERIC;
      v_price := (v_item->>'unit_price')::NUMERIC;
      v_discount := COALESCE((v_item->>'discount_amount')::NUMERIC, 0);
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'sale_item_invalid' USING ERRCODE = '23514';
    END;

    IF v_qty_raw IS NULL OR v_qty_raw <> trunc(v_qty_raw)
       OR v_qty_raw <= 0 OR v_qty_raw > 100000 THEN
      RAISE EXCEPTION 'sale_quantity_invalid' USING ERRCODE = '23514';
    END IF;
    v_qty := v_qty_raw::INTEGER;
    IF v_price IS NULL OR v_price < 0 OR v_price > 99999999.99 THEN
      RAISE EXCEPTION 'sale_unit_price_invalid' USING ERRCODE = '23514';
    END IF;
    IF v_price <> round(v_price, 2) THEN
      RAISE EXCEPTION 'unit_price_cent_precision' USING ERRCODE = '23514';
    END IF;
    IF v_discount < 0 OR v_discount > 99999999.99 THEN
      RAISE EXCEPTION 'sale_discount_invalid' USING ERRCODE = '23514';
    END IF;
    IF v_discount <> round(v_discount, 2) THEN
      RAISE EXCEPTION 'discount_cent_precision' USING ERRCODE = '23514';
    END IF;
    IF v_qty * v_price > 99999999.99 THEN
      RAISE EXCEPTION 'sale_line_total_too_large' USING ERRCODE = '23514';
    END IF;
    IF v_discount > v_qty * v_price THEN
      RAISE EXCEPTION 'discount_exceeds_line_total' USING ERRCODE = '23514';
    END IF;
    v_line_total := v_qty * v_price - v_discount;
    v_total := v_total + v_line_total;
    IF v_total > 99999999.99 THEN
      RAISE EXCEPTION 'sale_total_too_large' USING ERRCODE = '23514';
    END IF;
  END LOOP;

  INSERT INTO commerce.orders (
    environment, contact_id, source_conversation_id,
    total_amount, status, fulfillment_mode, payment_method,
    delivery_address, closed_by, closed_at,
    idempotency_key, source, unit_id, promoted_from_draft_id
  ) VALUES (
    p_environment, p_contact_id, p_conversation_id,
    v_total, 'confirmed', p_fulfillment_mode, p_payment_method,
    p_delivery_address, p_actor_label, now(),
    p_idempotency_key, v_source, v_unit_id, p_draft_id
  ) RETURNING id INTO v_order_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    INSERT INTO commerce.order_items (
      environment, order_id, product_id, quantity, unit_price, discount_amount
    ) VALUES (
      p_environment, v_order_id,
      (v_item->>'product_id')::UUID,
      ((v_item->>'quantity')::NUMERIC)::INTEGER,
      (v_item->>'unit_price')::NUMERIC,
      COALESCE((v_item->>'discount_amount')::NUMERIC, 0)
    );
  END LOOP;

  IF (SELECT COALESCE(sum(quantity * unit_price - discount_amount), 0)
        FROM commerce.order_items
       WHERE environment=p_environment::env_t AND order_id=v_order_id) <> v_total THEN
    RAISE EXCEPTION 'retail_sale_total_mismatch' USING ERRCODE = '23514';
  END IF;

  IF p_draft_id IS NOT NULL THEN
    UPDATE agent.order_drafts
       SET promoted_order_id = v_order_id, draft_status = 'promoted',
           promoted_by = p_actor_label, promoted_at = now(), updated_at = now()
     WHERE id = p_draft_id;
  END IF;

  INSERT INTO audit.events (
    environment, domain, entity_table, entity_id, event_type,
    actor_label, idempotency_key, payload_after
  ) VALUES (
    p_environment, 'orders', 'commerce.orders', v_order_id, 'manual_order_created',
    p_actor_label, p_idempotency_key,
    jsonb_build_object(
      'total', v_total, 'items', p_items, 'draft_id', p_draft_id,
      'unit_id', v_unit_id, 'source', v_source,
      'payment_method', p_payment_method, 'fulfillment_mode', p_fulfillment_mode
    )
  );
  RETURN v_order_id;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION commerce.register_manual_order IS
  '0181: venda manual Chatwoot atômica, idempotente e validada em centavos/limites.';

-- Pedido aberto é reserva/processo operacional, não compra concluída do cliente.
CREATE OR REPLACE VIEW commerce.customer_profile AS
SELECT
  contact_id,
  environment,
  COUNT(*) FILTER (WHERE status IN ('confirmed','paid','delivered')) AS total_orders,
  SUM(total_amount) FILTER (WHERE status IN ('confirmed','paid','delivered')) AS total_spent,
  AVG(total_amount) FILTER (WHERE status IN ('confirmed','paid','delivered')) AS avg_ticket,
  MIN(created_at) FILTER (WHERE status IN ('confirmed','paid','delivered')) AS first_order_at,
  MAX(created_at) FILTER (WHERE status IN ('confirmed','paid','delivered')) AS last_order_at,
  COUNT(DISTINCT geo_resolution_id)
    FILTER (WHERE status IN ('confirmed','paid','delivered')) AS distinct_delivery_zones,
  ARRAY_AGG(DISTINCT payment_method)
    FILTER (WHERE status IN ('confirmed','paid','delivered') AND payment_method IS NOT NULL)
      AS used_payment_methods,
  COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled_orders,
  COUNT(*) FILTER (WHERE status IN ('confirmed','paid','delivered')
    AND created_at > now() - interval '90 days') AS orders_last_90d,
  COUNT(*) AS total_orders_including_cancelled
FROM commerce.orders
GROUP BY contact_id, environment;

-- Smoke/auditoria: toda métrica precisa voltar zero. Entrega aceita total maior
-- que os itens porque a diferença é o frete; nunca aceita total menor.
CREATE OR REPLACE FUNCTION commerce.matriz_sales_math_reconciliation(
  p_environment env_t
) RETURNS TABLE(metric text, affected_rows bigint)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, commerce, core
AS $fn$
  WITH retail AS (
    SELECT o.id,o.status,o.fulfillment_mode,o.total_amount,
           count(i.id) item_count,
           COALESCE(sum(i.quantity*i.unit_price-i.discount_amount),0) item_total
      FROM commerce.orders o
      JOIN core.units u ON u.id=o.unit_id AND u.environment=o.environment
       AND u.slug='main'
      LEFT JOIN commerce.order_items i
        ON i.order_id=o.id AND i.environment=o.environment
     WHERE o.environment=p_environment AND o.partner_order_id IS NULL
     GROUP BY o.id
  ), wholesale AS (
    SELECT o.id,o.status,o.total_amount,count(i.id) item_count,
           COALESCE(sum(i.line_total),0) item_total
      FROM commerce.wholesale_orders o
      LEFT JOIN commerce.wholesale_order_items i
        ON i.order_id=o.id AND i.environment=o.environment
     WHERE o.environment=p_environment
     GROUP BY o.id
  )
  SELECT 'retail_realized_without_items',count(*) FROM retail
   WHERE status IN ('confirmed','paid','delivered') AND item_count=0
  UNION ALL
  SELECT 'retail_pickup_total_mismatch',count(*) FROM retail
   WHERE status IN ('confirmed','paid','delivered') AND item_count>0
     AND fulfillment_mode='pickup' AND total_amount<>item_total
  UNION ALL
  SELECT 'retail_delivery_total_below_items',count(*) FROM retail
   WHERE status IN ('confirmed','paid','delivered') AND item_count>0
     AND fulfillment_mode='delivery' AND total_amount<item_total
  UNION ALL
  SELECT 'wholesale_confirmed_without_items',count(*) FROM wholesale
   WHERE status='confirmed' AND item_count=0
  UNION ALL
  SELECT 'wholesale_header_total_mismatch',count(*) FROM wholesale
   WHERE status='confirmed' AND item_count>0 AND total_amount<>item_total
$fn$;

REVOKE ALL ON FUNCTION commerce.matriz_sales_math_reconciliation(env_t) FROM PUBLIC;

COMMENT ON FUNCTION commerce.matriz_sales_math_reconciliation IS
  '0181: reconciliação matemática read-only da Matriz; todas as métricas devem ser zero.';
