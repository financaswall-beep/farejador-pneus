import pg, { type PoolClient } from 'pg';

const { Pool } = pg;

type AuditRow = Record<string, unknown>;

const environment = process.env.FAREJADOR_ENV === 'test' ? 'test' : 'prod';
const connectionString = process.env.DATABASE_URL;

if (!connectionString) throw new Error('DATABASE_URL ausente');

const pool = new Pool({
  connectionString,
  max: 1,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

async function one(client: PoolClient, sql: string): Promise<AuditRow> {
  const result = await client.query<AuditRow>(sql, [environment]);
  return result.rows[0] ?? {};
}

async function many(client: PoolClient, sql: string): Promise<AuditRow[]> {
  const result = await client.query<AuditRow>(sql, [environment]);
  return result.rows;
}

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query(`SET LOCAL statement_timeout='30s'`);

    const transaction = await client.query<{ read_only: string }>(
      `SELECT current_setting('transaction_read_only') AS read_only`,
    );
    if (transaction.rows[0]?.read_only !== 'on') {
      throw new Error('auditoria_nao_esta_read_only');
    }

    const reports: Record<string, AuditRow> = {};

    reports.matriz_saldo = await one(client, `
      SELECT count(*)::int AS variantes,
             COALESCE(sum(quantity_on_hand),0)::int AS fisico,
             COALESCE(sum(quantity_reserved),0)::int AS reservado,
             COALESCE(sum(quantity_on_hand-quantity_reserved),0)::int AS disponivel,
             round(COALESCE(sum(quantity_on_hand*unit_cost),0),2)::text AS valor_estoque,
             count(*) FILTER (WHERE quantity_on_hand<0)::int AS saldo_negativo,
             count(*) FILTER (WHERE quantity_reserved<0 OR quantity_reserved>quantity_on_hand)::int AS reserva_invalida,
             count(*) FILTER (WHERE quantity_on_hand>0 AND unit_cost<=0)::int AS saldo_com_custo_ausente,
             count(*) FILTER (WHERE min_quantity IS NOT NULL AND min_quantity<0)::int AS minimo_invalido
        FROM commerce.wholesale_stock WHERE environment=$1`);

    reports.matriz_identidade = await one(client, `
      WITH canonical AS (
        SELECT regexp_replace(measure,'[^0-9]+','','g') measure_key,
               lower(regexp_replace(trim(brand),'[^[:alnum:]]+','','g')) brand_key,
               tire_condition,count(*) count_rows
          FROM commerce.wholesale_stock WHERE environment=$1
         GROUP BY 1,2,3
      )
      SELECT count(*) FILTER (WHERE count_rows>1)::int AS variantes_canonicas_duplicadas
        FROM canonical`);

    reports.matriz_filme = await one(client, `
      WITH movement_sum AS (
        SELECT measure,brand,tire_condition,sum(qty_delta)::int AS reconstructed
          FROM commerce.wholesale_stock_movements WHERE environment=$1
         GROUP BY measure,brand,tire_condition
      ), latest AS (
        SELECT DISTINCT ON (measure,brand,tire_condition)
               measure,brand,tire_condition,qty_after,cost_after
          FROM commerce.wholesale_stock_movements WHERE environment=$1
         ORDER BY measure,brand,tire_condition,created_at DESC,id DESC
      )
      SELECT count(*) FILTER (WHERE COALESCE(ms.reconstructed,0)<>s.quantity_on_hand)::int
               AS saldo_diverge_soma_movimentos,
             count(*) FILTER (WHERE l.qty_after IS DISTINCT FROM s.quantity_on_hand
               OR l.cost_after IS DISTINCT FROM s.unit_cost)::int AS saldo_diverge_ultimo_movimento,
             (SELECT count(*)::int FROM commerce.wholesale_stock_movements m
               WHERE m.environment=$1 AND m.source='sem_rotulo') AS movimentos_sem_origem
        FROM commerce.wholesale_stock s
        LEFT JOIN movement_sum ms USING (measure,brand,tire_condition)
        LEFT JOIN latest l USING (measure,brand,tire_condition)
       WHERE s.environment=$1`);

    reports.matriz_filme_detalhes = {
      divergencias: await many(client, `
        WITH movement_sum AS (
          SELECT measure,brand,tire_condition,sum(qty_delta)::int AS reconstructed,
                 count(*)::int AS movement_count,
                 min(created_at) AS first_movement_at
            FROM commerce.wholesale_stock_movements WHERE environment=$1
           GROUP BY measure,brand,tire_condition
        ), first_movement AS (
          SELECT DISTINCT ON (measure,brand,tire_condition)
                 measure,brand,tire_condition,op,qty_before,qty_after,source
            FROM commerce.wholesale_stock_movements WHERE environment=$1
           ORDER BY measure,brand,tire_condition,created_at,id
        )
        SELECT stock.measure,stock.brand,stock.tire_condition,stock.quantity_on_hand,
               COALESCE(movement.reconstructed,0) reconstructed,
               movement.movement_count,movement.first_movement_at,
               first.op AS first_op,first.qty_before AS first_qty_before,
               first.qty_after AS first_qty_after,first.source AS first_source
          FROM commerce.wholesale_stock stock
          LEFT JOIN movement_sum movement
            USING (measure,brand,tire_condition)
          LEFT JOIN first_movement first
            USING (measure,brand,tire_condition)
         WHERE stock.environment=$1
           AND COALESCE(movement.reconstructed,0)<>stock.quantity_on_hand
         ORDER BY stock.measure,stock.brand,stock.tire_condition`),
    };

    reports.matriz_reservas = await one(client, `
      WITH reserved AS (
        SELECT movement->>'measure' measure,
               COALESCE(movement->>'brand','Sem marca') brand,
               COALESCE(movement->>'tire_condition','meia_vida') tire_condition,
               sum(COALESCE((movement->>'qty')::int,0))::int expected
          FROM audit.events event
          CROSS JOIN LATERAL jsonb_array_elements(
            CASE WHEN jsonb_typeof(event.payload_after->'movements')='array'
              THEN event.payload_after->'movements' ELSE '[]'::jsonb END
          ) movement
         WHERE event.environment=$1 AND event.event_type='matriz_galpao_reserved'
           AND NOT EXISTS (
             SELECT 1 FROM audit.events terminal
              WHERE terminal.environment=event.environment
                AND terminal.entity_id=event.entity_id
                AND terminal.event_type IN (
                  'matriz_galpao_decrement','matriz_galpao_reservation_released'
                )
           )
         GROUP BY 1,2,3
      ), compared AS (
        SELECT s.measure,s.brand,s.tire_condition,s.quantity_reserved,
               COALESCE(r.expected,0) expected
          FROM commerce.wholesale_stock s
          LEFT JOIN reserved r USING (measure,brand,tire_condition)
         WHERE s.environment=$1
        UNION ALL
        SELECT r.measure,r.brand,r.tire_condition,0,r.expected
          FROM reserved r
         WHERE NOT EXISTS (
           SELECT 1 FROM commerce.wholesale_stock s
            WHERE s.environment=$1 AND s.measure=r.measure AND s.brand=r.brand
              AND s.tire_condition=r.tire_condition
         )
      )
      SELECT count(*) FILTER (WHERE quantity_reserved<>expected)::int AS variantes_divergentes,
             COALESCE(sum(quantity_reserved),0)::int AS reservado_banco,
             COALESCE(sum(expected),0)::int AS reservado_por_eventos
        FROM compared`);

    reports.matriz_financeiro = await one(client, `
      SELECT
        (SELECT count(*)::int FROM finance.matriz_inventory_adjustments a
          WHERE a.environment=$1 AND NOT EXISTS (
            SELECT 1 FROM finance.matriz_ledger_transactions t
             WHERE t.environment=a.environment
               AND t.source_type='finance.inventory_adjustment'
               AND t.source_id=a.id::text
          )) AS ajustes_sem_ledger,
        (SELECT count(*)::int FROM (
          SELECT t.id
            FROM finance.matriz_ledger_transactions t
            JOIN finance.matriz_ledger_entries e ON e.transaction_id=t.id
              AND e.environment=t.environment
           WHERE t.environment=$1
           GROUP BY t.id
          HAVING sum(CASE WHEN e.side='debit' THEN e.amount ELSE -e.amount END)<>0
        ) unbalanced) AS ledger_desbalanceado`);

    reports.parceiro_saldo = await one(client, `
      SELECT count(*)::int AS itens,
             COALESCE(sum(quantity_on_hand) FILTER (WHERE is_tracked),0)::int AS fisico,
             COALESCE(sum(quantity_reserved) FILTER (WHERE is_tracked),0)::int AS reservado,
             COALESCE(sum(quantity_on_hand-quantity_reserved)
               FILTER (WHERE is_tracked AND quantity_on_hand IS NOT NULL),0)::int AS disponivel,
             round(COALESCE(sum(quantity_on_hand*average_cost)
               FILTER (WHERE is_tracked AND quantity_on_hand IS NOT NULL),0),2)::text AS valor_estoque,
             count(*) FILTER (WHERE quantity_on_hand<0)::int AS saldo_negativo,
             count(*) FILTER (WHERE quantity_reserved<0
               OR (quantity_on_hand IS NOT NULL AND quantity_reserved>quantity_on_hand))::int AS reserva_invalida,
             count(*) FILTER (WHERE is_tracked AND quantity_on_hand>0 AND average_cost IS NULL)::int
               AS saldo_com_custo_ausente,
             count(*) FILTER (WHERE stock_status IS DISTINCT FROM commerce.partner_stock_status(
               quantity_on_hand,quantity_reserved,minimum_quantity,is_tracked))::int AS status_divergente
        FROM commerce.partner_stock_levels WHERE environment=$1 AND deleted_at IS NULL`);

    reports.parceiro_identidade = await one(client, `
      WITH natural_keys AS (
        SELECT unit_id,lower(trim(item_name)) item_name,
               COALESCE(lower(trim(tire_size)),'') tire_size,
               COALESCE(lower(trim(brand)),'') brand,
               COALESCE(lower(trim(supplier_name)),'') supplier,
               COALESCE(tire_condition,'') tire_condition,count(*) count_rows
          FROM commerce.partner_stock_levels
         WHERE environment=$1 AND deleted_at IS NULL
         GROUP BY 1,2,3,4,5,6
      )
      SELECT count(*) FILTER (WHERE count_rows>1)::int AS chaves_naturais_duplicadas
        FROM natural_keys`);

    reports.parceiro_compras = await one(client, `
      WITH totals AS (
        SELECT p.id,p.receipt_status,p.payment_status,p.total_amount,
               COALESCE(sum(i.quantity*i.unit_cost),0) expected_total,
               COALESCE(sum(COALESCE(i.received_quantity,0)*i.unit_cost),0) received_total,
               count(*) FILTER (WHERE i.received_quantity IS NULL)::int missing_receipt_qty
          FROM commerce.partner_purchases p
          LEFT JOIN commerce.partner_purchase_items i
            ON i.environment=p.environment AND i.purchase_id=p.id
         WHERE p.environment=$1 AND p.deleted_at IS NULL
         GROUP BY p.id
      )
      SELECT count(*)::int AS compras,
             count(*) FILTER (WHERE total_amount<>expected_total)::int AS cabecalho_diverge_itens,
             count(*) FILTER (WHERE receipt_status='received' AND missing_receipt_qty>0)::int
               AS recebidas_sem_quantidade,
             count(*) FILTER (WHERE receipt_status='received'
               AND received_total<>expected_total)::int AS recebimentos_divergentes,
             round(COALESCE(sum(expected_total),0),2)::text AS valor_esperado,
             round(COALESCE(sum(received_total) FILTER (WHERE receipt_status='received'),0),2)::text
               AS valor_fisicamente_recebido
        FROM totals`);

    reports.parceiro_compras_financeiro = await one(client, `
      SELECT count(*) FILTER (WHERE payable.id IS NULL)::int AS compras_a_prazo_sem_conta,
             count(*) FILTER (WHERE payable.amount<>purchase.total_amount)::int AS conta_diverge_compra,
             count(*) FILTER (WHERE payable.status='paid' AND purchase.receipt_status='pending')::int
               AS paga_antes_do_recebimento
        FROM commerce.partner_purchases purchase
        LEFT JOIN finance.partner_payables payable
          ON payable.environment=purchase.environment
         AND payable.unit_id=purchase.unit_id
         AND payable.source_purchase_id=purchase.id
         AND payable.deleted_at IS NULL
       WHERE purchase.environment=$1 AND purchase.deleted_at IS NULL
         AND purchase.payment_status='payable'`);

    reports.parceiro_vendas_custo = await one(client, `
      SELECT count(*) FILTER (WHERE item.cost_status='pending')::int AS itens_custo_pendente,
             count(*) FILTER (WHERE item.cost_status='known'
               AND item.unit_cost_snapshot IS NULL)::int AS custo_conhecido_sem_valor
        FROM commerce.partner_order_items item
        JOIN commerce.partner_orders sale
          ON sale.environment=item.environment AND sale.id=item.order_id
       WHERE item.environment=$1 AND sale.deleted_at IS NULL AND sale.status<>'cancelled'`);

    reports.parceiro_vendas_custo_detalhes = {
      pendencias_por_origem: await many(client, `
        SELECT sale.source_tag,sale.status,count(*)::int AS itens,
               min(sale.created_at) AS primeira_venda,
               max(sale.created_at) AS ultima_venda
          FROM commerce.partner_order_items item
          JOIN commerce.partner_orders sale
            ON sale.environment=item.environment AND sale.id=item.order_id
         WHERE item.environment=$1 AND sale.deleted_at IS NULL
           AND sale.status<>'cancelled' AND item.cost_status='pending'
         GROUP BY sale.source_tag,sale.status
         ORDER BY sale.source_tag,sale.status`),
    };

    reports.parceiro_reservas = await one(client, `
      WITH reservations AS (
        SELECT movement->>'stock_id' stock_id,
               sum(COALESCE((movement->>'reserved_delta')::int,0))::int reserved
          FROM audit.events event
          CROSS JOIN LATERAL jsonb_array_elements(
            CASE WHEN jsonb_typeof(event.payload_after->'moves')='array'
              THEN event.payload_after->'moves' ELSE '[]'::jsonb END
          ) movement
         WHERE event.environment=$1 AND event.event_type='stock_reserved'
           AND NOT EXISTS (
             SELECT 1 FROM audit.events terminal
              WHERE terminal.environment=event.environment
                AND terminal.payload_after->>'order_id'=event.payload_after->>'order_id'
                AND (
                  (terminal.event_type='stock_reservation_released'
                    AND terminal.entity_id::text=movement->>'stock_id')
                  OR (terminal.event_type='stock_decrement_sale'
                    AND terminal.entity_id::text=movement->>'stock_id')
                )
           )
         GROUP BY 1
      )
      SELECT count(*) FILTER (WHERE stock.quantity_reserved<>COALESCE(r.reserved,0))::int
               AS itens_divergentes,
             COALESCE(sum(stock.quantity_reserved),0)::int AS reservado_banco,
             COALESCE(sum(r.reserved),0)::int AS reservado_por_eventos
        FROM commerce.partner_stock_levels stock
        LEFT JOIN reservations r ON r.stock_id=stock.id::text
       WHERE stock.environment=$1 AND stock.deleted_at IS NULL`);

    await client.query('ROLLBACK');
    console.log(JSON.stringify({ environment, read_only: true, reports }, null, 2));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

await main();
