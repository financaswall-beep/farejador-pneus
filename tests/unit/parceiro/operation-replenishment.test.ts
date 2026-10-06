import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PartnerContext } from '../../../src/parceiro/auth.js';

const query = vi.hoisted(() => vi.fn());
vi.mock('../../../src/parceiro/db.js', () => ({
  withPartnerContext: (_unit: string, action: (client: unknown) => unknown) => action({ query }),
}));
import { getPartnerReplenishment } from '../../../src/parceiro/operation-replenishment.js';

const ctx = { partnerUnitId: 'own-unit' } as PartnerContext;
beforeEach(() => query.mockReset());
describe('Resumo de reposição por medida', () => {
  it('agrupa marcas por medida sem somar a procura nem misturar saldos de medidas', async () => {
    const offer = (measure: string, brand: string, quantity_available: number, demand_count: number) =>
      ({ measure, brand, quantity_available, demand_count, tire_condition: 'meia_vida', vehicle_type: 'motorcycle' });
    query.mockResolvedValue({ rows: [offer('100/90-18', 'Michelin', 3, 4), offer('100/90-18', 'Pirelli', 7, 4), offer('90/90-18', 'Pirelli', 12, 3)] });
    const result = await getPartnerReplenishment(ctx);
    expect(result.replenishment).toEqual({ measure: '100/90-18', demand_count: 4, quantity_available: 10, period_days: 7,
      measures: [{ measure: '100/90-18', demand_count: 4, quantity_available: 10 }, { measure: '90/90-18', demand_count: 3, quantity_available: 12 }] });
    expect(result.rows).toHaveLength(3);
    expect(result.rows[0]).not.toHaveProperty('demand_count');
  });
  it('não fabrica oportunidade quando não há oferta elegível', async () => {
    query.mockResolvedValue({ rows: [] });
    expect(await getPartnerReplenishment(ctx)).toEqual({ replenishment: null, rows: [] });
  });
});
