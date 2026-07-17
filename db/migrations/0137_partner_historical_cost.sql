-- 0137 — Etapa 6 / Fatia 6.1: custo histórico imutável da venda parceira.
--
-- Regras:
--   1. O custo nasce no item do pedido, na mesma transação que bloqueia o estoque.
--   2. Compra futura pode mudar average_cost do estoque, nunca o item já vendido.
--   3. Custo desconhecido fica pending/NULL; nunca é convertido silenciosamente em zero.
--   4. Histórico anterior permanece pending. Não há backfill pelo custo médio atual.
--   5. Views recriadas continuam security_invoker para preservar RLS.

ALTER TABLE commerce.partner_order_items
  ADD COLUMN IF NOT EXISTS unit_cost_snapshot NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS cost_status TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS cost_captured_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cost_source TEXT;

ALTER TABLE commerce.partner_order_items
  DROP CONSTRAINT IF EXISTS partner_order_items_cost_status_check;

ALTER TABLE commerce.partner_order_items
  ADD CONSTRAINT partner_order_items_cost_status_check CHECK (
    (cost_status = 'known'
      AND unit_cost_snapshot IS NOT NULL
      AND unit_cost_snapshot >= 0
      AND cost_captured_at IS NOT NULL
      AND cost_source IS NOT NULL)
    OR
    (cost_status = 'pending'
      AND unit_cost_snapshot IS NULL
      AND cost_captured_at IS NULL)
  );

COMMENT ON COLUMN commerce.partner_order_items.unit_cost_snapshot IS
  'Custo unitário histórico congelado quando o item entra no pedido. Nunca reler average_cost para reprecificar esta venda.';
COMMENT ON COLUMN commerce.partner_order_items.cost_status IS
  'known quando há snapshot comprovado; pending quando o custo não era conhecido. Pending nunca equivale a zero.';

CREATE OR REPLACE FUNCTION commerce.guard_partner_order_item_cost_snapshot()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.unit_cost_snapshot IS DISTINCT FROM NEW.unit_cost_snapshot
     OR OLD.cost_status IS DISTINCT FROM NEW.cost_status
     OR OLD.cost_captured_at IS DISTINCT FROM NEW.cost_captured_at
     OR OLD.cost_source IS DISTINCT FROM NEW.cost_source THEN
    -- Variável customizada sozinha não é autorização: qualquer role pode tentar
    -- defini-la. Só a conexão administrativa dona da migration pode reconciliar.
    IF COALESCE(current_setting('app.partner_cost_reconciliation', true), '') <> 'on'
       OR current_user <> pg_catalog.pg_get_userbyid(
         (SELECT relowner FROM pg_catalog.pg_class
           WHERE oid='commerce.partner_order_items'::regclass)
       ) THEN
      RAISE EXCEPTION 'partner_order_item_cost_snapshot_immutable'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS partner_order_item_cost_snapshot_immutable
  ON commerce.partner_order_items;
CREATE TRIGGER partner_order_item_cost_snapshot_immutable
BEFORE UPDATE OF unit_cost_snapshot, cost_status, cost_captured_at, cost_source
ON commerce.partner_order_items
FOR EACH ROW
EXECUTE FUNCTION commerce.guard_partner_order_item_cost_snapshot();

-- Mesma assinatura vigente da 0089. Somente a captura do custo é adicionada.
CREATE OR REPLACE FUNCTION commerce.register_partner_local_order(
  p_environment text,
  p_unit_id uuid,
  p_customer_name text,
  p_customer_phone text,
  p_items jsonb,
  p_payment_method text,
  p_fulfillment_mode text,
  p_delivery_address text,
  p_actor_label text,
  p_idempotency_key text,
  p_source_tag text,
  p_discount_amount numeric DEFAULT 0,
  p_freight_amount numeric DEFAULT 0,
  p_reserve_for_pickup boolean DEFAULT false
)
RETURNS uuid
LANGUAGE plpgsql
AS $function$
DECLARE
  v_order_id UUID;
  v_existing UUID;
  v_total NUMERIC := 0;
  v_discount_order NUMERIC := GREATEST(COALESCE(p_discount_amount, 0), 0);
  v_freight NUMERIC := GREATEST(COALESCE(p_freight_amount, 0), 0);
  v_item JSONB;
  v_stock_id UUID;
  v_qty INTEGER;
  v_price NUMERIC;
  v_discount NUMERIC;
  v_stock_row RECORD;
  v_moves JSONB := '[]'::jsonb;
  v_new_qty INTEGER;
  v_new_reserved INTEGER;
  v_new_status TEXT;
  v_is_delivery BOOLEAN := (p_fulfillment_mode = 'delivery');
  v_reserve BOOLEAN := (p_fulfillment_mode = 'delivery') OR COALESCE(p_reserve_for_pickup, false);
  v_available INTEGER;
