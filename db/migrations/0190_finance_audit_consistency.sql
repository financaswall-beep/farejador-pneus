-- 0190 - Consistencia financeira ponta a ponta (auditoria 2026-08-20).
--
-- 1. A carga Matriz -> parceiro reconhece receita, CMV e comissao somente no
--    acerto da chegada, pela quantidade efetivamente aceita.
-- 2. O monitor da Etapa 3 entende os source_types de chegada sem duplicar o
--    fato economico legado.
-- 3. O caixa mensal do parceiro usa a data de realizacao (entrega/retirada),
--    nunca a simples criacao de um pedido ainda pendente.

ALTER TABLE commerce.wholesale_orders
  ADD COLUMN IF NOT EXISTS partner_settled_at TIMESTAMPTZ;

UPDATE commerce.wholesale_orders o
   SET partner_settled_at=COALESCE(
     (SELECT min(a.created_at)
        FROM audit.events a
       WHERE a.environment=o.environment AND a.entity_id=o.id
         AND a.event_type='arrival_settled'),
     (SELECT min(t.competence_on)::timestamp
               AT TIME ZONE 'America/Sao_Paulo'
        FROM finance.matriz_ledger_transactions t
       WHERE t.environment=o.environment AND t.source_id=o.id::text
         AND t.source_type='commerce.wholesale_order.arrival_revenue'),
     o.paid_at,
     o.sold_at
   )
 WHERE o.partner_transfer_status IN ('settled','received')
   AND o.partner_settled_at IS NULL;

ALTER TABLE commerce.wholesale_orders
  DROP CONSTRAINT IF EXISTS wholesale_orders_partner_settlement_date_check;
ALTER TABLE commerce.wholesale_orders
  ADD CONSTRAINT wholesale_orders_partner_settlement_date_check CHECK (
    (partner_transfer_status IS NULL AND partner_settled_at IS NULL)
    OR (partner_transfer_status='in_transit' AND partner_settled_at IS NULL)
    OR (partner_transfer_status IN ('settled','received')
      AND partner_settled_at IS NOT NULL)
  );

COMMENT ON COLUMN commerce.wholesale_orders.partner_settled_at IS
  'Instante em que a Matriz concluiu o acerto da carga; competencia da venda ao parceiro.';

CREATE OR REPLACE FUNCTION commerce.guard_matrix_partner_arrival_order()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,commerce,network
AS $$
DECLARE
  v_arrival_allowed BOOLEAN :=
    COALESCE(current_setting('app.matrix_partner_arrival',true),'')='on'
    AND session_user<>'farejador_partner_app';
  v_partner_receipt_allowed BOOLEAN := false;
