import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../../src/persistence/db.js', () => ({ pool: {} }));
vi.mock('../../../src/shared/config/env.js', () => ({ env: { FAREJADOR_ENV: 'test' } }));
import { getWholesalePriceReport } from '../../../src/admin/painel/queries-compras-precos.js';
describe('histórico central de preços por medida', () => {
  it('usa período local inclusivo, quantidade aceita e mesma variante no gráfico', async () => {
    const common = { supplier_id: 'supplier', measure: '90/90-18', brand: 'Technic', tire_condition: 'novo' };
    const query = vi.fn().mockResolvedValueOnce({ rows: [
      { ...common, vehicle_type: 'motorcycle', avg_cost: 80, qty_total: 10 },
      { ...common, vehicle_type: 'car', avg_cost: 200, qty_total: 4 },
    ] }).mockResolvedValueOnce({ rows: [
      { ...common, vehicle_type: 'motorcycle', purchase_id: 'moto', unit_cost: 80 },
      { ...common, vehicle_type: 'car', purchase_id: 'carro', unit_cost: 200 },
    ] });
    const result = await getWholesalePriceReport({ period: 'all', from: '2026-01-01', to: '2026-01-31', search: '90/90', supplierId: 'supplier' }, 'test', { query } as unknown as Pool) as any[];
    expect(result[0].history.map((r: any) => r.purchase_id)).toEqual(['moto']);
    expect(result[1].history.map((r: any) => r.purchase_id)).toEqual(['carro']);
    for (const [sql, params] of query.mock.calls) {
      expect(sql).toContain("p.environment=$1"); expect(sql).toContain("p.status='confirmed'");
      expect(sql).toContain('COALESCE(i.accepted_quantity,i.quantity)>0');
      expect(sql).toContain("AT TIME ZONE 'America/Sao_Paulo'"); expect(sql).toContain('$3::date+1');
      expect(params).toEqual(['test', '2026-01-01', '2026-01-31', 'supplier', '%90/90%']);
      expect(sql).not.toContain('interval');
    }
    expect(query.mock.calls[0][0]).toContain('sum(COALESCE(i.accepted_quantity,i.quantity)*i.unit_cost)');
    expect(result[0].history_truncated).toBe(false);
  });
  it('sinaliza limites em vez de apresentar o gráfico parcial como histórico completo', async () => {
    const row = { supplier_id: 's', measure: '90/90-18', brand: 'Technic', tire_condition: 'novo' };
    const query = vi.fn().mockResolvedValueOnce({ rows: Array.from({ length: 1001 }, () => row) })
      .mockResolvedValueOnce({ rows: Array.from({ length: 5001 }, () => row) });
    const result = await getWholesalePriceReport({ period: '90d' }, 'test', { query } as unknown as Pool) as any[];
    expect(result).toHaveLength(1000); expect(result[0].history).toHaveLength(5000);
    expect(result[0]).toMatchObject({ comparison_truncated: true, history_truncated: true });
    expect(query.mock.calls[1][0]).toContain('ORDER BY p.purchased_at DESC');
  });
});
