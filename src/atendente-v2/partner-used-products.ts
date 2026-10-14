import type { PoolClient } from 'pg';
import type { BuscarProdutoInput, ProdutoOferta } from '../atendente/tools/commerce-tools.js';
import type { Environment } from '../shared/types/chatwoot.js';
import { env } from '../shared/config/env.js';

/** Candidatos do parceiro: saldo/preço só entram depois do roteamento normal. */
export async function partnerUsedProducts(client: PoolClient, input: BuscarProdutoInput): Promise<ProdutoOferta[]> {
  if (!env.PARTNER_STOCK_CONFIRMATION || (input.condicao_pneu && input.condicao_pneu !== 'meia_vida')) return [];
  const rows = await client.query<ProdutoOferta>(
    `SELECT p.id AS product_id,p.product_code,p.product_name,p.product_type,p.tire_condition,
            p.brand,p.short_description,ts.tire_size,ts.position AS tire_position,ts.intended_use,
            ts.vehicle_type,NULL::text AS price_amount,NULL::text AS currency,NULL::text AS price_type,
            0 AS total_stock_available,true AS partner_generic
       FROM commerce.products p JOIN commerce.tire_specs ts ON ts.environment=p.environment AND ts.product_id=p.id
      WHERE p.environment=$1 AND p.partner_generic AND p.deleted_at IS NULL
        AND ($2::text IS NULL OR commerce.catalog_measure_identity(ts.tire_size)=commerce.catalog_measure_identity($2))
        AND ($3::text IS NULL OR p.product_code=$3)
        AND EXISTS(SELECT 1 FROM commerce.partner_stock_levels s WHERE s.environment=p.environment
          AND s.product_id=p.id AND s.deleted_at IS NULL AND s.is_tracked
          AND s.quantity_on_hand-COALESCE(s.quantity_reserved,0)>0 AND s.sale_price>0)
      ORDER BY p.id`, [input.environment, input.medida_pneu ?? null, input.product_code ?? null],
  );
  return rows.rows.map(row => ({ ...row, brand: null, price_amount: null, total_stock_available: 0,
    requested_brand: input.marca?.trim() || null, marca_exige_confirmacao: Boolean(input.marca?.trim()),
    requested_tire_position: input.posicao_pneu === 'both' ? null : input.posicao_pneu ?? null,
    position_verification: input.posicao_pneu && input.posicao_pneu !== 'both' ? 'unregistered' : 'not_requested',
  }));
}

/** Não usa quantidade central para o SKU exclusivo do parceiro. A porta de confirmação revalida loja/quantidade. */
export async function partnerUsedStock(client: PoolClient, environment: Environment, productId?: string, productCode?: string) {
  if (!env.PARTNER_STOCK_CONFIRMATION || (!productId && !productCode)) return null;
  const result = await client.query<{product_id:string;product_code:string;product_name:string}>(
    `SELECT id AS product_id,product_code,product_name FROM commerce.products
      WHERE environment=$1 AND partner_generic AND deleted_at IS NULL
        AND ($2::uuid IS NULL OR id=$2) AND ($3::text IS NULL OR product_code=$3)`,
    [environment, productId ?? null, productCode ?? null],
  );
  return result.rows[0] ? { ...result.rows[0], encontrado:true, partner_generic:true,
    disponibilidade_confirmada:false, precisa_localizacao:true,
    orientacao:'Usado sem marca no cadastro do parceiro. Consulte buscar_produto com a medida e localização; só a resposta da loja confirma estoque e eventual marca pedida.' } : null;
}