BEGIN
  IF OLD.partner_unit_id IS NULL AND NEW.partner_unit_id IS NULL THEN RETURN NEW; END IF;

  IF session_user='farejador_partner_app'
     AND COALESCE(current_setting('app.partner_unit_id',true),'')=NEW.partner_unit_id::text
     AND OLD.partner_transfer_status='settled'
     AND NEW.partner_transfer_status='received'
     AND ROW(
       NEW.partner_unit_id,NEW.settled_total_amount,NEW.partner_settled_at,NEW.status,
       NEW.payment_status,NEW.paid_at,NEW.partner_payment_terms
     ) IS NOT DISTINCT FROM ROW(
       OLD.partner_unit_id,OLD.settled_total_amount,OLD.partner_settled_at,OLD.status,
       OLD.payment_status,OLD.paid_at,OLD.partner_payment_terms
     )
     AND EXISTS (
       SELECT 1
         FROM commerce.partner_purchases purchase
         JOIN network.partner_units partner_unit
           ON partner_unit.environment=purchase.environment
          AND partner_unit.unit_id=purchase.unit_id
        WHERE purchase.environment=NEW.environment
          AND purchase.source_wholesale_order_id=NEW.id
          AND purchase.receipt_status='received'
          AND purchase.deleted_at IS NULL
          AND partner_unit.id=NEW.partner_unit_id
          AND partner_unit.status='active'
          AND partner_unit.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1
              FROM commerce.partner_purchase_items item
             WHERE item.environment=purchase.environment
               AND item.purchase_id=purchase.id
               AND item.received_quantity IS DISTINCT FROM item.confirmed_quantity
          )
     ) THEN
    v_partner_receipt_allowed := true;
  END IF;

  IF NEW.partner_payment_terms IS DISTINCT FROM OLD.partner_payment_terms THEN
    RAISE EXCEPTION 'matrix_partner_payment_terms_immutable' USING ERRCODE='23514';
  END IF;
  IF ROW(NEW.partner_unit_id,NEW.partner_transfer_status,
         NEW.settled_total_amount,NEW.partner_settled_at)
     IS DISTINCT FROM
     ROW(OLD.partner_unit_id,OLD.partner_transfer_status,
         OLD.settled_total_amount,OLD.partner_settled_at)
     AND NOT (v_arrival_allowed OR v_partner_receipt_allowed) THEN
    RAISE EXCEPTION 'matrix_partner_arrival_operation_required' USING ERRCODE='23514';
  END IF;
  IF OLD.partner_transfer_status='in_transit'
     AND ROW(NEW.status,NEW.payment_status,NEW.paid_at)
       IS DISTINCT FROM ROW(OLD.status,OLD.payment_status,OLD.paid_at)
     AND NOT v_arrival_allowed THEN
    RAISE EXCEPTION 'matrix_partner_arrival_operation_required' USING ERRCODE='23514';
  END IF;
  IF OLD.partner_transfer_status IS DISTINCT FROM NEW.partner_transfer_status
     AND NOT (
       (OLD.partner_transfer_status='in_transit' AND NEW.partner_transfer_status='settled')
       OR (OLD.partner_transfer_status='settled' AND NEW.partner_transfer_status='received')
     ) THEN
    RAISE EXCEPTION 'matrix_partner_transfer_transition_invalid:%:%',
      OLD.partner_transfer_status,NEW.partner_transfer_status USING ERRCODE='23514';
  END IF;
  IF OLD.partner_transfer_status='in_transit'
     AND NEW.partner_transfer_status='settled'
     AND NOT (OLD.status='pending' AND NEW.status='confirmed') THEN
    RAISE EXCEPTION 'matrix_partner_sale_confirmation_required' USING ERRCODE='23514';
  END IF;
  IF NEW.partner_transfer_status IN ('settled','received')
     AND NEW.partner_settled_at IS NULL THEN
    RAISE EXCEPTION 'matrix_partner_settlement_date_required' USING ERRCODE='23514';
  END IF;
  IF NEW.partner_transfer_status IN ('settled','received') AND EXISTS (
    SELECT 1 FROM commerce.wholesale_order_items item
     WHERE item.environment=NEW.environment AND item.order_id=NEW.id
       AND item.accepted_quantity IS NULL
  ) THEN
    RAISE EXCEPTION 'matrix_partner_arrival_unconfirmed_item' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS matrix_partner_arrival_order_guard
  ON commerce.wholesale_orders;
CREATE TRIGGER matrix_partner_arrival_order_guard
  BEFORE UPDATE OF partner_unit_id,partner_transfer_status,settled_total_amount,
    partner_settled_at,status,payment_status,paid_at,partner_payment_terms
  ON commerce.wholesale_orders
  FOR EACH ROW EXECUTE FUNCTION commerce.guard_matrix_partner_arrival_order();

DO $rename$
BEGIN
  IF to_regprocedure('finance.matriz_stage3_ledger_reconciliation_v0150(env_t)')
       IS NULL THEN
    ALTER FUNCTION finance.matriz_stage3_ledger_reconciliation(env_t)
      RENAME TO matriz_stage3_ledger_reconciliation_v0150;
  END IF;
END
$rename$;

