-- 0090 — Etapa 2 da retirada da Rede: "marcar retirado", origem imutável (anti-trapaça 2w)
-- e realização da venda só na retirada.
--
-- Decisão Wallace 2026-06-07. Depende de 0089 (reserva na retirada).
--
-- 1) Marcadores aditivos na partner_orders:
--    - awaiting_pickup: a retirada reservada do bot está SEGURADA, esperando o cliente.
--      Enquanto true, NÃO é venda realizada (igual entrega não-entregue).
--    - retrieved_at: quando o cliente retira (data de realização da venda da retirada).
-- 2) Trava de imutabilidade da ORIGEM (source_tag): depois de criada, ninguém altera.
--    É o "ele não consegue alterar" do diferencial 2w — anti-trapaça à prova de bala.
-- 3) complete_partner_pickup(): converte RESERVA → baixa física (irmã de
--    deliver_partner_local_order, mas para a retirada reservada).
-- 4) network.partner_unit_summary: a retirada AGUARDANDO não conta como venda; quando
--    retirada, conta na data da retirada (retrieved_at). Balcão e entrega: intactos.

-- ── 1) Marcadores ───────────────────────────────────────────────────────────
ALTER TABLE commerce.partner_orders
  ADD COLUMN IF NOT EXISTS awaiting_pickup boolean NOT NULL DEFAULT false;
ALTER TABLE commerce.partner_orders
  ADD COLUMN IF NOT EXISTS retrieved_at timestamptz;

COMMENT ON COLUMN commerce.partner_orders.awaiting_pickup IS
  'Retirada reservada do bot aguardando o cliente. true = pneu segurado, NÃO é venda realizada ainda.';
COMMENT ON COLUMN commerce.partner_orders.retrieved_at IS
  'Quando o cliente retirou (marcar retirado). Data de realização da venda na retirada reservada.';

-- ── 2) Origem imutável (anti-trapaça 2w) ────────────────────────────────────
CREATE OR REPLACE FUNCTION commerce.enforce_partner_order_source_immutable()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF NEW.source_tag IS DISTINCT FROM OLD.source_tag THEN
    RAISE EXCEPTION 'origem do pedido (source_tag) e imutavel apos criada: % -> %',
      OLD.source_tag, NEW.source_tag
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS partner_orders_source_immutable ON commerce.partner_orders;
CREATE TRIGGER partner_orders_source_immutable
  BEFORE UPDATE OF source_tag ON commerce.partner_orders
  FOR EACH ROW EXECUTE FUNCTION commerce.enforce_partner_order_source_immutable();

-- ── 3) Completar a retirada (reserva → baixa física) ────────────────────────
CREATE OR REPLACE FUNCTION commerce.complete_partner_pickup(p_order_id uuid, p_actor_label text)
RETURNS void LANGUAGE plpgsql AS $function$
DECLARE
  v_environment TEXT;
  v_unit_id     UUID;
  v_fulfillment TEXT;
  v_status      TEXT;
  v_awaiting    BOOLEAN;
  v_item        RECORD;
  v_stock       RECORD;
