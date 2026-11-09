import { z } from 'zod';
import type { PoolClient } from 'pg';
import { canonicalCatalogBrand } from './catalog-brand.js';
import { operationFingerprint, moneyCents } from './stage5-integrity.js';
import { prorateLotCents } from './lot-sale-schema.js';

const quantity = z.number().int().min(1).max(100000);
const common = { reason: z.string().trim().min(5).max(500) };
export const transferPlanSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('to_stock'), lot_id: z.string().uuid(), ...common,
    items: z.array(z.object({ product_id: z.string().uuid(), quantity }).strict()).min(1).max(50) }).strict(),
  z.object({ kind: z.literal('loss'), lot_id: z.string().uuid(), quantity, ...common }).strict(),
  z.object({ kind: z.literal('to_lot'), stock_id: z.string().uuid(), quantity,
    description: z.string().trim().min(1).max(200), ...common }).strict(),
]);
export type TransferInput = z.infer<typeof transferPlanSchema>;
export type Snapshot = Record<string, any>;
export interface TransferItem { product_id: string | null; quantity: number; cost: string;
  before: Snapshot | null; after: Snapshot; }
export interface TransferPlan { input: TransferInput; lot: Snapshot | null; quantity: number;
  cost: string; remaining_quantity: number; remaining_cost: string; items: TransferItem[]; fingerprint: string; }