CREATE OR REPLACE FUNCTION finance.matriz_stage3_ledger_reconciliation(
  p_environment env_t
) RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog,finance,commerce,core,audit
AS $fn$
  SELECT (
    finance.matriz_stage3_ledger_reconciliation_v0150(p_environment)
      - 'wholesale_revenue_missing'
      - 'wholesale_cogs_missing'
      - 'wholesale_payment_missing'
      - 'retail_revenue_missing'
      - 'retail_cancel_missing'
  ) || jsonb_build_object(
    'wholesale_revenue_missing',(
      SELECT count(*) FROM commerce.wholesale_orders o
       WHERE o.environment=p_environment AND o.total_amount>0
         AND (o.partner_transfer_status IS NULL
           OR o.partner_transfer_status IN ('settled','received'))
         AND NOT EXISTS (
           SELECT 1 FROM finance.matriz_ledger_transactions t
            WHERE t.environment=o.environment AND t.source_id=o.id::text
              AND (
                (o.partner_transfer_status IS NULL
                  AND t.source_type='commerce.wholesale_order.revenue')
                OR (o.partner_transfer_status IN ('settled','received')
                  AND t.source_type IN ('commerce.wholesale_order.revenue',
                    'commerce.wholesale_order.arrival_revenue'))
              )
         )
    ),
    'wholesale_cogs_missing',(
      SELECT count(*) FROM commerce.wholesale_orders o
       WHERE o.environment=p_environment
         AND (o.partner_transfer_status IS NULL
           OR o.partner_transfer_status IN ('settled','received'))
         AND EXISTS (
           SELECT 1 FROM commerce.wholesale_order_items i
            WHERE i.environment=o.environment AND i.order_id=o.id
            GROUP BY i.order_id HAVING sum((CASE
              WHEN o.partner_transfer_status IN ('settled','received')
                THEN COALESCE(i.accepted_quantity,0) ELSE i.quantity END)
              *i.unit_cost)>0
         )
         AND NOT EXISTS (
           SELECT 1 FROM finance.matriz_ledger_transactions t
            WHERE t.environment=o.environment AND t.source_id=o.id::text
              AND (
                (o.partner_transfer_status IS NULL
                  AND t.source_type='commerce.wholesale_order.cogs')
                OR (o.partner_transfer_status IN ('settled','received')
                  AND t.source_type IN ('commerce.wholesale_order.cogs',
                    'commerce.wholesale_order.arrival_cogs'))
              )
         )
    ),
    'wholesale_payment_missing',(
      SELECT count(*) FROM commerce.wholesale_orders o
       WHERE o.environment=p_environment AND o.payment_status='paid'
         AND (o.partner_transfer_status IS NULL
           OR o.partner_transfer_status IN ('settled','received'))
         AND EXISTS (
           SELECT 1 FROM finance.matriz_ledger_transactions t
            WHERE t.environment=o.environment AND t.source_id=o.id::text
              AND t.source_type IN ('commerce.wholesale_order.revenue',
                'commerce.wholesale_order.arrival_revenue')
              AND t.transaction_kind='sale_receivable'
         )
         AND NOT EXISTS (
           SELECT 1 FROM finance.matriz_ledger_transactions t
            WHERE t.environment=o.environment
              AND t.source_type='commerce.wholesale_order.payment'
              AND t.source_id=o.id::text
         )
    ),
    'wholesale_recognition_duplicate',(
      SELECT count(*) FROM commerce.wholesale_orders o
       WHERE o.environment=p_environment
         AND o.partner_transfer_status IN ('settled','received')
         AND (
           (EXISTS (SELECT 1 FROM finance.matriz_ledger_transactions t
             WHERE t.environment=o.environment AND t.source_id=o.id::text
               AND t.source_type='commerce.wholesale_order.revenue')
            AND EXISTS (SELECT 1 FROM finance.matriz_ledger_transactions t
             WHERE t.environment=o.environment AND t.source_id=o.id::text
               AND t.source_type='commerce.wholesale_order.arrival_revenue'))
           OR
           (EXISTS (SELECT 1 FROM finance.matriz_ledger_transactions t
             WHERE t.environment=o.environment AND t.source_id=o.id::text
               AND t.source_type='commerce.wholesale_order.cogs')
            AND EXISTS (SELECT 1 FROM finance.matriz_ledger_transactions t
             WHERE t.environment=o.environment AND t.source_id=o.id::text
               AND t.source_type='commerce.wholesale_order.arrival_cogs'))
         )
    ),
    'wholesale_dispatch_missing',(
      SELECT count(*) FROM commerce.wholesale_orders o
       WHERE o.environment=p_environment AND o.partner_transfer_status IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM commerce.wholesale_order_items i
            WHERE i.environment=o.environment AND i.order_id=o.id
            GROUP BY i.order_id HAVING sum(i.quantity*i.unit_cost)>0
         )
         AND NOT EXISTS (
           SELECT 1 FROM finance.matriz_ledger_transactions legacy
            WHERE legacy.environment=o.environment AND legacy.source_id=o.id::text
              AND legacy.source_type='commerce.wholesale_order.cogs'
         )
         AND NOT EXISTS (
           SELECT 1 FROM finance.matriz_ledger_transactions dispatch
            WHERE dispatch.environment=o.environment AND dispatch.source_id=o.id::text
              AND dispatch.source_type='commerce.wholesale_order.partner_dispatch'
         )
    ),
    'retail_revenue_missing',(
      SELECT count(*) FROM commerce.orders o
      JOIN core.units u
        ON u.environment=o.environment AND u.id=o.unit_id AND u.slug='main'
       WHERE o.environment=p_environment AND o.partner_order_id IS NULL
         AND o.total_amount>0
         AND o.status IN ('confirmed','paid','delivered','cancelled')
         AND (o.status<>'cancelled'
           OR EXISTS (SELECT 1 FROM audit.events a
             WHERE a.environment=o.environment AND a.entity_id=o.id
               AND a.event_type='matriz_galpao_decrement')
           OR EXISTS (SELECT 1 FROM finance.matriz_ledger_transactions t
             WHERE t.environment=o.environment AND t.source_id=o.id::text
               AND t.source_type IN ('commerce.order.revenue','commerce.order.cogs'))
           OR EXISTS (SELECT 1 FROM commerce.order_items i
             WHERE i.environment=o.environment AND i.order_id=o.id
               AND i.matriz_unit_cost IS NOT NULL))
         AND NOT EXISTS (
           SELECT 1 FROM finance.matriz_ledger_transactions t
            WHERE t.environment=o.environment
              AND t.source_type='commerce.order.revenue'
              AND t.source_id=o.id::text)
    ),
    'retail_cancel_missing',(
      SELECT count(*) FROM commerce.orders o
      JOIN core.units u
        ON u.environment=o.environment AND u.id=o.unit_id AND u.slug='main'
       WHERE o.environment=p_environment AND o.partner_order_id IS NULL
         AND o.status='cancelled'
         AND EXISTS (
           SELECT 1 FROM finance.matriz_ledger_transactions original
            WHERE original.environment=o.environment
              AND original.source_type='commerce.order.revenue'
              AND original.source_id=o.id::text)
         AND NOT EXISTS (
           SELECT 1 FROM finance.matriz_ledger_transactions reversal
            WHERE reversal.environment=o.environment
              AND reversal.source_type='commerce.order.revenue_cancel'
              AND reversal.source_id=o.id::text)
    )
  );