BEGIN
  SELECT environment, unit_id, fulfillment_mode, status, awaiting_pickup
    INTO v_environment, v_unit_id, v_fulfillment, v_status, v_awaiting
  FROM commerce.partner_orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF v_environment IS NULL THEN
    RAISE EXCEPTION 'Pedido nao encontrado: %', p_order_id;
  END IF;
  IF v_fulfillment <> 'pickup' THEN
    RAISE EXCEPTION 'complete_partner_pickup so vale para pickup (pedido %)', p_order_id;
  END IF;
  IF v_status = 'cancelled' THEN
    RAISE EXCEPTION 'Pedido cancelado nao pode ser retirado: %', p_order_id;
  END IF;
  -- Idempotência por estado: só baixa na transição de "aguardando" para retirado.
  IF NOT v_awaiting THEN
    RAISE EXCEPTION 'Retirada ja finalizada (ou nao era reservada): %', p_order_id
      USING ERRCODE = '23514';
  END IF;

  FOR v_item IN
    SELECT partner_stock_id, quantity
    FROM commerce.partner_order_items
    WHERE order_id = p_order_id AND environment = v_environment
  LOOP
    IF v_item.partner_stock_id IS NOT NULL THEN
      SELECT id, item_name, quantity_on_hand, quantity_reserved, minimum_quantity, is_tracked
        INTO v_stock
      FROM commerce.partner_stock_levels
      WHERE id = v_item.partner_stock_id
        AND environment = v_environment
        AND unit_id = v_unit_id
        AND deleted_at IS NULL
      FOR UPDATE;

      -- Item que não reservou na criação (não rastreado / saldo unknown): pula sem erro.
      IF FOUND AND v_stock.is_tracked AND v_stock.quantity_on_hand IS NOT NULL THEN
        IF COALESCE(v_stock.quantity_reserved, 0) < v_item.quantity THEN
          RAISE EXCEPTION
            'Reserva insuficiente na retirada de "%": reservado %, item %',
            v_stock.item_name, COALESCE(v_stock.quantity_reserved, 0), v_item.quantity
            USING ERRCODE = '23514';
        END IF;

        UPDATE commerce.partner_stock_levels
        SET quantity_on_hand  = quantity_on_hand - v_item.quantity,
            quantity_reserved = quantity_reserved - v_item.quantity,
            stock_status = commerce.partner_stock_status(
              quantity_on_hand - v_item.quantity,
              quantity_reserved - v_item.quantity,
              minimum_quantity, is_tracked),
            updated_at = now(), updated_by = p_actor_label
        WHERE id = v_item.partner_stock_id;

        INSERT INTO audit.events (
          environment, domain, entity_table, entity_id, event_type,
          actor_label, payload_after
        ) VALUES (
          v_environment, 'stock', 'commerce.partner_stock_levels', v_item.partner_stock_id,
          'stock_decrement_sale', p_actor_label,
          jsonb_build_object('order_id', p_order_id, 'quantity', v_item.quantity,
                             'context', 'pickup_retrieved')
        );
      END IF;
    END IF;
  END LOOP;
END;
$function$;

