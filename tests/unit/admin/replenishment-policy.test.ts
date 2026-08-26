import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { setWholesaleReplenishmentPolicy } from '../../../src/admin/painel/queries-replenishment-policy.js';

describe('política de reposição por medida e condição', () => {
  it('grava o mínimo do grupo e o espelha sem alterar saldo ou custo', async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [] }) } as any;

    await setWholesaleReplenishmentPolicy(db, {
      environment: 'test', measure: '110/70-13', tireCondition: 'meia_vida',
      minQuantity: 8, actorLabel: 'owner:teste',
    });

    expect(db.query).toHaveBeenCalledTimes(2);
    expect(db.query.mock.calls[0][0]).toContain('wholesale_replenishment_policies');
    expect(db.query.mock.calls[1][0]).toContain('SET min_quantity=$4');
    expect(db.query.mock.calls[1][0]).not.toMatch(/quantity_on_hand|unit_cost/);
    expect(db.query.mock.calls[1][1]).toEqual(['test', '110/70-13', 'meia_vida', 8]);
  });

  it('a migration usa o maior mínimo legado, nunca soma marcas', () => {
    const sql = readFileSync('db/migrations/0209_wholesale_replenishment_by_measure.sql', 'utf8');
    expect(sql).toContain('max(min_quantity)');
    expect(sql).not.toContain('sum(min_quantity)');
    expect(sql).toContain("tire_condition IN ('meia_vida','novo','remold')");
    expect(sql).toContain('PRIMARY KEY (environment, measure, tire_condition)');
  });
});