$fn$;

CREATE OR REPLACE FUNCTION finance.matriz_stage3_ledger_amount_mismatches(
  p_environment env_t
) RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog,finance,commerce,core,audit
AS $fn$
  WITH expected(source_type,source_id,amount) AS (
    SELECT 'commerce.wholesale_purchase.accrual',p.id::text,p.total_amount
      FROM commerce.wholesale_purchases p
     WHERE p.environment=p_environment AND p.total_amount>0
    UNION ALL
    SELECT CASE
             WHEN o.partner_transfer_status IN ('settled','received')
              AND EXISTS (SELECT 1 FROM finance.matriz_ledger_transactions t
                WHERE t.environment=o.environment AND t.source_id=o.id::text
                  AND t.source_type='commerce.wholesale_order.arrival_revenue')
               THEN 'commerce.wholesale_order.arrival_revenue'
             ELSE 'commerce.wholesale_order.revenue' END,
           o.id::text,COALESCE(o.settled_total_amount,o.total_amount)
      FROM commerce.wholesale_orders o
     WHERE o.environment=p_environment AND o.total_amount>0
       AND (o.partner_transfer_status IS NULL
         OR o.partner_transfer_status IN ('settled','received'))
    UNION ALL
    SELECT CASE
             WHEN o.partner_transfer_status IN ('settled','received')
              AND EXISTS (SELECT 1 FROM finance.matriz_ledger_transactions t
                WHERE t.environment=o.environment AND t.source_id=o.id::text
                  AND t.source_type='commerce.wholesale_order.arrival_cogs')
               THEN 'commerce.wholesale_order.arrival_cogs'
             ELSE 'commerce.wholesale_order.cogs' END,
           o.id::text,
           sum((CASE WHEN o.partner_transfer_status IN ('settled','received')
             THEN COALESCE(i.accepted_quantity,0) ELSE i.quantity END)*i.unit_cost)::numeric
      FROM commerce.wholesale_orders o
      JOIN commerce.wholesale_order_items i
        ON i.environment=o.environment AND i.order_id=o.id
     WHERE o.environment=p_environment
       AND (o.partner_transfer_status IS NULL
         OR o.partner_transfer_status IN ('settled','received'))
     GROUP BY o.id HAVING sum((CASE
       WHEN o.partner_transfer_status IN ('settled','received')
         THEN COALESCE(i.accepted_quantity,0) ELSE i.quantity END)*i.unit_cost)>0
    UNION ALL
    SELECT 'commerce.wholesale_order.partner_dispatch',o.id::text,
           sum(i.quantity*i.unit_cost)::numeric
      FROM commerce.wholesale_orders o
      JOIN commerce.wholesale_order_items i
        ON i.environment=o.environment AND i.order_id=o.id
     WHERE o.environment=p_environment AND o.partner_transfer_status IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM finance.matriz_ledger_transactions legacy
          WHERE legacy.environment=o.environment AND legacy.source_id=o.id::text
            AND legacy.source_type='commerce.wholesale_order.cogs')
     GROUP BY o.id HAVING sum(i.quantity*i.unit_cost)>0
    UNION ALL
    SELECT 'commerce.order.revenue',o.id::text,o.total_amount
      FROM commerce.orders o
      JOIN core.units u
        ON u.environment=o.environment AND u.id=o.unit_id AND u.slug='main'
     WHERE o.environment=p_environment AND o.partner_order_id IS NULL
       AND o.total_amount>0 AND o.status IN ('confirmed','paid','delivered','cancelled')
    UNION ALL
    SELECT 'commerce.order.cogs',o.id::text,
           COALESCE(sum(i.quantity*i.matriz_unit_cost)
             FILTER (WHERE i.matriz_unit_cost IS NOT NULL),0)::numeric
      FROM commerce.orders o
      JOIN core.units u
        ON u.environment=o.environment AND u.id=o.unit_id AND u.slug='main'
      JOIN commerce.order_items i
        ON i.environment=o.environment AND i.order_id=o.id
     WHERE o.environment=p_environment AND o.partner_order_id IS NULL
       AND EXISTS (
         SELECT 1 FROM audit.events a
          WHERE a.environment=o.environment AND a.entity_id=o.id
            AND a.event_type='matriz_galpao_decrement')
     GROUP BY o.id
    HAVING COALESCE(sum(i.quantity*i.matriz_unit_cost)
      FILTER (WHERE i.matriz_unit_cost IS NOT NULL),0)>0
    UNION ALL
    SELECT 'finance.inventory_adjustment',a.id::text,a.amount
      FROM finance.matriz_inventory_adjustments a
     WHERE a.environment=p_environment
  )
  SELECT count(*)
    FROM expected e
    JOIN finance.matriz_ledger_transactions t
      ON t.environment=p_environment
     AND t.source_type=e.source_type AND t.source_id=e.source_id
   WHERE abs(t.amount-e.amount)>0.009;
