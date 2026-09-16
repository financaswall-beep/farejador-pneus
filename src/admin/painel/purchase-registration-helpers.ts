import type { PoolClient } from 'pg';
import type { RegisterWholesalePurchaseInput } from './queries-fornecedores-registro.js';
import type { PurchaseItemInput } from './purchase-brand.js';
import { normalizeBrazilianPhone } from '../../shared/phone.js';
import { addWholesaleStockEntry } from './queries-galpao.js';
import { setGalpaoMovContext } from './queries-galpao-movimentos.js';
import { canonicalCatalogBrand } from './catalog-brand.js';
import { moneyCents } from './stage5-integrity.js';
export type AllocatedPurchaseItem = PurchaseItemInput & {
  id?: string;
  ordered_quantity?: number;
  accepted_quantity?: number | null;
  allocated_cost: number;
};

export async function resolveSupplier(
  client: PoolClient,
  environment: 'prod' | 'test',
  input: RegisterWholesalePurchaseInput,
): Promise<{ id: string; name: string }> {
  if (input.supplier_id) {
    const found = await client.query<{ id: string; name: string }>(
      `SELECT id,name FROM commerce.wholesale_suppliers
        WHERE id=$1 AND environment=$2 AND deleted_at IS NULL FOR SHARE`,
      [input.supplier_id, environment]);
    if (!found.rows[0]) throw new Error('supplier_not_found');
    return found.rows[0];
  }
  const name = input.new_supplier?.name.trim();
  if (!name) throw new Error('supplier_required');
  const created = await client.query<{ id: string; name: string }>(
    `INSERT INTO commerce.wholesale_suppliers (environment,name,phone,document)
     VALUES ($1,$2,$3,$4) RETURNING id,name`,
    [environment, name, input.new_supplier?.phone
      ? normalizeBrazilianPhone(input.new_supplier.phone) : null,
     input.new_supplier?.document?.trim() || null]);
  return created.rows[0]!;
}

export async function applyPurchaseStock(
  client: PoolClient,
  environment: 'prod' | 'test',
  purchaseId: string,
  supplierName: string,
  items: AllocatedPurchaseItem[],
): Promise<void> {
  await setGalpaoMovContext(client, { source: 'compra', reason: supplierName, ref: purchaseId });
  const consolidated = new Map<string, {
    measure: string; quantity: number; valueCents: number; brand: string;
    tire_condition: PurchaseItemInput['tire_condition']; vehicle_type?: PurchaseItemInput['vehicle_type'];
  }>();
  for (const item of items) {
    const quantity = item.accepted_quantity ?? item.quantity;
    if (quantity <= 0) continue;
    const brand = canonicalCatalogBrand(item.brand) ?? 'Sem marca';
    const key = `${item.measure}\u0000${brand}\u0000${item.tire_condition}`;
    const current = consolidated.get(key) ?? {
      measure: item.measure, quantity: 0, valueCents: 0, brand,
      tire_condition: item.tire_condition, vehicle_type: item.vehicle_type,
    };
    if (current.vehicle_type && item.vehicle_type && current.vehicle_type !== item.vehicle_type) throw new Error('operation_vehicle_type_conflict');
    current.vehicle_type ??= item.vehicle_type;
    current.quantity += quantity;
    current.valueCents += moneyCents(item.allocated_cost);
    consolidated.set(key, current);
  }
  for (const [, item] of [...consolidated].sort(([a], [b]) => a.localeCompare(b))) {
    await addWholesaleStockEntry({ measure: item.measure, brand: item.brand,
      tire_condition: item.tire_condition, vehicle_type: item.vehicle_type, quantity_in: item.quantity,
      unit_cost: item.valueCents / item.quantity / 100, environment,
      actor_label: `compra:${purchaseId}` }, client);
  }
}
