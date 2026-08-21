/**
 * Auditoria somente leitura do Catálogo da Matriz e dos vínculos com a Rede.
 *
 * Uso:
 *   npx tsx --env-file=.env.preview.pooler scripts/auditar-catalogo-prod-readonly.ts
 */
import type { PoolClient, QueryResultRow } from 'pg';
import { pool } from '../src/persistence/db.js';
import { env } from '../src/shared/config/env.js';

async function query<T extends QueryResultRow>(
  client: PoolClient,
  title: string,
  sql: string,
): Promise<T[]> {
  const result = await client.query<T>(sql);
  console.log(`\n=== ${title} (${result.rowCount ?? 0}) ===`);
  console.log(JSON.stringify(result.rows, null, 2));
  return result.rows;
}

async function main(): Promise<void> {
  if (env.FAREJADOR_ENV !== 'prod') {
    throw new Error('auditoria exige a configuração de produção');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout='20s'");

    await query(client, 'Versão e relógio', `
      SELECT current_setting('TimeZone') AS database_timezone,
             now()::text AS database_now,
             COALESCE((
               SELECT max(version) FROM supabase_migrations.schema_migrations
             ),'sem_tracker') AS latest_migration
    `);

    await query(client, 'Bloqueadores da migration 0197 em todos os ambientes', `
      WITH problems AS (
        SELECT 'matriz_non_positive_price' AS issue,environment::text AS environment,
               count(*)::int AS total
          FROM commerce.matriz_product_prices WHERE price_amount<=0 GROUP BY environment
        UNION ALL
        SELECT 'network_non_positive_price',environment::text,count(*)::int
          FROM commerce.product_prices WHERE price_amount<=0 GROUP BY environment
        UNION ALL
        SELECT 'partner_non_positive_price',environment::text,count(*)::int
          FROM commerce.partner_stock_levels
         WHERE sale_price IS NOT NULL AND sale_price<=0 GROUP BY environment
        UNION ALL
        SELECT 'matriz_multiple_open_prices',environment,count(*)::int FROM (
          SELECT environment::text AS environment,product_id
            FROM commerce.matriz_product_prices WHERE valid_until IS NULL
           GROUP BY environment,product_id HAVING count(*)>1
        ) duplicates GROUP BY environment
        UNION ALL
        SELECT 'network_multiple_open_prices',environment,count(*)::int FROM (
          SELECT environment::text AS environment,product_id,price_type
            FROM commerce.product_prices WHERE valid_until IS NULL
           GROUP BY environment,product_id,price_type HAVING count(*)>1
        ) duplicates GROUP BY environment
      )
      SELECT issue,environment,total FROM problems WHERE total>0
       ORDER BY issue,environment
    `);

    await query(client, 'Resumo do Catálogo da Matriz', `
      SELECT count(*)::int AS active_products,
             count(*) FILTER (WHERE p.product_type='tire')::int AS tires,
             count(*) FILTER (WHERE p.product_type='service')::int AS services,
             count(*) FILTER (WHERE p.product_type='tire' AND ts.id IS NULL)::int
               AS tires_without_spec,
             count(*) FILTER (WHERE cp.product_id IS NULL)::int AS without_current_price,
             count(*) FILTER (WHERE cp.price_amount<=0)::int AS non_positive_current_prices,
             count(*) FILTER (WHERE cp.currency<>'BRL')::int AS non_brl_current_prices
        FROM commerce.products p
        LEFT JOIN commerce.tire_specs ts
          ON ts.environment=p.environment AND ts.product_id=p.id
        LEFT JOIN commerce.matriz_current_prices cp
          ON cp.environment=p.environment AND cp.product_id=p.id
       WHERE p.environment='prod' AND p.deleted_at IS NULL
    `);

    await query(client, 'Produtos sem preço comercial vigente', `
      SELECT p.product_code,p.product_type,ts.tire_size,p.brand,p.tire_condition
        FROM commerce.products p
        LEFT JOIN commerce.tire_specs ts
          ON ts.environment=p.environment AND ts.product_id=p.id
        LEFT JOIN commerce.matriz_current_prices cp
          ON cp.environment=p.environment AND cp.product_id=p.id
       WHERE p.environment='prod' AND p.deleted_at IS NULL
         AND cp.product_id IS NULL
       ORDER BY p.product_code
    `);

    await query(client, 'Variantes comerciais duplicadas', `
      SELECT regexp_replace(ts.tire_size,'[^0-9]+','','g') AS measure_key,
             CASE WHEN regexp_replace(translate(lower(COALESCE(p.brand,'')),
                            'áàâãäéèêëíìîïóòôõöúùûüç','aaaaaeeeeiiiiooooouuuuc'),
                            '[^a-z0-9]+','','g')
                            IN ('','semmarca') THEN ''
                  ELSE regexp_replace(translate(lower(COALESCE(p.brand,'')),
                         'áàâãäéèêëíìîïóòôõöúùûüç','aaaaaeeeeiiiiooooouuuuc'),
                         '[^a-z0-9]+','','g')
              END AS brand_key,
             p.tire_condition,count(*)::int AS products,
             array_agg(p.product_code ORDER BY p.product_code) AS product_codes
        FROM commerce.products p
        JOIN commerce.tire_specs ts
          ON ts.environment=p.environment AND ts.product_id=p.id
       WHERE p.environment='prod' AND p.deleted_at IS NULL AND p.product_type='tire'
       GROUP BY 1,2,3 HAVING count(*)>1
       ORDER BY products DESC,measure_key
    `);

    await query(client, 'Preços simultaneamente vigentes', `
      SELECT 'matriz' AS source,product_id,count(*)::int AS active_prices
        FROM commerce.matriz_product_prices
       WHERE environment='prod' AND valid_from<=now()
         AND (valid_until IS NULL OR valid_until>now())
       GROUP BY product_id HAVING count(*)>1
      UNION ALL
      SELECT 'rede_regular',product_id,count(*)::int
        FROM commerce.product_prices
       WHERE environment='prod' AND price_type='regular' AND valid_from<=now()
         AND (valid_until IS NULL OR valid_until>now())
       GROUP BY product_id HAVING count(*)>1
       ORDER BY source,product_id
    `);

    await query(client, 'Janelas de preço sobrepostas', `
      SELECT source,count(*)::int AS overlapping_pairs FROM (
        SELECT 'matriz' AS source
          FROM commerce.matriz_product_prices a
          JOIN commerce.matriz_product_prices b
            ON b.environment=a.environment AND b.product_id=a.product_id AND b.id>a.id
           AND tstzrange(a.valid_from,COALESCE(a.valid_until,'infinity'),'[)')
               && tstzrange(b.valid_from,COALESCE(b.valid_until,'infinity'),'[)')
         WHERE a.environment='prod'
        UNION ALL
        SELECT 'rede_regular'
          FROM commerce.product_prices a
          JOIN commerce.product_prices b
            ON b.environment=a.environment AND b.product_id=a.product_id AND b.id>a.id
           AND b.price_type=a.price_type
           AND tstzrange(a.valid_from,COALESCE(a.valid_until,'infinity'),'[)')
               && tstzrange(b.valid_from,COALESCE(b.valid_until,'infinity'),'[)')
         WHERE a.environment='prod' AND a.price_type='regular'
      ) overlapping_rows GROUP BY source ORDER BY source
    `);

    await query(client, 'Catálogo versus estoque oficial da Matriz', `
      WITH catalog AS (
        SELECT p.id,regexp_replace(ts.tire_size,'[^0-9]+','','g') measure_key,
               CASE WHEN regexp_replace(translate(lower(COALESCE(p.brand,'')),
                              'áàâãäéèêëíìîïóòôõöúùûüç','aaaaaeeeeiiiiooooouuuuc'),
                              '[^a-z0-9]+','','g')
                              IN ('','semmarca') THEN ''
                    ELSE regexp_replace(translate(lower(COALESCE(p.brand,'')),
                           'áàâãäéèêëíìîïóòôõöúùûüç','aaaaaeeeeiiiiooooouuuuc'),
                           '[^a-z0-9]+','','g')
                END brand_key,
               p.tire_condition
          FROM commerce.products p
          JOIN commerce.tire_specs ts
            ON ts.environment=p.environment AND ts.product_id=p.id
         WHERE p.environment='prod' AND p.deleted_at IS NULL AND p.product_type='tire'
      ), stock AS (
        SELECT id,regexp_replace(measure,'[^0-9]+','','g') measure_key,
               CASE WHEN regexp_replace(translate(lower(COALESCE(brand,'')),
                              'áàâãäéèêëíìîïóòôõöúùûüç','aaaaaeeeeiiiiooooouuuuc'),
                              '[^a-z0-9]+','','g')
                              IN ('','semmarca') THEN ''
                    ELSE regexp_replace(translate(lower(COALESCE(brand,'')),
                           'áàâãäéèêëíìîïóòôõöúùûüç','aaaaaeeeeiiiiooooouuuuc'),
                           '[^a-z0-9]+','','g')
                END brand_key,
               tire_condition,quantity_on_hand,quantity_reserved
          FROM commerce.wholesale_stock WHERE environment='prod'
      ), matches AS (
        SELECT c.id product_id,count(s.id)::int stock_matches
          FROM catalog c LEFT JOIN stock s USING (measure_key,brand_key,tire_condition)
         GROUP BY c.id
      )
      SELECT (SELECT count(*) FROM catalog)::int AS catalog_tires,
             (SELECT count(*) FROM stock)::int AS stock_variants,
             count(*) FILTER (WHERE stock_matches=0)::int AS catalog_without_stock,
             count(*) FILTER (WHERE stock_matches>1)::int AS catalog_ambiguous_stock,
             (SELECT count(*) FROM stock s WHERE NOT EXISTS (
               SELECT 1 FROM catalog c
                WHERE c.measure_key=s.measure_key AND c.brand_key=s.brand_key
                  AND c.tire_condition=s.tire_condition
             ))::int AS stock_without_catalog,
             (SELECT count(*) FROM stock
               WHERE quantity_reserved<0 OR quantity_reserved>quantity_on_hand)::int
               AS invalid_reservations
        FROM matches
    `);

    await query(client, 'Pendências exatas entre Catálogo e estoque', `
      WITH catalog AS (
        SELECT p.id,p.product_code,ts.tire_size,p.brand,p.tire_condition,
               regexp_replace(ts.tire_size,'[^0-9]+','','g') measure_key,
               CASE WHEN regexp_replace(translate(lower(COALESCE(p.brand,'')),
                              'áàâãäéèêëíìîïóòôõöúùûüç','aaaaaeeeeiiiiooooouuuuc'),
                              '[^a-z0-9]+','','g')
                              IN ('','semmarca') THEN ''
                    ELSE regexp_replace(translate(lower(COALESCE(p.brand,'')),
                           'áàâãäéèêëíìîïóòôõöúùûüç','aaaaaeeeeiiiiooooouuuuc'),
                           '[^a-z0-9]+','','g')
                END brand_key
          FROM commerce.products p
          JOIN commerce.tire_specs ts
            ON ts.environment=p.environment AND ts.product_id=p.id
         WHERE p.environment='prod' AND p.deleted_at IS NULL AND p.product_type='tire'
      ), stock AS (
        SELECT id,measure,brand,tire_condition,quantity_on_hand,quantity_reserved,
               regexp_replace(measure,'[^0-9]+','','g') measure_key,
               CASE WHEN regexp_replace(translate(lower(COALESCE(brand,'')),
                              'áàâãäéèêëíìîïóòôõöúùûüç','aaaaaeeeeiiiiooooouuuuc'),
                              '[^a-z0-9]+','','g')
                              IN ('','semmarca') THEN ''
                    ELSE regexp_replace(translate(lower(COALESCE(brand,'')),
                           'áàâãäéèêëíìîïóòôõöúùûüç','aaaaaeeeeiiiiooooouuuuc'),
                           '[^a-z0-9]+','','g')
                END brand_key
          FROM commerce.wholesale_stock WHERE environment='prod'
      )
      SELECT 'catalog_without_stock' AS issue,c.product_code AS reference,
             c.tire_size AS measure,c.brand,c.tire_condition,NULL::int AS quantity
        FROM catalog c WHERE NOT EXISTS (
          SELECT 1 FROM stock s WHERE s.measure_key=c.measure_key
            AND s.brand_key=c.brand_key AND s.tire_condition=c.tire_condition)
      UNION ALL
      SELECT 'stock_without_catalog',s.id::text,s.measure,s.brand,s.tire_condition,
             s.quantity_on_hand::int
        FROM stock s WHERE NOT EXISTS (
          SELECT 1 FROM catalog c WHERE c.measure_key=s.measure_key
            AND c.brand_key=s.brand_key AND c.tire_condition=s.tire_condition)
      ORDER BY issue,measure,brand
    `);

    await query(client, 'Compatibilidade incompleta entre produtos da mesma medida', `
      WITH counts AS (
        SELECT p.id,p.product_code,
               regexp_replace(ts.tire_size,'[^0-9]+','','g') measure_key,
               count(vf.id)::int fitments
          FROM commerce.products p
          JOIN commerce.tire_specs ts
            ON ts.environment=p.environment AND ts.product_id=p.id
          LEFT JOIN commerce.vehicle_fitments vf
            ON vf.environment=ts.environment AND vf.tire_spec_id=ts.id
         WHERE p.environment='prod' AND p.deleted_at IS NULL AND p.product_type='tire'
         GROUP BY p.id,p.product_code,measure_key
      ), expected AS (
        SELECT measure_key,max(fitments) max_fitments FROM counts GROUP BY measure_key
      )
      SELECT c.measure_key,c.product_code,c.fitments,e.max_fitments
        FROM counts c JOIN expected e USING (measure_key)
       WHERE c.fitments<>e.max_fitments
       ORDER BY c.measure_key,c.product_code
    `);

    await query(client, 'Vínculos do estoque dos parceiros', `
      SELECT count(*)::int AS active_items,
             count(*) FILTER (WHERE ps.product_id IS NOT NULL)::int AS linked_to_central_catalog,
             count(*) FILTER (WHERE ps.product_id IS NOT NULL AND p.id IS NULL)::int
               AS invalid_or_archived_links,
             count(*) FILTER (WHERE ps.sale_price IS NULL)::int AS without_local_price,
             count(*) FILTER (WHERE ps.sale_price<=0)::int AS non_positive_local_price,
             count(*) FILTER (WHERE ps.quantity_on_hand>0 AND ps.sale_price IS NULL)::int
               AS stocked_without_local_price
        FROM commerce.partner_stock_levels ps
        LEFT JOIN commerce.products p
          ON p.environment=ps.environment AND p.id=ps.product_id AND p.deleted_at IS NULL
       WHERE ps.environment='prod' AND ps.deleted_at IS NULL
    `);

    await query(client, 'Isolamento de ambiente nos vínculos', `
      SELECT issue,count(*)::int AS total FROM (
        SELECT 'tire_spec_product' AS issue
          FROM commerce.tire_specs ts JOIN commerce.products p ON p.id=ts.product_id
         WHERE ts.environment<>p.environment
        UNION ALL
        SELECT 'matriz_price_product'
          FROM commerce.matriz_product_prices pp JOIN commerce.products p ON p.id=pp.product_id
         WHERE pp.environment<>p.environment
        UNION ALL
        SELECT 'partner_stock_product'
          FROM commerce.partner_stock_levels ps JOIN commerce.products p ON p.id=ps.product_id
         WHERE ps.environment<>p.environment
        UNION ALL
        SELECT 'fitment_spec'
          FROM commerce.vehicle_fitments vf JOIN commerce.tire_specs ts ON ts.id=vf.tire_spec_id
         WHERE vf.environment<>ts.environment
        UNION ALL
        SELECT 'fitment_vehicle'
          FROM commerce.vehicle_fitments vf JOIN commerce.vehicle_models vm ON vm.id=vf.vehicle_model_id
         WHERE vf.environment<>vm.environment
      ) problems GROUP BY issue ORDER BY issue
    `);

    await query(client, 'Cobertura de auditoria das alterações de preço', `
      SELECT count(*)::int AS matrix_price_rows,
             count(*) FILTER (WHERE ae.entity_id IS NOT NULL)::int AS rows_with_change_audit,
             count(*) FILTER (WHERE pp.created_at>=(now()-interval '30 days')
                                AND ae.entity_id IS NULL)::int AS recent_rows_without_audit
        FROM commerce.matriz_product_prices pp
        JOIN commerce.products active_product
          ON active_product.environment=pp.environment
         AND active_product.id=pp.product_id AND active_product.deleted_at IS NULL
        LEFT JOIN LATERAL (
          SELECT e.entity_id FROM audit.events e
           WHERE e.environment=pp.environment::text
             AND e.entity_table='commerce.matriz_product_prices'
             AND e.entity_id=pp.id AND e.event_type='catalog_price_changed'
           LIMIT 1
        ) ae ON true
       WHERE pp.environment='prod'
    `);

    await query(client, 'Histórico de preço por produto', `
      SELECT p.product_code,count(*)::int AS price_rows,
             count(*) FILTER (WHERE pp.valid_from<=now()
               AND (pp.valid_until IS NULL OR pp.valid_until>now()))::int AS active_rows,
             count(*) FILTER (WHERE ae.entity_id IS NOT NULL)::int AS audited_rows,
             min(pp.created_at)::text AS first_created_at,
             max(pp.created_at)::text AS last_created_at
        FROM commerce.matriz_product_prices pp
        JOIN commerce.products p
          ON p.environment=pp.environment AND p.id=pp.product_id
        LEFT JOIN LATERAL (
          SELECT e.entity_id FROM audit.events e
           WHERE e.environment=pp.environment::text
             AND e.entity_table='commerce.matriz_product_prices'
             AND e.entity_id=pp.id AND e.event_type='catalog_price_changed'
           LIMIT 1
        ) ae ON true
       WHERE pp.environment='prod'
         AND p.deleted_at IS NULL
       GROUP BY p.id,p.product_code ORDER BY p.product_code
    `);

    await client.query('ROLLBACK');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

await main();