BEGIN
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) < 8 THEN
    RAISE EXCEPTION 'idempotency_key obrigatorio (min 8 chars)';
  END IF;

  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Pedido precisa de pelo menos 1 item';
  END IF;

  SELECT id INTO v_existing
  FROM commerce.partner_orders
  WHERE idempotency_key = p_idempotency_key;
  IF v_existing IS NOT NULL THEN
    RETURN v_existing;
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_stock_id := (v_item->>'partner_stock_id')::UUID;
    v_qty := (v_item->>'quantity')::INTEGER;
    v_price := (v_item->>'unit_price')::NUMERIC;
    v_discount := COALESCE((v_item->>'discount_amount')::NUMERIC, 0);

    IF v_qty IS NULL OR v_qty <= 0 THEN
      RAISE EXCEPTION 'quantity invalida no item: %', v_item;
    END IF;
    IF v_price IS NULL OR v_price < 0 THEN
      RAISE EXCEPTION 'unit_price invalido no item: %', v_item;
    END IF;

    v_total := v_total + (v_qty * v_price - v_discount);

    IF v_stock_id IS NOT NULL THEN
      SELECT id, item_name, tire_size, brand, item_type, quantity_on_hand,
             quantity_reserved, minimum_quantity, average_cost,
             is_tracked, deleted_at
        INTO v_stock_row
      FROM commerce.partner_stock_levels
      WHERE id = v_stock_id
        AND environment = p_environment
        AND unit_id = p_unit_id
      FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Item de estoque nao pertence a esta unidade: %', v_stock_id;
      END IF;
      IF v_stock_row.deleted_at IS NOT NULL THEN
        RAISE EXCEPTION 'Item de estoque inativado: %', v_stock_id;
      END IF;

      IF v_stock_row.is_tracked AND v_stock_row.quantity_on_hand IS NOT NULL THEN
        v_available := v_stock_row.quantity_on_hand - COALESCE(v_stock_row.quantity_reserved, 0);
        IF v_available < v_qty THEN
          RAISE EXCEPTION 'Estoque insuficiente para "%": disponivel %, pedido %',
            v_stock_row.item_name, v_available, v_qty
            USING ERRCODE = '23514';
        END IF;

        IF v_reserve THEN
          UPDATE commerce.partner_stock_levels
          SET quantity_reserved = COALESCE(quantity_reserved, 0) + v_qty,
              stock_status = commerce.partner_stock_status(
                quantity_on_hand, COALESCE(quantity_reserved, 0) + v_qty,
                minimum_quantity, is_tracked),
              updated_at = now(), updated_by = p_actor_label
          WHERE id = v_stock_id
          RETURNING quantity_on_hand, quantity_reserved, stock_status
            INTO v_new_qty, v_new_reserved, v_new_status;

          v_moves := v_moves || jsonb_build_object(
            'stock_id', v_stock_id, 'item_name', v_stock_row.item_name,
            'reserved_delta', v_qty, 'new_qty', v_new_qty,
            'new_reserved', v_new_reserved, 'new_status', v_new_status);
        ELSE
          UPDATE commerce.partner_stock_levels
          SET quantity_on_hand = quantity_on_hand - v_qty,
              stock_status = commerce.partner_stock_status(
                quantity_on_hand - v_qty, COALESCE(quantity_reserved, 0),
                minimum_quantity, is_tracked),
              updated_at = now(), updated_by = p_actor_label
          WHERE id = v_stock_id
          RETURNING quantity_on_hand, quantity_reserved, stock_status
            INTO v_new_qty, v_new_reserved, v_new_status;

          v_moves := v_moves || jsonb_build_object(
            'stock_id', v_stock_id, 'item_name', v_stock_row.item_name,
            'delta', -v_qty, 'new_qty', v_new_qty,
            'new_reserved', v_new_reserved, 'new_status', v_new_status);
        END IF;
      END IF;
    END IF;
  END LOOP;

  v_total := GREATEST(v_total - v_discount_order + v_freight, 0);

  INSERT INTO commerce.partner_orders (
    environment, unit_id, customer_name, customer_phone,
    total_amount, discount_amount, freight_amount,
    status, payment_method, fulfillment_mode, delivery_address,
    source_tag, closed_by, closed_at, idempotency_key, awaiting_pickup
  ) VALUES (
    p_environment, p_unit_id,
    NULLIF(trim(COALESCE(p_customer_name, '')), ''),
    NULLIF(trim(COALESCE(p_customer_phone, '')), ''),
    v_total, v_discount_order, v_freight,
    'confirmed', p_payment_method, p_fulfillment_mode, p_delivery_address,
    COALESCE(p_source_tag, 'walkin_balcao'), p_actor_label, now(), p_idempotency_key,
    p_fulfillment_mode='pickup' AND COALESCE(p_reserve_for_pickup,false)
  ) RETURNING id INTO v_order_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_stock_id := (v_item->>'partner_stock_id')::UUID;
    v_qty := (v_item->>'quantity')::INTEGER;
    v_price := (v_item->>'unit_price')::NUMERIC;
    v_discount := COALESCE((v_item->>'discount_amount')::NUMERIC, 0);

    IF v_stock_id IS NOT NULL THEN
      -- A linha continua bloqueada desde o primeiro loop até o fim da transação.
      SELECT item_name, tire_size, brand, item_type, average_cost
        INTO v_stock_row
      FROM commerce.partner_stock_levels
      WHERE id = v_stock_id
        AND environment = p_environment
        AND unit_id = p_unit_id;

      INSERT INTO commerce.partner_order_items (
        environment, order_id, partner_stock_id,
        item_name, tire_size, brand, item_type,
        quantity, unit_price, discount_amount,
        unit_cost_snapshot, cost_status, cost_captured_at, cost_source
      ) VALUES (
        p_environment, v_order_id, v_stock_id,
        v_stock_row.item_name, v_stock_row.tire_size, v_stock_row.brand,
        v_stock_row.item_type, v_qty, v_price, v_discount,
        v_stock_row.average_cost,
        CASE WHEN v_stock_row.average_cost IS NULL THEN 'pending' ELSE 'known' END,
        CASE WHEN v_stock_row.average_cost IS NULL THEN NULL ELSE now() END,
        CASE WHEN v_stock_row.average_cost IS NULL THEN 'stock_cost_missing'
             ELSE 'partner_stock_average_at_order' END
      );
    ELSE
      INSERT INTO commerce.partner_order_items (
        environment, order_id, partner_stock_id,
        item_name, tire_size, brand, item_type,
        quantity, unit_price, discount_amount,
        unit_cost_snapshot, cost_status, cost_captured_at, cost_source
      ) VALUES (
        p_environment, v_order_id, NULL,
        COALESCE(v_item->>'item_name', 'Item livre'),
        NULL, NULL, NULLIF(v_item->>'item_type', ''),
        v_qty, v_price, v_discount,
        NULL, 'pending', NULL, 'free_item_without_cost'
      );
    END IF;
  END LOOP;

  INSERT INTO audit.events (
    environment, domain, entity_table, entity_id, event_type,
    actor_label, idempotency_key, payload_after
  ) VALUES (
    p_environment, 'partner_orders', 'commerce.partner_orders', v_order_id,
    'partner_order_created', p_actor_label, p_idempotency_key,
    jsonb_build_object(
      'total', v_total, 'discount_amount', v_discount_order,
      'freight_amount', v_freight, 'items', p_items, 'unit_id', p_unit_id)
  );

  IF jsonb_array_length(v_moves) > 0 THEN
    INSERT INTO audit.events (
      environment, domain, entity_table, entity_id, event_type,
      actor_label, payload_after
    ) VALUES (
      p_environment, 'stock', 'commerce.partner_stock_levels', v_order_id,
      CASE WHEN v_reserve THEN 'stock_reserved' ELSE 'stock_decrement_sale' END,
      p_actor_label,
      jsonb_build_object(
        'order_id', v_order_id, 'fulfillment_mode', p_fulfillment_mode,
        'reserved_for_pickup', COALESCE(p_reserve_for_pickup, false), 'moves', v_moves)
    );
  END IF;

  RETURN v_order_id;