$fn$;

REVOKE ALL ON FUNCTION
  finance.matriz_stage3_ledger_reconciliation_v0150(env_t) FROM PUBLIC;
REVOKE ALL ON FUNCTION
  finance.matriz_stage3_ledger_reconciliation(env_t) FROM PUBLIC;
REVOKE ALL ON FUNCTION
  finance.matriz_stage3_ledger_amount_mismatches(env_t) FROM PUBLIC;

DO $security$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='farejador_partner_app') THEN
    REVOKE ALL ON FUNCTION
      finance.matriz_stage3_ledger_reconciliation_v0150(env_t)
      FROM farejador_partner_app;
    REVOKE ALL ON FUNCTION
      finance.matriz_stage3_ledger_reconciliation(env_t)
      FROM farejador_partner_app;
    REVOKE ALL ON FUNCTION
      finance.matriz_stage3_ledger_amount_mismatches(env_t)
      FROM farejador_partner_app;
  END IF;
END
$security$;

-- Fatos financeiros do parceiro precisam ter valor econômico real. CHECK NOT
-- VALID protege toda escrita nova sem derrubar uma base antiga que ainda tenha
-- lançamentos de teste zerados; quando a base está limpa, valida imediatamente.
DO $constraints$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
      WHERE conname='partner_orders_total_positive_finance_check'
        AND conrelid='commerce.partner_orders'::regclass) THEN
    ALTER TABLE commerce.partner_orders
      ADD CONSTRAINT partner_orders_total_positive_finance_check
      CHECK (total_amount>0) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
      WHERE conname='partner_expenses_amount_positive_finance_check'
        AND conrelid='finance.partner_expenses'::regclass) THEN
    ALTER TABLE finance.partner_expenses
      ADD CONSTRAINT partner_expenses_amount_positive_finance_check
      CHECK (amount>0) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
      WHERE conname='partner_payables_amount_positive_finance_check'
        AND conrelid='finance.partner_payables'::regclass) THEN
    ALTER TABLE finance.partner_payables
      ADD CONSTRAINT partner_payables_amount_positive_finance_check
      CHECK (amount>0 OR (status='cancelled' AND amount=0)) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
      WHERE conname='partner_receivables_amount_positive_finance_check'
        AND conrelid='finance.partner_receivables'::regclass) THEN
    ALTER TABLE finance.partner_receivables
      ADD CONSTRAINT partner_receivables_amount_positive_finance_check
      CHECK (amount>0) NOT VALID;
  END IF;
