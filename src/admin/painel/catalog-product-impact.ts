import type { PoolClient } from 'pg';

type Db = Pick<PoolClient, 'query'>;
export type CatalogEnvironment = 'prod' | 'test';
export interface ProductIdentity {
  product_id: string; product_code: string; product_name: string; tire_size: string;
  brand: string | null; tire_condition: 'novo' | 'remold' | 'meia_vida';
  vehicle_type: 'car' | 'motorcycle' | null; archived: boolean;
}

const identityFields = `p.id product_id,p.product_code,p.product_name,p.brand,p.tire_condition,
  ts.tire_size,ts.vehicle_type,(p.deleted_at IS NOT NULL) archived`;
const catalogSource = `FROM commerce.products p JOIN commerce.tire_specs ts
  ON ts.environment=p.environment AND ts.product_id=p.id
  WHERE p.environment=$1 AND p.product_type='tire' AND NOT p.partner_generic`;

export async function findArchivedCatalogTires(db: Db, env: CatalogEnvironment, search: string) {
  const { rows } = await db.query<ProductIdentity>(`SELECT ${identityFields} ${catalogSource}
    AND p.deleted_at IS NOT NULL AND (strpos(lower(p.product_code),lower($2))>0
      OR strpos(lower(p.product_name),lower($2))>0 OR
      (commerce.catalog_measure_identity($2)<>'' AND commerce.catalog_measure_identity(ts.tire_size)=commerce.catalog_measure_identity($2)))
    ORDER BY p.deleted_at DESC,p.id LIMIT 50`, [env, search]);
  return rows;
}

export async function getProductIdentity(db: Db, env: CatalogEnvironment, id: string, lock = false) {
  const { rows } = await db.query<ProductIdentity>(`SELECT ${identityFields} ${catalogSource}
    AND p.id=$2 ${lock ? 'FOR UPDATE OF p,ts' : ''}`, [env, id]);
  if (!rows[0]) throw Error('catalog_product_not_found');
  return rows[0];
}

// Estoque, compras e atacado da Matriz usam a chave física mesmo sem FK para o SKU.
const physicalVariant = `i.environment=$1 AND commerce.catalog_measure_identity(i.measure)=commerce.catalog_measure_identity($2)
  AND commerce.catalog_brand_identity(i.brand)=commerce.catalog_brand_identity($3) AND i.tire_condition=$4`;
export async function getPhysicalImpact(db: Db, env: CatalogEnvironment, item: Pick<ProductIdentity,'tire_size'|'brand'|'tire_condition'>) {
  const { rows } = await db.query<{ saldo: number; reservado: number; compras: number; em_transito: number; vendas_atacado: number }>(
    `WITH medida AS (SELECT i.*,count(*) OVER() opcoes FROM commerce.wholesale_stock i
        WHERE i.environment=$1 AND commerce.catalog_measure_identity(i.measure)=commerce.catalog_measure_identity($2))
     SELECT s.saldo,s.reservado,c.compras,c.em_transito,
       (SELECT count(*)::int FROM commerce.wholesale_order_items i WHERE ${physicalVariant}) vendas_atacado
     FROM (SELECT coalesce(sum(i.quantity_on_hand),0)::int saldo,
       coalesce(sum(i.quantity_reserved),0)::int reservado FROM medida i WHERE i.tire_condition=$4 AND
       (commerce.catalog_brand_identity($3)='' OR commerce.catalog_brand_identity(i.brand)=commerce.catalog_brand_identity($3)
        OR (i.opcoes=1 AND commerce.catalog_brand_identity(i.brand)=''))) s
     CROSS JOIN (SELECT count(*)::int compras,
       count(*) FILTER (WHERE p.status<>'cancelled' AND NOT p.stock_applied)::int em_transito
       FROM commerce.wholesale_purchase_items i JOIN commerce.wholesale_purchases p
         ON p.environment=i.environment AND p.id=i.purchase_id WHERE ${physicalVariant}) c`,
    [env,item.tire_size,item.brand,item.tire_condition]);
  return rows[0]!;
}