END;
$function$;

-- A ordem das 24 colunas antigas é preservada; as novas são somente append.
CREATE OR REPLACE VIEW network.partner_unit_summary
WITH (security_invoker = true) AS
WITH month_bounds AS (
  SELECT
    (date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo')
      AT TIME ZONE 'America/Sao_Paulo') AS month_start_at,
    date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo')::date AS month_start_date
)
SELECT
  pu.environment,
  pu.id AS partner_unit_id,
  pu.unit_id,
  pu.slug,
  pu.display_name,
  p.id AS partner_id,
  p.trade_name AS partner_name,
  p.status AS partner_status,
  pu.status AS unit_status,
  COALESCE(orders_month.total_sales, 0::numeric) AS sales_month,
  COALESCE(orders_month.order_count, 0) AS orders_month,
  COALESCE(purchases_month.total_purchases, 0::numeric) AS purchases_month,
  COALESCE(expenses_month.total_expenses, 0::numeric) AS expenses_month,
  CASE WHEN COALESCE(cogs_month.pending_count, 0) = 0
    THEN COALESCE(orders_month.total_sales, 0::numeric)
      - COALESCE(cogs_month.known_total, 0::numeric)
      - COALESCE(expenses_month.total_expenses, 0::numeric)
    ELSE NULL::numeric END AS result_competencia_month,
  CASE WHEN COALESCE(cogs_month.pending_count, 0) = 0
    THEN COALESCE(orders_month.total_sales, 0::numeric)
      - COALESCE(cogs_month.known_total, 0::numeric)
      - COALESCE(expenses_month.total_expenses, 0::numeric)
    ELSE NULL::numeric END AS estimated_result_month,
  COALESCE(cash_in_month.total, 0::numeric) AS cash_in_month,
  COALESCE(cash_out_month.total, 0::numeric) AS cash_out_month,
  COALESCE(cash_in_month.total, 0::numeric) - COALESCE(cash_out_month.total, 0::numeric) AS cash_net_month,
  COALESCE(open_recv.total, 0::numeric) AS open_receivables_total,
  COALESCE(open_pay.total, 0::numeric) AS open_payables_total,
  COALESCE(open_recv.total, 0::numeric) - COALESCE(open_pay.total, 0::numeric) AS net_future_position,
  COALESCE(stock_counts.stock_items, 0) AS stock_items,
  COALESCE(stock_counts.low_stock_items, 0) AS low_stock_items,
  COALESCE(cogs_month.known_total, 0::numeric) AS cogs_month,
  COALESCE(cogs_month.known_total, 0::numeric) AS known_cogs_month,
  COALESCE(cogs_month.pending_count, 0) AS pending_cost_items_month,
  COALESCE(cogs_month.pending_revenue, 0::numeric) AS pending_cost_revenue_month,
  COALESCE(cogs_month.pending_count, 0) > 0 AS has_pending_cost_month,
  CASE WHEN COALESCE(cogs_month.pending_count, 0) = 0
    THEN COALESCE(orders_month.total_sales, 0::numeric)
      - COALESCE(cogs_month.known_total, 0::numeric)
      - COALESCE(expenses_month.total_expenses, 0::numeric)
    ELSE NULL::numeric END AS confirmed_result_month
