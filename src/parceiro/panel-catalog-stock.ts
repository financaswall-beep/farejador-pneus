export type PartnerPanelCatalogStockEntry = {
  stock_id: string;
  local_sku: string | null;
  item_name: string;
  tire_condition: string | null;
  shelf_location: string | null;
  quantity_on_hand: number;
  quantity_reserved: number;
  quantity_available: number;
  sale_price: number | null;
};

function finiteNumber(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Expõe ao Catálogo somente o necessário para escolher e precificar a linha local. */
export function safeLocalStockEntries(value: unknown): PartnerPanelCatalogStockEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): PartnerPanelCatalogStockEntry[] => {
    if (!entry || typeof entry !== 'object') return [];
    const row = entry as Record<string, unknown>;
    if (typeof row.stock_id !== 'string' || typeof row.item_name !== 'string') return [];
    const salePrice = row.sale_price == null ? null : Number(row.sale_price);
    return [{
      stock_id: row.stock_id,
      local_sku: typeof row.local_sku === 'string' ? row.local_sku : null,
      item_name: row.item_name,
      tire_condition: typeof row.tire_condition === 'string' ? row.tire_condition : null,
      shelf_location: typeof row.shelf_location === 'string' ? row.shelf_location : null,
      quantity_on_hand: finiteNumber(row.quantity_on_hand),
      quantity_reserved: finiteNumber(row.quantity_reserved),
      quantity_available: finiteNumber(row.quantity_available),
      sale_price: Number.isFinite(salePrice) && Number(salePrice) > 0 ? salePrice : null,
    }];
  });
}