export async function getProductImpact(db: Db, env: CatalogEnvironment, item: ProductIdentity) {
  const { rows } = await db.query<Record<string,number>>(`SELECT
    (SELECT count(*)::int FROM commerce.order_items i WHERE i.environment=$1 AND i.product_id=$2) vendas_varejo,
    (SELECT count(*)::int FROM commerce.order_items i JOIN commerce.orders o ON o.environment=i.environment AND o.id=i.order_id
      WHERE i.environment=$1 AND i.product_id=$2 AND (
        (o.fulfillment_mode='pickup' AND o.status='open' AND o.retrieved_at IS NULL)
        OR (o.fulfillment_mode='delivery' AND o.status IN ('open','confirmed','paid') AND o.delivery_status<>'delivered')
      )) pedidos_em_aberto,
    (SELECT count(*)::int FROM agent.cart_current_items i JOIN agent.cart_current c ON c.environment=i.environment AND c.id=i.cart_id
      WHERE i.environment=$1 AND i.product_id=$2 AND i.item_status<>'removed'
        AND c.cart_status IN ('proposed','confirmed','validated')) carrinhos_ativos,
    (SELECT count(*)::int FROM commerce.partner_stock_levels WHERE environment=$1 AND product_id=$2 AND deleted_at IS NULL
      AND (quantity_on_hand>0 OR quantity_reserved>0 OR (quantity_on_hand IS NULL AND stock_status IN ('in_stock','low_stock')))) estoques_parceiros,
    (SELECT count(*)::int FROM commerce.stock_levels WHERE environment=$1 AND product_id=$2
      AND (quantity_available>0 OR quantity_reserved>0)) estoques_varejo,
    (SELECT count(*)::int FROM commerce.partner_wholesale_request_items i JOIN commerce.partner_wholesale_requests r
      ON r.environment=i.environment AND r.id=i.request_id WHERE i.environment=$1 AND i.product_id=$2
      AND r.status IN ('requested','approved')) solicitacoes_atacado,
    (SELECT count(*)::int FROM commerce.partner_purchase_items i JOIN commerce.partner_purchases p
      ON p.environment=i.environment AND p.id=i.purchase_id WHERE i.environment=$1 AND i.product_id=$2
      AND p.receipt_status='pending' AND p.deleted_at IS NULL) recebimentos_parceiros,
    (SELECT count(*)::int FROM ops.milly_consultas WHERE environment=$1 AND product_id=$2
      AND ((state='pending' AND request_deadline>now()) OR (state IN ('approved','sending','published') AND valid_until>now()))) propostas_ativas,
    (SELECT count(*)::int FROM commerce.partner_stock_requests WHERE environment=$1
      AND routing->'items' @> jsonb_build_array(jsonb_build_object('product_id',($2::uuid)::text))
      AND ((status='pending' AND expires_at>now()) OR (status='confirmed' AND valid_until>now()))) confirmacoes_de_estoque,
    (SELECT count(*)::int FROM commerce.vehicle_fitments f JOIN commerce.tire_specs ts ON ts.environment=f.environment AND ts.id=f.tire_spec_id
      WHERE ts.environment=$1 AND ts.product_id=$2) vinculos,
    (SELECT count(*)::int FROM commerce.fitment_discoveries d JOIN commerce.tire_specs ts ON ts.environment=d.environment AND ts.id=d.tire_spec_id
      WHERE ts.environment=$1 AND ts.product_id=$2) descobertas,
    (SELECT count(*)::int FROM commerce.matriz_product_prices WHERE environment=$1 AND product_id=$2 AND valid_until IS NULL) precos_varejo,
    (SELECT count(*)::int FROM commerce.wholesale_product_prices WHERE environment=$1 AND product_id=$2 AND valid_until IS NULL) precos_atacado,
    (SELECT count(*)::int FROM commerce.catalog_market_references WHERE environment=$1 AND product_id=$2) referencias_de_mercado,
    (SELECT count(*)::int FROM commerce.matrix_catalog_photos WHERE environment=$1 AND product_id=$2 AND retired_at IS NULL) fotos,
    (SELECT count(*)::int FROM commerce.matrix_catalog_videos WHERE environment=$1 AND product_id=$2 AND retired_at IS NULL) videos`,
    [env,item.product_id]);
  return { ficha: rows[0]!, galpao: await getPhysicalImpact(db,env,item) };
}

export function archiveBlockers(impact: Awaited<ReturnType<typeof getProductImpact>>) {
  const keys = ['pedidos_em_aberto','carrinhos_ativos','estoques_parceiros','estoques_varejo',
    'solicitacoes_atacado','recebimentos_parceiros','propostas_ativas','confirmacoes_de_estoque'];
  return [...keys.filter(key => Number(impact.ficha[key])>0),
    ...(['saldo','reservado','em_transito'] as const).filter(key=>impact.galpao[key]>0)];
}