FROM network.partner_units pu
JOIN network.partners p
  ON p.id=pu.partner_id AND p.environment=pu.environment
CROSS JOIN month_bounds mb
LEFT JOIN LATERAL (
  SELECT count(*)::integer AS order_count,
         COALESCE(sum(po.total_amount), 0::numeric) AS total_sales
  FROM commerce.partner_orders po
  WHERE po.environment=pu.environment AND po.unit_id=pu.unit_id
    AND po.status<>'cancelled' AND po.deleted_at IS NULL
    AND NOT (po.fulfillment_mode='delivery' AND po.delivery_status<>'delivered')
    AND NOT po.awaiting_pickup
    AND (CASE WHEN po.fulfillment_mode='delivery' THEN po.delivered_at
              ELSE COALESCE(po.retrieved_at,po.created_at) END) >= mb.month_start_at
) orders_month ON true
LEFT JOIN LATERAL (
  SELECT
    COALESCE(sum(oi.quantity::numeric * oi.unit_cost_snapshot)
      FILTER (WHERE oi.cost_status='known'), 0::numeric) AS known_total,
    count(*) FILTER (WHERE oi.cost_status='pending')::integer AS pending_count,
    COALESCE(sum(oi.quantity::numeric * oi.unit_price - oi.discount_amount)
      FILTER (WHERE oi.cost_status='pending'), 0::numeric) AS pending_revenue
  FROM commerce.partner_orders po_c
  JOIN commerce.partner_order_items oi
    ON oi.order_id=po_c.id AND oi.environment=po_c.environment
  WHERE po_c.environment=pu.environment AND po_c.unit_id=pu.unit_id
    AND po_c.status<>'cancelled' AND po_c.deleted_at IS NULL
    AND NOT (po_c.fulfillment_mode='delivery' AND po_c.delivery_status<>'delivered')
    AND NOT po_c.awaiting_pickup
    AND (CASE WHEN po_c.fulfillment_mode='delivery' THEN po_c.delivered_at
              ELSE COALESCE(po_c.retrieved_at,po_c.created_at) END) >= mb.month_start_at
) cogs_month ON true
LEFT JOIN LATERAL (
  SELECT COALESCE(sum(pp.total_amount),0::numeric) AS total_purchases
  FROM commerce.partner_purchases pp
  WHERE pp.environment=pu.environment AND pp.unit_id=pu.unit_id
    AND pp.purchased_at>=mb.month_start_at AND pp.deleted_at IS NULL
) purchases_month ON true
LEFT JOIN LATERAL (
  SELECT COALESCE(sum(pe.amount),0::numeric) AS total_expenses
  FROM finance.partner_expenses pe
  WHERE pe.environment=pu.environment AND pe.unit_id=pu.unit_id
    AND pe.expense_date>=mb.month_start_date AND pe.deleted_at IS NULL
) expenses_month ON true
LEFT JOIN LATERAL (
  SELECT
    COALESCE((SELECT sum(po.total_amount) FROM commerce.partner_orders po
      WHERE po.environment=pu.environment AND po.unit_id=pu.unit_id
        AND po.status<>'cancelled' AND po.deleted_at IS NULL
        AND po.created_at>=mb.month_start_at
        AND (po.payment_method IS NULL OR po.payment_method<>'A receber')),0::numeric)
    + COALESCE((SELECT sum(pre.amount) FROM finance.partner_receivables_effective pre
      WHERE pre.environment=pu.environment AND pre.unit_id=pu.unit_id
        AND pre.status='received' AND pre.received_at>=mb.month_start_at),0::numeric) AS total
) cash_in_month ON true
LEFT JOIN LATERAL (
  SELECT
    COALESCE((SELECT sum(pp.total_amount) FROM commerce.partner_purchases pp
      WHERE pp.environment=pu.environment AND pp.unit_id=pu.unit_id
        AND pp.deleted_at IS NULL AND pp.purchased_at>=mb.month_start_at
        AND pp.payment_status='paid_now'),0::numeric)
    + COALESCE((SELECT sum(pe.amount) FROM finance.partner_expenses pe
      WHERE pe.environment=pu.environment AND pe.unit_id=pu.unit_id
        AND pe.deleted_at IS NULL AND pe.expense_date>=mb.month_start_date
        AND pe.source_payable_id IS NULL),0::numeric)
    + COALESCE((SELECT sum(pp2.amount) FROM finance.partner_payables pp2
      WHERE pp2.environment=pu.environment AND pp2.unit_id=pu.unit_id
        AND pp2.deleted_at IS NULL AND pp2.status='paid'
        AND pp2.paid_at>=mb.month_start_at),0::numeric) AS total
) cash_out_month ON true
LEFT JOIN LATERAL (
  SELECT COALESCE(sum(pre.amount),0::numeric) AS total
  FROM finance.partner_receivables_effective pre
  WHERE pre.environment=pu.environment AND pre.unit_id=pu.unit_id AND pre.status='open'
) open_recv ON true
LEFT JOIN LATERAL (
  SELECT COALESCE(sum(pp3.amount),0::numeric) AS total
  FROM finance.partner_payables pp3
  WHERE pp3.environment=pu.environment AND pp3.unit_id=pu.unit_id
    AND pp3.status='open' AND pp3.deleted_at IS NULL
) open_pay ON true
LEFT JOIN LATERAL (
  SELECT count(*)::integer AS stock_items,
         count(*) FILTER (WHERE ps.stock_status=ANY(ARRAY['low_stock','out_of_stock']))::integer
           AS low_stock_items
  FROM commerce.partner_stock_levels ps
  WHERE ps.environment=pu.environment AND ps.unit_id=pu.unit_id AND ps.deleted_at IS NULL
) stock_counts ON true
WHERE pu.deleted_at IS NULL;

