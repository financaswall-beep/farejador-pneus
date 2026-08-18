import { describe, expect, it } from 'vitest';
import { partnerArrivalAdjustmentSchema } from '../../../src/admin/painel/route-schemas-partner-transfer.js';

const orderItemId = '10000000-0000-4000-8000-000000000001';
const cargoLotId = '20000000-0000-4000-8000-000000000002';

describe('contrato do acerto da chegada', () => {
  it('aceita recusa de apenas um e inclusão de carga anterior', () => {
    expect(partnerArrivalAdjustmentSchema.safeParse({
      items: [{ order_item_id: orderItemId, accepted_quantity: 29 }],
      cargo_additions: [{ cargo_lot_id: cargoLotId, quantity: 2, unit_price: 135.5 }],
      idempotency_key: 'arrival-proof-123',
    }).success).toBe(true);
  });

  it('recusa ids repetidos, fração de pneu e preço negativo', () => {
    expect(partnerArrivalAdjustmentSchema.safeParse({
      items: [
        { order_item_id: orderItemId, accepted_quantity: 29 },
        { order_item_id: orderItemId, accepted_quantity: 28 },
      ],
      idempotency_key: 'arrival-proof-123',
    }).success).toBe(false);
    expect(partnerArrivalAdjustmentSchema.safeParse({
      items: [{ order_item_id: orderItemId, accepted_quantity: 29.5 }],
      cargo_additions: [{ cargo_lot_id: cargoLotId, quantity: 1, unit_price: -1 }],
      idempotency_key: 'arrival-proof-123',
    }).success).toBe(false);
    expect(partnerArrivalAdjustmentSchema.safeParse({
      items: [{ order_item_id: orderItemId, accepted_quantity: 29 }],
      cargo_additions: [{ cargo_lot_id: cargoLotId, quantity: 1, unit_price: 10.999 }],
      idempotency_key: 'arrival-proof-123',
    }).success).toBe(false);
  });
});
