import { describe, expect, it } from 'vitest';
import {
  pickupServicesSchema, pickupServicesTotalCents,
} from '../../../src/shared/pickup-services.js';

describe('serviços de retirada', () => {
  it('aceita cortesia zero e serviço cobrado em centavos', () => {
    const services = pickupServicesSchema.parse([
      { code: 'mounting', charge_mode: 'charged', amount_cents: 2000 },
      { code: 'valve_change', charge_mode: 'courtesy', amount_cents: 0 },
    ]);
    expect(pickupServicesTotalCents(services)).toBe(2000);
  });

  it('recusa cortesia cobrada, cobrança zero e código duplicado', () => {
    expect(pickupServicesSchema.safeParse([
      { code: 'mounting', charge_mode: 'courtesy', amount_cents: 100 },
    ]).success).toBe(false);
    expect(pickupServicesSchema.safeParse([
      { code: 'mounting', charge_mode: 'charged', amount_cents: 0 },
    ]).success).toBe(false);
    expect(pickupServicesSchema.safeParse([
      { code: 'mounting', charge_mode: 'courtesy', amount_cents: 0 },
      { code: 'mounting', charge_mode: 'courtesy', amount_cents: 0 },
    ]).success).toBe(false);
  });
});