COMMENT ON VIEW network.partner_unit_summary IS
  'Resumo parceiro com CMV histórico pelo snapshot do item. Resultado fica NULL quando há custo pendente; compras futuras não reprecificam vendas passadas.';
GRANT SELECT ON network.partner_unit_summary TO farejador_partner_app;

-- Expõe o estado do custo dentro dos itens sem abrir outra tabela/unidade via view.
CREATE OR REPLACE VIEW commerce.partner_orders_full
WITH (security_invoker = true) AS
SELECT
  po.id AS order_id,
  po.environment,
  po.unit_id,
  po.customer_name AS contact_name,
  po.customer_phone AS contact_phone,
  po.total_amount,
  po.status,
  po.payment_method,
  po.fulfillment_mode,
  po.delivery_address,
  po.source_tag,
  po.closed_by AS registered_by,
  po.closed_at,
  po.created_at,
  po.updated_at,
  COALESCE(jsonb_agg(jsonb_build_object(
    'item_name',poi.item_name,
    'tire_size',poi.tire_size,
    'brand',poi.brand,
    'quantity',poi.quantity,
    'unit_price',poi.unit_price,
    'discount_amount',poi.discount_amount,
    'partner_stock_id',poi.partner_stock_id,
    'unit_cost_snapshot',poi.unit_cost_snapshot,
    'cost_status',poi.cost_status
  ) ORDER BY poi.created_at) FILTER (WHERE poi.id IS NOT NULL),'[]'::jsonb) AS items,
  po.notes,
  po.received_amount,
  po.customer_cpf,
  po.customer_id,
  po.delivery_status,
  po.delivery_courier,
  po.dispatched_at,
  po.delivered_at,
  po.awaiting_pickup,
  po.retrieved_at
