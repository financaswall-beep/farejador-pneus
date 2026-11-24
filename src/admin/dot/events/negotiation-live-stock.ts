import type { PoolClient } from 'pg';
import type { Environment } from '../../../shared/types/chatwoot.js';
import { moneyCents } from '../../../shared/catalog-pricing.js';
import { buildMatrizStockIndex, matrizStockForMeasure } from '../../../shared/matriz-stock-source.js';
import { loadMatrizProductStockSpecs, type MatrizOfficialStockRow } from '../../../atendente-v2/matriz-stock-variants.js';
import type { ConsultaMilly, PedidoConsultaMilly } from '../../../atendente-v2/milly-negociacao.js';
import { readNegotiationRoutes } from '../logistics-read.js';

export async function commercialFacts(db: PoolClient, environment: Environment, terms: ConsultaMilly, lockStock=false) {
  // The owner can delegate only a sale by the main unit, for an active Matriz tire.
  const catalog = (await db.query<{price_cents:number | null}>(`SELECT
      CASE WHEN cp.currency='BRL' THEN round(cp.price_amount*100)::integer END price_cents
    FROM core.units u JOIN commerce.products p ON p.environment=u.environment AND p.id=$3
    LEFT JOIN commerce.matriz_current_prices cp ON cp.environment=p.environment AND cp.product_id=p.id
    WHERE u.environment=$1 AND u.id=$2 AND u.slug='main'
      AND p.product_type='tire' AND NOT p.partner_generic AND p.deleted_at IS NULL`,
  [environment, terms.unitId, terms.productId])).rows[0];
  if (!catalog) throw Error('produto_matriz_indisponivel');
  const [spec] = await loadMatrizProductStockSpecs(db, environment, [terms.productId]);
  if (!spec) throw Error('produto_matriz_indisponivel');
  const variants=await db.query<MatrizOfficialStockRow>(`SELECT measure,brand,tire_condition,quantity_on_hand,quantity_reserved,unit_cost,
    commerce.matriz_stock_inspection_unavailable(environment,id) AS quantity_inspection_unavailable
    FROM commerce.wholesale_stock WHERE environment=$1 AND commerce.wholesale_measure_key(measure)=commerce.wholesale_measure_key($2)
    ORDER BY measure,brand,tire_condition ${lockStock?'FOR SHARE':''}`,[environment,spec.tire_size]);
  const stock = matrizStockForMeasure(buildMatrizStockIndex(variants.rows),
    spec.tire_size, spec.brand, spec.tire_condition);
  // Use the exact stock identity resolved by the same Matriz rules as checkout.
  const flow = stock.rows_count === 1 ? (await db.query<{sold:number; incoming:number; total_cost_cents:number|null}>(`
    SELECT CASE WHEN $5::numeric>0 THEN round($5::numeric*$6::int*100)::float8 END total_cost_cents,
      (SELECT GREATEST(0, -COALESCE(sum(qty_delta),0))::int
      FROM commerce.wholesale_stock_movements
      WHERE environment=$1 AND measure=$2 AND brand IS NOT DISTINCT FROM $3 AND tire_condition=$4
        AND source IN ('venda_atacado','varejo','cancelamento_venda','cancelamento_varejo')
        AND created_at>=(((now() AT TIME ZONE 'America/Sao_Paulo')::date-29)::timestamp AT TIME ZONE 'America/Sao_Paulo')
        AND created_at<=now()) sold,
      (SELECT COALESCE(sum(GREATEST(i.quantity-COALESCE(i.accepted_quantity,0),0)),0)::int
       FROM commerce.wholesale_purchase_items i JOIN commerce.wholesale_purchases p
         ON p.environment=i.environment AND p.id=i.purchase_id
       WHERE i.environment=$1 AND p.status='pending' AND i.measure=$2
         AND COALESCE(i.brand,'Sem marca') IS NOT DISTINCT FROM $3 AND i.tire_condition=$4) incoming`,
  [environment,stock.measure,stock.brand,stock.tire_condition,stock.unit_cost,terms.quantity])).rows[0] : undefined;
  const routes = terms.fulfillmentMode === 'delivery' ? await readNegotiationRoutes(db,environment,terms.id) : null;
  return {
    medida:spec.tire_size, condicao:spec.tire_condition, marca:stock.brand,
    disponivel:stock.rows_count===1 ? stock.quantity_available : null,
    reservado:stock.rows_count===1 ? stock.quantity_reserved : null,
    estoque_vendavel:stock.sellable, motivo_estoque:stock.block_reason,
    custo_unitario_centavos:stock.rows_count===1 && stock.unit_cost && stock.unit_cost>0 ? moneyCents(stock.unit_cost) : null,
    custo_produtos_para_quantidade_centavos:flow?.total_cost_cents??null,
    tabela_atual_centavos:catalog.price_cents, vendas_liquidas_30_dias:flow?.sold ?? null,
    entradas_previstas:flow?.incoming ?? null, data_reposicao_confirmada:null,
    cobertura_estimada_dias:flow && flow.sold>0 ? Math.round(stock.quantity_available*300/flow.sold)/10 : null,
    rotas:routes, rota_compativel_confirmada:null, custo_incremental_entrega_centavos:terms.fulfillmentMode==='pickup'?0:null,
  };
}

export function permiteValor(terms:PedidoConsultaMilly, facts:Awaited<ReturnType<typeof commercialFacts>>,
  decision:'aceitar'|'contrapropor', cents:number) {
  if (!Number.isSafeInteger(cents) || cents<=0 || !Number.isSafeInteger(terms.quantity) || terms.quantity<1
    || facts.tabela_atual_centavos!==terms.catalogUnitCents || !facts.estoque_vendavel
    || facts.disponivel===null || facts.disponivel<terms.quantity || facts.custo_unitario_centavos===null
    || facts.custo_produtos_para_quantidade_centavos===null || facts.custo_incremental_entrega_centavos===null) return false;
  const merchandise=cents-terms.freightCents;
  return (decision==='aceitar'? cents===terms.offeredTotalCents : cents>terms.offeredTotalCents)
    && cents<=terms.catalogUnitCents*terms.quantity+terms.freightCents
    && merchandise>0 && merchandise%terms.quantity===0
    && cents>=facts.custo_produtos_para_quantidade_centavos+facts.custo_incremental_entrega_centavos;
}
