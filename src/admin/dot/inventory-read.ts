import { env } from '../../shared/config/env.js';
import { getMatrixCatalogWithWholesale } from '../painel/queries-catalogo-wholesale.js';
import { readPage, pageRows, project, rejectFilters, type DotReadContext } from './read-model.js';

export function readDotMovements(ctx:DotReadContext) {
  return readPage(ctx,`SELECT id,vehicle_type,measure,brand,tire_condition,op,qty_before,qty_after,qty_delta,
    cost_before,cost_after,source,created_at FROM commerce.wholesale_stock_movements
    WHERE environment=$1 AND (created_at AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $2::date AND $3::date
      AND ($4::uuid IS NULL OR id=$4) AND ($5='' OR measure ILIKE '%'||$5||'%')`,
  'created_at DESC,id DESC','Movimentos físicos/custo da Matriz, incluindo contagens e baixas. Motivos livres e autores omitidos.');
}

export function readDotLots(ctx:DotReadContext,view:'lotes'|'movimentos'|'vendas') {
  rejectFilters(ctx,'medida');
  if(view==='movimentos')return readPage(ctx,`SELECT m.id,m.lot_id,m.source,m.quantity_delta,m.cost_delta,m.occurred_at,
    m.order_id FROM commerce.tire_lot_movements m WHERE m.environment=$1
    AND (m.occurred_at AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $2::date AND $3::date
    AND ($4::uuid IS NULL OR m.lot_id=$4) AND $5=''`,'occurred_at DESC,id DESC');
  if(view==='vendas')return readPage(ctx,`SELECT i.id,i.tire_lot_id,i.order_id,i.quantity,i.unit_cost,i.unit_price,i.line_total,
    i.line_profit,o.sold_at,o.status,o.payment_status FROM commerce.wholesale_order_items i
    JOIN commerce.wholesale_orders o ON o.environment=i.environment AND o.id=i.order_id
    WHERE i.environment=$1 AND i.tire_lot_id IS NOT NULL
      AND (o.sold_at AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $2::date AND $3::date
      AND ($4::uuid IS NULL OR i.tire_lot_id=$4) AND $5=''`,'sold_at DESC,id DESC');
  return readPage(ctx,`SELECT l.id,'LT-'||lpad(l.lot_number::text,6,'0') code,l.origin_type,l.purchase_id,
    l.ordered_quantity,l.accepted_quantity,l.quantity_on_hand,l.quantity_reserved,
    l.quantity_on_hand-l.quantity_reserved available,l.remaining_cost,l.allocated_cost,l.vehicle_type,l.created_at,
    p.supplier_id,p.status purchase_status FROM commerce.tire_lots l
    LEFT JOIN commerce.wholesale_purchases p ON p.environment=l.environment AND p.id=l.purchase_id
    WHERE l.environment=$1 AND ($4::uuid IS NULL OR l.id=$4) AND $5=''`,
  'created_at DESC,id DESC','Posição atual dos lotes; período se aplica às visões movimentos e vendas. Lotes não compõem o estoque oferecido pelo bot.');
}

export async function readDotCatalog(ctx:DotReadContext,view:'produtos'|'compatibilidade'|'historico_precos') {
  if(view==='compatibilidade')rejectFilters(ctx,'referencia');
  if(view==='historico_precos')rejectFilters(ctx,'medida');
  if(view==='compatibilidade')return readPage(ctx,`SELECT application_id AS id,make,model,position,display_measure,
    year_start,year_end,status,application_kind FROM commerce.vehicle_measure_applications WHERE environment=$1
    AND status='verified' AND $4::uuid IS NULL AND ($5='' OR display_measure ILIKE '%'||$5||'%')`,
  'make,model,position,id','Aplicações verificadas por medida, conforme o Catálogo. Não homologam automaticamente um produto específico.');
  if(view==='historico_precos')return readPage(ctx,`SELECT id,product_id,price_amount,currency,valid_from,valid_until,'varejo' channel
    FROM commerce.matriz_product_prices WHERE environment=$1 AND ($4::uuid IS NULL OR product_id=$4)
      AND (valid_from AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $2::date AND $3::date AND $5=''
    UNION ALL SELECT id,product_id,price_amount,currency,valid_from,valid_until,'atacado' channel
    FROM commerce.wholesale_product_prices WHERE environment=$1 AND ($4::uuid IS NULL OR product_id=$4)
      AND (valid_from AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $2::date AND $3::date AND $5=''`,
  'valid_from DESC,id DESC');
  const catalog=await getMatrixCatalogWithWholesale(env.FAREJADOR_ENV,ctx.db);
  const rows=catalog.rows.filter(value=>{
    const row=value as Record<string,unknown>;
    return (!ctx.input.referencia||row.product_id===ctx.input.referencia)
      && (!ctx.input.medida||String(row.tire_size??'').toLowerCase().includes(ctx.input.medida.toLowerCase()));
  }).map(row=>project(row,['product_id','product_code','product_name','product_type','brand','tire_size','vehicle_type',
    'tire_condition','tire_position','tire_construction','load_index','speed_rating','price_amount','wholesale_price_amount',
    'currency','compatibility_count','official_quantity_on_hand','official_quantity_reserved','total_stock_available',
    'official_unit_cost','last_purchase_cost','last_purchase_at','gross_profit','margin_percent','sellable','block_reason']));
  return {as_of:new Date().toISOString(),monetary_unit:'BRL',...pageRows(rows,ctx.input.pagina),
    warning:'Preços atuais da Matriz. O bot usa o preço próprio da loja escolhida; preço de atacado é uma oferta separada.'};
}