FROM commerce.partner_orders po
LEFT JOIN commerce.partner_order_items poi
  ON poi.order_id=po.id AND poi.environment=po.environment
WHERE po.deleted_at IS NULL
GROUP BY po.id;

COMMENT ON VIEW commerce.partner_orders_full IS
  'Pedidos parceiros com itens e snapshot de custo. security_invoker obrigatório para respeitar RLS da unidade.';
GRANT SELECT ON commerce.partner_orders_full TO farejador_partner_app;

-- Defesa física: o parceiro opera venda, mas não pode reescrever o custo depois.
-- UPDATE de tabela (0044) tornaria ineficaz revogar somente quatro colunas.
-- Nenhum fluxo normal atualiza o item depois que a venda foi criada.
REVOKE UPDATE ON commerce.partner_order_items FROM farejador_partner_app;

DO $verify$
DECLARE
  v_summary_options TEXT[];
  v_orders_options TEXT[];
BEGIN
  SELECT reloptions INTO v_summary_options
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='network' AND c.relname='partner_unit_summary';
  SELECT reloptions INTO v_orders_options
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='commerce' AND c.relname='partner_orders_full';
  IF NOT ('security_invoker=true'=ANY(COALESCE(v_summary_options,ARRAY[]::text[])))
     OR NOT ('security_invoker=true'=ANY(COALESCE(v_orders_options,ARRAY[]::text[]))) THEN
    RAISE EXCEPTION 'stage6_security_invoker_not_preserved';
  END IF;
  IF has_table_privilege('farejador_partner_app',
       'commerce.partner_order_items','UPDATE') THEN
    RAISE EXCEPTION 'stage6_partner_can_update_cost_snapshot';
  END IF;
END
$verify$;

-- Rollback manual (somente antes de existirem vendas novas com snapshot):
-- DROP TRIGGER partner_order_item_cost_snapshot_immutable ON commerce.partner_order_items;
-- DROP FUNCTION commerce.guard_partner_order_item_cost_snapshot();
-- ALTER TABLE commerce.partner_order_items DROP COLUMN cost_source,
--   DROP COLUMN cost_captured_at, DROP COLUMN cost_status, DROP COLUMN unit_cost_snapshot;
