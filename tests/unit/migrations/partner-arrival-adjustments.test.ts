import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  resolve('db/migrations/0184_partner_arrival_item_adjustments.sql'), 'utf8',
);

describe('migration 0184 — acerto por pneu na chegada', () => {
  it('separa enviado, aceito e carga que ainda está no carro', () => {
    expect(sql).toContain('dispatched_total_amount');
    expect(sql).toContain('settled_total_amount');
    expect(sql).toContain('accepted_quantity');
    expect(sql).toContain('matrix_partner_cargo_lots');
    expect(sql).toContain('quantity_available');
    expect(sql).toContain('source_cargo_lot_id');
  });

  it('protege transição, ambiente, trilha e recebimento exato', () => {
    expect(sql).toContain('matrix_partner_arrival_operation_required');
    expect(sql).toContain('matrix_partner_transfer_transition_invalid');
    expect(sql).toContain('ops.enforce_environment_immutable()');
    expect(sql).toContain('matrix_partner_cargo_event_immutable');
    expect(sql).toContain('matrix_shipment_requires_arrival_adjustment');
    expect(sql).toContain('REVOKE ALL ON commerce.matrix_partner_cargo_lots');
  });
});