END
$constraints$;

DO $validate$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM commerce.partner_orders WHERE total_amount<=0) THEN
    ALTER TABLE commerce.partner_orders
      VALIDATE CONSTRAINT partner_orders_total_positive_finance_check;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM finance.partner_expenses WHERE amount<=0) THEN
    ALTER TABLE finance.partner_expenses
      VALIDATE CONSTRAINT partner_expenses_amount_positive_finance_check;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM finance.partner_payables
      WHERE NOT (amount>0 OR (status='cancelled' AND amount=0))) THEN
    ALTER TABLE finance.partner_payables
      VALIDATE CONSTRAINT partner_payables_amount_positive_finance_check;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM finance.partner_receivables WHERE amount<=0) THEN
    ALTER TABLE finance.partner_receivables
      VALIDATE CONSTRAINT partner_receivables_amount_positive_finance_check;
  END IF;
END
$validate$;

CREATE OR REPLACE VIEW network.partner_unit_summary
WITH (security_invoker = true) AS
WITH month_bounds AS (
  SELECT
    (date_trunc('month',now() AT TIME ZONE 'America/Sao_Paulo')
      AT TIME ZONE 'America/Sao_Paulo') AS month_start_at,
    date_trunc('month',now() AT TIME ZONE 'America/Sao_Paulo')::date
      AS month_start_date
)
SELECT
  pu.environment,pu.id AS partner_unit_id,pu.unit_id,pu.slug,pu.display_name,
  p.id AS partner_id,p.trade_name AS partner_name,p.status AS partner_status,
  pu.status AS unit_status,
  COALESCE(orders_month.total_sales,0::numeric) AS sales_month,
  COALESCE(orders_month.order_count,0) AS orders_month,
  COALESCE(purchases_month.total_purchases,0::numeric) AS purchases_month,
  COALESCE(expenses_month.total_expenses,0::numeric) AS expenses_month,
  CASE WHEN COALESCE(cogs_month.pending_count,0)=0
    THEN COALESCE(orders_month.total_sales,0::numeric)
      -COALESCE(cogs_month.known_total,0::numeric)
      -COALESCE(expenses_month.total_expenses,0::numeric)
    ELSE NULL::numeric END AS result_competencia_month,
  CASE WHEN COALESCE(cogs_month.pending_count,0)=0
    THEN COALESCE(orders_month.total_sales,0::numeric)
      -COALESCE(cogs_month.known_total,0::numeric)
      -COALESCE(expenses_month.total_expenses,0::numeric)
    ELSE NULL::numeric END AS estimated_result_month,
  COALESCE(cash_in_month.total,0::numeric) AS cash_in_month,
  COALESCE(cash_out_month.total,0::numeric) AS cash_out_month,
  COALESCE(cash_in_month.total,0::numeric)
    -COALESCE(cash_out_month.total,0::numeric) AS cash_net_month,
  COALESCE(open_recv.total,0::numeric) AS open_receivables_total,
  COALESCE(open_pay.total,0::numeric) AS open_payables_total,
  COALESCE(open_recv.total,0::numeric)
    -COALESCE(open_pay.total,0::numeric) AS net_future_position,
  COALESCE(stock_counts.stock_items,0) AS stock_items,
  COALESCE(stock_counts.low_stock_items,0) AS low_stock_items,
  COALESCE(cogs_month.known_total,0::numeric) AS cogs_month,
  COALESCE(cogs_month.known_total,0::numeric) AS known_cogs_month,
  COALESCE(cogs_month.pending_count,0) AS pending_cost_items_month,
  COALESCE(cogs_month.pending_revenue,0::numeric) AS pending_cost_revenue_month,
  COALESCE(cogs_month.pending_count,0)>0 AS has_pending_cost_month,
  CASE WHEN COALESCE(cogs_month.pending_count,0)=0
    THEN COALESCE(orders_month.total_sales,0::numeric)
      -COALESCE(cogs_month.known_total,0::numeric)
      -COALESCE(expenses_month.total_expenses,0::numeric)
    ELSE NULL::numeric END AS confirmed_result_month