-- ── 4) View do resumo: retirada conta só quando retirada ─────────────────────
CREATE OR REPLACE VIEW network.partner_unit_summary
WITH (security_invoker = true) AS
 WITH month_bounds AS (
         SELECT (date_trunc('month'::text, (now() AT TIME ZONE 'America/Sao_Paulo'::text)) AT TIME ZONE 'America/Sao_Paulo'::text) AS month_start_at,
            date_trunc('month'::text, (now() AT TIME ZONE 'America/Sao_Paulo'::text))::date AS month_start_date
        )
 SELECT pu.environment,
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
    COALESCE(orders_month.total_sales, 0::numeric) - COALESCE(cogs_month.total, 0::numeric) - COALESCE(expenses_month.total_expenses, 0::numeric) AS result_competencia_month,
    COALESCE(orders_month.total_sales, 0::numeric) - COALESCE(cogs_month.total, 0::numeric) - COALESCE(expenses_month.total_expenses, 0::numeric) AS estimated_result_month,
    COALESCE(cash_in_month.total, 0::numeric) AS cash_in_month,
    COALESCE(cash_out_month.total, 0::numeric) AS cash_out_month,
    COALESCE(cash_in_month.total, 0::numeric) - COALESCE(cash_out_month.total, 0::numeric) AS cash_net_month,
    COALESCE(open_recv.total, 0::numeric) AS open_receivables_total,
    COALESCE(open_pay.total, 0::numeric) AS open_payables_total,
    COALESCE(open_recv.total, 0::numeric) - COALESCE(open_pay.total, 0::numeric) AS net_future_position,
    COALESCE(stock_counts.stock_items, 0) AS stock_items,
    COALESCE(stock_counts.low_stock_items, 0) AS low_stock_items,
    COALESCE(cogs_month.total, 0::numeric) AS cogs_month
   FROM network.partner_units pu
     JOIN network.partners p ON p.id = pu.partner_id AND p.environment::text = pu.environment::text
     CROSS JOIN month_bounds mb
     LEFT JOIN LATERAL (
       SELECT count(*)::integer AS order_count,
              COALESCE(sum(po.total_amount), 0::numeric) AS total_sales
       FROM commerce.partner_orders po
       WHERE po.environment::text = pu.environment::text
         AND po.unit_id = pu.unit_id
         AND po.status <> 'cancelled'::text
         AND po.deleted_at IS NULL
         AND NOT (po.fulfillment_mode = 'delivery'::text AND po.delivery_status <> 'delivered'::text)
         AND NOT po.awaiting_pickup
         AND (
           CASE
             WHEN po.fulfillment_mode = 'delivery'::text THEN po.delivered_at
             ELSE COALESCE(po.retrieved_at, po.created_at)
           END
         ) >= mb.month_start_at
     ) orders_month ON true
     LEFT JOIN LATERAL (
       SELECT COALESCE(sum(oi.quantity::numeric * COALESCE(ps.average_cost, 0::numeric)), 0::numeric) AS total
       FROM commerce.partner_orders po_c
         JOIN commerce.partner_order_items oi ON oi.order_id = po_c.id AND oi.environment::text = po_c.environment::text
         LEFT JOIN commerce.partner_stock_levels ps ON ps.id = oi.partner_stock_id
       WHERE po_c.environment::text = pu.environment::text
         AND po_c.unit_id = pu.unit_id
         AND po_c.status <> 'cancelled'::text
         AND po_c.deleted_at IS NULL
         AND NOT (po_c.fulfillment_mode = 'delivery'::text AND po_c.delivery_status <> 'delivered'::text)
         AND NOT po_c.awaiting_pickup
         AND (
           CASE
             WHEN po_c.fulfillment_mode = 'delivery'::text THEN po_c.delivered_at
             ELSE COALESCE(po_c.retrieved_at, po_c.created_at)
           END
         ) >= mb.month_start_at
     ) cogs_month ON true
     LEFT JOIN LATERAL (
       SELECT COALESCE(sum(pp.total_amount), 0::numeric) AS total_purchases
       FROM commerce.partner_purchases pp
       WHERE pp.environment::text = pu.environment::text
         AND pp.unit_id = pu.unit_id
         AND pp.purchased_at >= mb.month_start_at
         AND pp.deleted_at IS NULL
     ) purchases_month ON true
     LEFT JOIN LATERAL (
       SELECT COALESCE(sum(pe.amount), 0::numeric) AS total_expenses
       FROM finance.partner_expenses pe
       WHERE pe.environment::text = pu.environment::text
         AND pe.unit_id = pu.unit_id
         AND pe.expense_date >= mb.month_start_date
         AND pe.deleted_at IS NULL
     ) expenses_month ON true
     LEFT JOIN LATERAL (
       SELECT COALESCE((
                SELECT sum(po.total_amount) AS sum
                FROM commerce.partner_orders po
                WHERE po.environment::text = pu.environment::text
                  AND po.unit_id = pu.unit_id
                  AND po.status <> 'cancelled'::text
                  AND po.deleted_at IS NULL
                  AND po.created_at >= mb.month_start_at
                  AND (po.payment_method IS NULL OR po.payment_method <> 'A receber'::text)
              ), 0::numeric)
              + COALESCE((
                SELECT sum(pre.amount) AS sum
                FROM finance.partner_receivables_effective pre
                WHERE pre.environment::text = pu.environment::text
                  AND pre.unit_id = pu.unit_id
                  AND pre.status = 'received'::text
                  AND pre.received_at >= mb.month_start_at
              ), 0::numeric) AS total
     ) cash_in_month ON true
     LEFT JOIN LATERAL (
       SELECT COALESCE((
                SELECT sum(pp.total_amount) AS sum
                FROM commerce.partner_purchases pp
                WHERE pp.environment::text = pu.environment::text
                  AND pp.unit_id = pu.unit_id
                  AND pp.deleted_at IS NULL
                  AND pp.purchased_at >= mb.month_start_at
                  AND pp.payment_status = 'paid_now'::text
              ), 0::numeric)
              + COALESCE((
                SELECT sum(pe.amount) AS sum
                FROM finance.partner_expenses pe
                WHERE pe.environment::text = pu.environment::text
                  AND pe.unit_id = pu.unit_id
                  AND pe.deleted_at IS NULL
                  AND pe.expense_date >= mb.month_start_date
                  AND pe.source_payable_id IS NULL
              ), 0::numeric)
              + COALESCE((
                SELECT sum(pp2.amount) AS sum
                FROM finance.partner_payables pp2
                WHERE pp2.environment::text = pu.environment::text
                  AND pp2.unit_id = pu.unit_id
                  AND pp2.deleted_at IS NULL
                  AND pp2.status = 'paid'::text
                  AND pp2.paid_at >= mb.month_start_at
              ), 0::numeric) AS total
     ) cash_out_month ON true
     LEFT JOIN LATERAL (
       SELECT COALESCE(sum(pre.amount), 0::numeric) AS total
       FROM finance.partner_receivables_effective pre
       WHERE pre.environment::text = pu.environment::text
         AND pre.unit_id = pu.unit_id
         AND pre.status = 'open'::text
     ) open_recv ON true
     LEFT JOIN LATERAL (
       SELECT COALESCE(sum(pp3.amount), 0::numeric) AS total
       FROM finance.partner_payables pp3
       WHERE pp3.environment::text = pu.environment::text
         AND pp3.unit_id = pu.unit_id
         AND pp3.status = 'open'::text
         AND pp3.deleted_at IS NULL
     ) open_pay ON true
     LEFT JOIN LATERAL (
       SELECT count(*)::integer AS stock_items,
              count(*) FILTER (WHERE ps.stock_status = ANY (ARRAY['low_stock'::text, 'out_of_stock'::text]))::integer AS low_stock_items
       FROM commerce.partner_stock_levels ps
       WHERE ps.environment::text = pu.environment::text
         AND ps.unit_id = pu.unit_id
         AND ps.deleted_at IS NULL
     ) stock_counts ON true
  WHERE pu.deleted_at IS NULL;

