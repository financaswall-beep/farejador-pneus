import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import type { SafeStockRow } from '../../parceiro/operation-stock.js';

type MatrizStockRow = SafeStockRow & { sale_price: null };

/**
 * Consulta operacional do galpao para a porta unificada.
 *
 * A resposta imita o contrato visual do parceiro, mas nao devolve custo e nao
 * oferece qualquer mutacao. O estoque oficial continua sendo exclusivamente
 * commerce.wholesale_stock.
 */
export async function getMatrizOperationStock(
  db: Pool = defaultPool,
): Promise<{ rows: MatrizStockRow[]; pending: { item_registrations: 0; stock_counts: 0 }; readonly: true }> {
  const result = await db.query<{
    id: string;
    measure: string;
    brand: string;
    tire_condition: 'meia_vida' | 'novo' | 'remold';
    quantity_on_hand: number;
    quantity_reserved: number;
    quantity_available: number;
    min_quantity: number | null;
    updated_at: string;
    tire_width_mm: number | null;
    tire_aspect_ratio: number | null;
    tire_rim_diameter: number | null;
  }>(
    `SELECT id,measure,brand,tire_condition,quantity_on_hand,quantity_reserved,
            GREATEST(quantity_on_hand-quantity_reserved,0)::int quantity_available,
            min_quantity,updated_at,tire_width_mm,tire_aspect_ratio,tire_rim_diameter
       FROM commerce.wholesale_stock
      WHERE environment=$1
      ORDER BY measure,brand,tire_condition`,
    [env.FAREJADOR_ENV],
  );
  const rows: MatrizStockRow[] = result.rows.map((row) => ({
    stock_id: row.id,
    local_sku: null,
    item_name: row.measure,
    item_type: 'pneu',
    tire_size: row.measure,
    tire_width_mm: row.tire_width_mm,
    tire_aspect_ratio: row.tire_aspect_ratio,
    tire_rim_diameter: row.tire_rim_diameter,
    brand: row.brand,
    quantity_on_hand: Number(row.quantity_on_hand),
    quantity_reserved: Number(row.quantity_reserved),
    quantity_available: Number(row.quantity_available),
    minimum_quantity: row.min_quantity == null ? null : Number(row.min_quantity),
    stock_status: Number(row.quantity_on_hand) <= 0
      ? 'out_of_stock'
      : (Number(row.quantity_available) <= 0
        ? 'reserved'
      : (row.min_quantity != null && Number(row.quantity_available) <= Number(row.min_quantity)
        ? 'low_stock' : 'in_stock')),
    tire_condition: row.tire_condition,
    shelf_location: null,
    tire_position: null,
    is_tracked: true,
    updated_at: row.updated_at,
    sale_price: null,
  }));
  return {
    rows,
    pending: { item_registrations: 0, stock_counts: 0 },
    readonly: true,
  };
}