FROM network.partner_units pu
JOIN network.partners p
  ON p.id=pu.partner_id AND p.environment=pu.environment
CROSS JOIN month_bounds mb
LEFT JOIN LATERAL (
  SELECT count(*)::integer AS order_count,
         COALESCE(sum(po.total_amount),0::numeric) AS total_sales
    FROM commerce.partner_orders po
   WHERE po.environment=pu.environment AND po.unit_id=pu.unit_id
     AND po.status<>'cancelled' AND po.deleted_at IS NULL
     AND NOT (po.fulfillment_mode='delivery' AND po.delivery_status<>'delivered')
     AND NOT po.awaiting_pickup
     AND (CASE WHEN po.fulfillment_mode='delivery' THEN po.delivered_at
               ELSE COALESCE(po.retrieved_at,po.created_at) END)>=mb.month_start_at
) orders_month ON true
LEFT JOIN LATERAL (
  SELECT
    COALESCE(sum(oi.quantity::numeric*oi.unit_cost_snapshot)
      FILTER (WHERE oi.cost_status='known'),0::numeric) AS known_total,
    count(*) FILTER (WHERE oi.cost_status='pending')::integer AS pending_count,
    COALESCE(sum(oi.quantity::numeric*oi.unit_price-oi.discount_amount)
      FILTER (WHERE oi.cost_status='pending'),0::numeric) AS pending_revenue
    FROM commerce.partner_orders po_c
    JOIN commerce.partner_order_items oi
      ON oi.order_id=po_c.id AND oi.environment=po_c.environment
   WHERE po_c.environment=pu.environment AND po_c.unit_id=pu.unit_id
     AND po_c.status<>'cancelled' AND po_c.deleted_at IS NULL
     AND NOT (po_c.fulfillment_mode='delivery'
       AND po_c.delivery_status<>'delivered')
     AND NOT po_c.awaiting_pickup
     AND (CASE WHEN po_c.fulfillment_mode='delivery' THEN po_c.delivered_at
               ELSE COALESCE(po_c.retrieved_at,po_c.created_at) END)>=mb.month_start_at
) cogs_month ON true
LEFT JOIN LATERAL (
  SELECT COALESCE(sum(pp.total_amount),0::numeric) AS total_purchases
    FROM commerce.partner_purchases pp
   WHERE pp.environment=pu.environment AND pp.unit_id=pu.unit_id
     AND pp.purchased_at>=mb.month_start_at AND pp.deleted_at IS NULL
) purchases_month ON true
LEFT JOIN LATERAL (
  SELECT
    COALESCE((SELECT sum(pe.amount) FROM finance.partner_expenses pe
      WHERE pe.environment=pu.environment AND pe.unit_id=pu.unit_id
        AND pe.deleted_at IS NULL AND pe.source_payable_id IS NULL
        AND pe.competence_month=mb.month_start_date),0::numeric)
    +COALESCE((SELECT sum(pp.amount) FROM finance.partner_payables pp
      WHERE pp.environment=pu.environment AND pp.unit_id=pu.unit_id
        AND pp.deleted_at IS NULL AND pp.source_purchase_id IS NULL
        AND pp.status IN ('open','paid')
        AND pp.competence_month=mb.month_start_date),0::numeric)
    +COALESCE((SELECT sum(ce.commission_amount)
      FROM finance.partner_staff_commission_entries ce
      WHERE ce.environment=pu.environment AND ce.unit_id=pu.unit_id
        AND ce.status='earned' AND ce.settlement_period_id IS NULL
        AND ce.competence_month=mb.month_start_date),0::numeric)
    +COALESCE((SELECT sum(ca.amount)
      FROM finance.partner_staff_commission_adjustments ca
      WHERE ca.environment=pu.environment AND ca.unit_id=pu.unit_id
        AND ca.settlement_period_id IS NULL
        AND ca.competence_month=mb.month_start_date),0::numeric)
      AS total_expenses
) expenses_month ON true
LEFT JOIN LATERAL (
  SELECT
    COALESCE((SELECT sum(po.total_amount) FROM commerce.partner_orders po
      WHERE po.environment=pu.environment AND po.unit_id=pu.unit_id
        AND po.status<>'cancelled' AND po.deleted_at IS NULL
        AND NOT (po.fulfillment_mode='delivery'
          AND po.delivery_status<>'delivered')
        AND NOT po.awaiting_pickup
        AND (CASE WHEN po.fulfillment_mode='delivery' THEN po.delivered_at
                  ELSE COALESCE(po.retrieved_at,po.created_at) END)>=mb.month_start_at
        AND (po.payment_method IS NULL OR po.payment_method<>'A receber')),0::numeric)
    +COALESCE((SELECT sum(pre.amount)
      FROM finance.partner_receivables_effective pre
      WHERE pre.environment=pu.environment AND pre.unit_id=pu.unit_id
        AND pre.status='received' AND pre.received_at>=mb.month_start_at),0::numeric)
      AS total
) cash_in_month ON true
LEFT JOIN LATERAL (
  SELECT
    COALESCE((SELECT sum(pp.total_amount) FROM commerce.partner_purchases pp
      WHERE pp.environment=pu.environment AND pp.unit_id=pu.unit_id
        AND pp.deleted_at IS NULL AND pp.purchased_at>=mb.month_start_at
        AND pp.payment_status='paid_now'),0::numeric)
    +COALESCE((SELECT sum(pe.amount) FROM finance.partner_expenses pe
      WHERE pe.environment=pu.environment AND pe.unit_id=pu.unit_id
        AND pe.deleted_at IS NULL AND pe.expense_date>=mb.month_start_date
        AND pe.source_payable_id IS NULL),0::numeric)
    +COALESCE((SELECT sum(pp2.amount) FROM finance.partner_payables pp2
      WHERE pp2.environment=pu.environment AND pp2.unit_id=pu.unit_id
        AND pp2.deleted_at IS NULL AND pp2.status='paid'
        AND pp2.paid_at>=mb.month_start_at),0::numeric) AS total
) cash_out_month ON true
LEFT JOIN LATERAL (
  SELECT COALESCE(sum(pre.amount),0::numeric) AS total
    FROM finance.partner_receivables_effective pre
   WHERE pre.environment=pu.environment AND pre.unit_id=pu.unit_id
     AND pre.status='open'
) open_recv ON true
LEFT JOIN LATERAL (
  SELECT COALESCE(sum(pp3.amount),0::numeric) AS total
    FROM finance.partner_payables pp3
   WHERE pp3.environment=pu.environment AND pp3.unit_id=pu.unit_id
     AND pp3.status='open' AND pp3.deleted_at IS NULL
) open_pay ON true
LEFT JOIN LATERAL (
  SELECT count(*)::integer AS stock_items,
         count(*) FILTER (WHERE ps.stock_status=ANY(
           ARRAY['low_stock','out_of_stock']))::integer AS low_stock_items
    FROM commerce.partner_stock_levels ps
   WHERE ps.environment=pu.environment AND ps.unit_id=pu.unit_id
     AND ps.deleted_at IS NULL
) stock_counts ON true
WHERE pu.deleted_at IS NULL;

COMMENT ON VIEW network.partner_unit_summary IS
  '0190: resumo mensal do parceiro com competencia e caixa na data de realizacao.';
GRANT SELECT ON network.partner_unit_summary TO farejador_partner_app;

DO $smoke$
DECLARE v_missing bigint;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='commerce' AND table_name='wholesale_orders'
       AND column_name='partner_settled_at'
  ) THEN RAISE EXCEPTION '0190: partner_settled_at ausente'; END IF;

  SELECT count(*) INTO v_missing
    FROM commerce.wholesale_orders
   WHERE partner_transfer_status IN ('settled','received')
     AND partner_settled_at IS NULL;
  IF v_missing<>0 THEN
    RAISE EXCEPTION '0190: % cargas acertadas sem data de acerto',v_missing;
  END IF;
END
$smoke$;