COMMENT ON VIEW network.partner_unit_summary IS
  'Resumo mensal por unidade parceira. 0077: delivery/COD entra pela data de entrega. 0090: retirada reservada (awaiting_pickup) NÃO conta até ser retirada; ao retirar, entra pela data retrieved_at. Balcão segue por created_at.';

GRANT SELECT ON network.partner_unit_summary TO farejador_partner_app;

-- ── 5) Cancelar: liberar RESERVA também na retirada reservada ────────────────
-- Antes, cancel só liberava reserva pra delivery (pending/dispatched); pickup caía no
-- ELSE que SOMA on_hand. A retirada reservada (awaiting_pickup) reservou e não baixou,
-- então cancelar tem que LIBERAR a reserva — não inflar o on_hand.
CREATE OR REPLACE FUNCTION commerce.cancel_partner_local_order(p_order_id uuid, p_actor_label text, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_environment     TEXT;
  v_unit_id         UUID;
  v_previous        TEXT;
  v_fulfillment     TEXT;
  v_delivery_status TEXT;
  v_awaiting_pickup BOOLEAN;
  v_release_reserve BOOLEAN;
  v_item            RECORD;
  v_receivable_id   UUID;
BEGIN
  SELECT environment, unit_id, status, fulfillment_mode, delivery_status, awaiting_pickup
    INTO v_environment, v_unit_id, v_previous, v_fulfillment, v_delivery_status, v_awaiting_pickup
  FROM commerce.partner_orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF v_previous IS NULL THEN
    RAISE EXCEPTION 'Venda nao encontrada: %', p_order_id;
  END IF;
  IF v_previous = 'cancelled' THEN
    RAISE EXCEPTION 'Venda ja cancelada: %', p_order_id;
  END IF;

  -- Libera RESERVA (em vez de restaurar on_hand) quando o estoque foi RESERVADO e não
  -- baixado: entrega ainda não entregue (pending/dispatched) OU retirada reservada do
  -- bot ainda aguardando (awaiting_pickup).
  v_release_reserve := (v_fulfillment = 'delivery'
                        AND v_delivery_status IN ('pending', 'dispatched'))
                       OR (v_fulfillment = 'pickup' AND COALESCE(v_awaiting_pickup, false));

  FOR v_item IN
    SELECT partner_stock_id, quantity
    FROM commerce.partner_order_items
    WHERE order_id = p_order_id AND environment = v_environment
  LOOP
    IF v_item.partner_stock_id IS NOT NULL THEN
      IF v_release_reserve THEN
        UPDATE commerce.partner_stock_levels
        SET quantity_reserved = GREATEST(COALESCE(quantity_reserved, 0) - v_item.quantity, 0),
            stock_status = commerce.partner_stock_status(
              quantity_on_hand,
              GREATEST(COALESCE(quantity_reserved, 0) - v_item.quantity, 0),
              minimum_quantity, is_tracked),
            updated_at = now(), updated_by = p_actor_label
        WHERE id = v_item.partner_stock_id
          AND environment = v_environment AND unit_id = v_unit_id
          AND deleted_at IS NULL AND is_tracked
          AND COALESCE(quantity_reserved, 0) > 0;

        IF FOUND THEN
          INSERT INTO audit.events (
            environment, domain, entity_table, entity_id, event_type,
            actor_label, payload_after
          ) VALUES (
            v_environment, 'stock', 'commerce.partner_stock_levels', v_item.partner_stock_id,
            'stock_reservation_released', p_actor_label,
            jsonb_build_object('order_id', p_order_id, 'quantity', v_item.quantity, 'reason', p_reason)
          );
        END IF;
      ELSE
        UPDATE commerce.partner_stock_levels
        SET quantity_on_hand = COALESCE(quantity_on_hand, 0) + v_item.quantity,
            stock_status = commerce.partner_stock_status(
              COALESCE(quantity_on_hand, 0) + v_item.quantity,
              COALESCE(quantity_reserved, 0),
              minimum_quantity, is_tracked),
            updated_at = now(), updated_by = p_actor_label
        WHERE id = v_item.partner_stock_id
          AND environment = v_environment AND unit_id = v_unit_id
          AND deleted_at IS NULL AND is_tracked;

        IF FOUND THEN
          INSERT INTO audit.events (
            environment, domain, entity_table, entity_id, event_type,
            actor_label, payload_after
          ) VALUES (
            v_environment, 'stock', 'commerce.partner_stock_levels', v_item.partner_stock_id,
            'stock_increment_sale_cancel', p_actor_label,
            jsonb_build_object('order_id', p_order_id, 'quantity', v_item.quantity, 'reason', p_reason)
          );
        END IF;
      END IF;
    END IF;
  END LOOP;

  UPDATE commerce.partner_orders
  SET status = 'cancelled', updated_at = now()
  WHERE id = p_order_id;

  UPDATE finance.partner_receivables
  SET status = 'cancelled', deleted_at = now(), deleted_by = p_actor_label
  WHERE source_order_id = p_order_id
    AND environment = v_environment AND unit_id = v_unit_id
    AND status IN ('open', 'received') AND deleted_at IS NULL
  RETURNING id INTO v_receivable_id;

  IF v_receivable_id IS NOT NULL THEN
    INSERT INTO audit.events (
      environment, domain, entity_table, entity_id, event_type,
      actor_label, payload_after
    ) VALUES (
      v_environment, 'partner_finance', 'finance.partner_receivables', v_receivable_id,
      'partner_receivable_cancelled_by_sale_cancel', p_actor_label,
      jsonb_build_object('source_order_id', p_order_id, 'reason', p_reason)
    );
  END IF;

  INSERT INTO audit.events (
    environment, domain, entity_table, entity_id, event_type,
    actor_label, payload_after
  ) VALUES (
    v_environment, 'partner_orders', 'commerce.partner_orders', p_order_id,
    'partner_order_cancelled', p_actor_label,
    jsonb_build_object('reason', p_reason, 'previous_status', v_previous,
                       'cancelled_receivable_id', v_receivable_id)
  );
END;
$function$;

-- ── 6) View dos pedidos expõe awaiting_pickup/retrieved_at (front + métricas) ──
-- Append no fim (CREATE OR REPLACE só permite acrescentar colunas). Necessário pra
-- o painel renderizar o card de retirada e pro filtro de venda realizada do chat.
CREATE OR REPLACE VIEW commerce.partner_orders_full AS
 SELECT po.id AS order_id,
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
    COALESCE(jsonb_agg(jsonb_build_object('item_name', poi.item_name, 'tire_size', poi.tire_size, 'brand', poi.brand, 'quantity', poi.quantity, 'unit_price', poi.unit_price, 'discount_amount', poi.discount_amount, 'partner_stock_id', poi.partner_stock_id) ORDER BY poi.created_at) FILTER (WHERE poi.id IS NOT NULL), '[]'::jsonb) AS items,
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
     LEFT JOIN commerce.partner_order_items poi ON poi.order_id = po.id AND poi.environment::text = po.environment::text
  WHERE po.deleted_at IS NULL
  GROUP BY po.id;