export async function lockTireTransfers(client: PoolClient, environment: string) {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, ['tire-transfers:' + environment]);
}
const money = (cents: number) => (cents / 100).toFixed(2);
const micros = (value: string | number) => {
  const [whole, fraction = ''] = String(value).split('.');
  return BigInt(whole!) * 1000000n + BigInt(fraction.padEnd(6, '0').slice(0, 6));
};
export function stockCapital(stock: Snapshot): number {
  if (!Number.isFinite(Number(stock.unit_cost)) || Number(stock.unit_cost) < 0
    || !Number.isSafeInteger(stock.quantity_on_hand) || stock.quantity_on_hand < 0) throw Error('transfer_cost_precision');
  const cents = (BigInt(stock.quantity_on_hand) * micros(stock.unit_cost) + 5000n) / 10000n;
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('transfer_cost_precision');
  return Number(cents);
}
export function stockCostForCapital(cents: number, qty: number): string {
  if (!qty) return '0.000000';
  const unit = (BigInt(cents) * 10000n + BigInt(Math.floor(qty / 2))) / BigInt(qty);
  const cost = `${unit / 1000000n}.${String(unit % 1000000n).padStart(6, '0')}`;
  if (stockCapital({ quantity_on_hand: qty, unit_cost: cost }) !== cents) throw Error('transfer_cost_precision');
  return cost;
}
export async function stockSnapshot(client: PoolClient, environment: string, id: string): Promise<Snapshot | null> {
  const r = await client.query(`SELECT to_jsonb(s)-ARRAY['notes','created_at','updated_at'] snapshot FROM commerce.wholesale_stock s
    WHERE environment=$1 AND id=$2 FOR UPDATE OF s`, [environment, id]);
  return r.rows[0]?.snapshot ?? null;
}
export async function lotSnapshot(client: PoolClient, environment: string, id: string): Promise<Snapshot> {
  const r = await client.query(`SELECT to_jsonb(l)-ARRAY['origin_snapshot','created_at'] snapshot,p.status purchase_status FROM commerce.tire_lots l
    LEFT JOIN commerce.wholesale_purchases p ON p.environment=l.environment AND p.id=l.purchase_id
    WHERE l.environment=$1 AND l.id=$2 FOR UPDATE OF l`, [environment, id]);
  if (!r.rows[0] || r.rows[0].purchase_status === 'cancelled' || r.rows[0].snapshot.accepted_quantity === null) {
    throw Error('transfer_lot_unavailable');
  }
  return r.rows[0].snapshot;
}
export async function buildTransferPlan(client: PoolClient, environment: string, raw: TransferInput): Promise<TransferPlan> {
  await lockTireTransfers(client, environment);
  const input = transferPlanSchema.parse(raw);
  const items: TransferItem[] = [];
  const lot = input.kind === 'to_lot' ? null : await lotSnapshot(client, environment, input.lot_id);
  let total = 0, cost = 0;
  if (input.kind === 'to_lot') {
    const stock = await stockSnapshot(client, environment, input.stock_id);
    if (!stock || stock.quantity_on_hand - stock.quantity_reserved < input.quantity) throw Error('transfer_stock_insufficient');
    if (stock.unit_cost === null || Number(stock.unit_cost) < 0) throw Error('transfer_cost_missing');
    total = input.quantity;
    cost = stockCapital(stock) - stockCapital({ ...stock, quantity_on_hand: stock.quantity_on_hand - total });
    items.push({ product_id: null, quantity: total, cost: money(cost), before: stock,
      after: { ...stock, quantity_on_hand: stock.quantity_on_hand - total } });
  } else {
    total = input.kind === 'loss' ? input.quantity : input.items.reduce((n, i) => n + i.quantity, 0);
    if (total > 100000 || lot!.quantity_on_hand - lot!.quantity_reserved < total) throw Error('transfer_lot_insufficient');
    cost = prorateLotCents(moneyCents(Number(lot!.remaining_cost)), total, lot!.quantity_on_hand);
    if (input.kind === 'to_stock') {
      let remainingCost = cost, remainingQty = total;
      const identities = new Set<string>();
      for (const item of [...input.items].sort((a, b) => a.product_id.localeCompare(b.product_id))) {
        const product = await client.query(`SELECT p.id,p.brand,p.tire_condition,ts.tire_size measure,
          ts.vehicle_type,ts.width_mm,ts.aspect_ratio,ts.rim_diameter
          FROM commerce.products p JOIN commerce.tire_specs ts ON ts.environment=p.environment AND ts.product_id=p.id
          WHERE p.environment=$1 AND p.id=$2 AND p.deleted_at IS NULL AND NOT p.partner_generic
            AND p.product_type='tire' FOR SHARE OF p,ts`, [environment, item.product_id]);
        const p = product.rows[0];
        if (!p || !p.measure || !p.tire_condition || !p.vehicle_type) throw Error('transfer_product_invalid');
        if (lot!.vehicle_type && lot!.vehicle_type !== p.vehicle_type) throw Error('transfer_vehicle_mismatch');
        const brand = canonicalCatalogBrand(p.brand) ?? 'Sem marca';
        const key = [p.measure, brand, p.tire_condition].join('|');
        if (identities.has(key)) throw Error('transfer_duplicate_variant');
        identities.add(key);
        const stock = await client.query(`SELECT to_jsonb(s)-ARRAY['notes','created_at','updated_at'] snapshot FROM commerce.wholesale_stock s
          WHERE environment=$1 AND measure=$2 AND brand=$3 AND tire_condition=$4 FOR UPDATE OF s`,
        [environment, p.measure, brand, p.tire_condition]);
        const before = stock.rows[0]?.snapshot ?? null;
        if (before && (before.quantity_on_hand < 0 || before.unit_cost === null || Number(before.unit_cost) < 0)) throw Error('transfer_stock_review_required');
        if (before && before.vehicle_type && before.vehicle_type !== p.vehicle_type) throw Error('transfer_product_invalid');
        const allocated = prorateLotCents(remainingCost, item.quantity, remainingQty);
        remainingCost -= allocated; remainingQty -= item.quantity;
        const afterQty = (before?.quantity_on_hand ?? 0) + item.quantity;
        const capital = (before ? stockCapital(before) : 0) + allocated;
        items.push({ product_id: p.id, quantity: item.quantity, cost: money(allocated), before,
          after: { ...before, measure: p.measure, brand, tire_condition: p.tire_condition,
            vehicle_type: p.vehicle_type, quantity_on_hand: afterQty, quantity_reserved: before?.quantity_reserved ?? 0,
            unit_cost: stockCostForCapital(capital, afterQty), tire_width_mm: p.width_mm,
            tire_aspect_ratio: p.aspect_ratio, tire_rim_diameter: p.rim_diameter } });
      }
    }
  }
  if (cost > 999999999999) throw Error('transfer_cost_limit');
  const plan = { input, lot, quantity: total, cost: money(cost),
    remaining_quantity: lot ? lot.quantity_on_hand - total : total,
    remaining_cost: lot ? money(moneyCents(Number(lot.remaining_cost)) - cost) : money(cost), items };
  return { ...plan, fingerprint: operationFingerprint(plan) };
}
