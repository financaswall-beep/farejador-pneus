function brandIdentity(expression: string): string {
  return `regexp_replace(regexp_replace(translate(lower(btrim(COALESCE(${expression},''))),
    'áàâãäéèêëíìîïóòôõöúùûüç','aaaaaeeeeiiiiooooouuuuc'),
    '[^a-z0-9]+','','g'),'^semmarca$','','g')`;
}

function measureIdentity(expression: string): string {
  return `regexp_replace(COALESCE(${expression},''),'[^0-9]+','','g')`;
}

/** Liga estoque local sem product_id somente quando a variante canônica é exata. */
export function catalogStockMatch(stockAlias: string): string {
  return `(${stockAlias}.product_id=p.id OR (
    ${stockAlias}.product_id IS NULL AND p.product_type='tire'
    AND COALESCE(${stockAlias}.item_type,'pneu')='pneu'
    AND ${measureIdentity(`${stockAlias}.tire_size`)}=${measureIdentity('ts.tire_size')}
    AND ${brandIdentity(`${stockAlias}.brand`)}=${brandIdentity('p.brand')}
    AND ${stockAlias}.tire_condition IS NOT DISTINCT FROM p.tire_condition
  ))`;
}

export const CATALOG_STOCK_MATCH = catalogStockMatch('psl');

export const CATALOG_WHERE = `p.environment=$1 AND p.deleted_at IS NULL
  AND ($2::text IS NULL OR p.product_code ILIKE $2 ESCAPE '\\'
    OR p.product_name ILIKE $2 ESCAPE '\\'
    OR COALESCE(p.brand,'') ILIKE $2 ESCAPE '\\'
    OR COALESCE(ts.tire_size,'') ILIKE $2 ESCAPE '\\')
  AND ($3::text IS NULL OR lower(p.brand)=lower($3))
  AND ($4::text='all' OR ($4='tire' AND p.product_type='tire')
    OR ($4='service' AND p.product_type='service'))
  AND ($5::text='all'
    OR ($5='stock' AND EXISTS (
      SELECT 1 FROM commerce.partner_stock_levels scoped_stock
       WHERE scoped_stock.environment=p.environment AND scoped_stock.unit_id=$6
         AND ${catalogStockMatch('scoped_stock')} AND scoped_stock.deleted_at IS NULL
         AND GREATEST(COALESCE(scoped_stock.quantity_on_hand,0)
           - COALESCE(scoped_stock.quantity_reserved,0),0)>0
    ))
    OR ($5='no_price' AND EXISTS (
      SELECT 1 FROM commerce.partner_stock_levels scoped_stock
       WHERE scoped_stock.environment=p.environment AND scoped_stock.unit_id=$6
         AND ${catalogStockMatch('scoped_stock')} AND scoped_stock.deleted_at IS NULL
    ) AND NOT EXISTS (
      SELECT 1 FROM commerce.partner_stock_levels priced_stock
       WHERE priced_stock.environment=p.environment AND priced_stock.unit_id=$6
         AND ${catalogStockMatch('priced_stock')} AND priced_stock.deleted_at IS NULL
         AND priced_stock.sale_price>0
    )))`;
