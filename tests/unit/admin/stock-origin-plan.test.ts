import { describe, expect, it } from 'vitest';
import { planOriginConfirmation, type OriginPlanRow } from '../../../src/admin/painel/stock-origin-plan.js';

describe('correção de origem com vendas ainda pendentes', () => {
  it('preserva a capacidade física e as opções de cada venda quando três separações disputam três peças', () => {
    const permutations = [[0,1,2],[0,2,1],[1,0,2],[1,2,0],[2,0,1],[2,1,0]];
    const places = [
      { group_id: 'conjunto', location_code: 'B2' },
      { group_id: 'avulso', location_code: 'B2' },
      { group_id: null, location_code: null },
    ];
    // Para cada venda, mantenha a sugestão inicial e varie as duas alternativas possíveis.
    for (let mask = 0; mask < 64; mask++) {
      const rows: OriginPlanRow[] = [];
      let bit = 0;
      for (let sale = 0; sale < 3; sale++) {
        for (let place = 0; place < 3; place++) {
          if (sale !== place && !(mask & (1 << bit++))) continue;
          rows.push({ origin_id: String(sale), quantity: 1, candidate_id: sale+'-'+place, ...places[place]!,
            capacity: 1, supply: 1, suggested_quantity: Number(sale === place) });
        }
      }
      for (const selected of rows.filter(row => row.origin_id === '0')) {
        const feasible = permutations.filter(positions => positions.every((place,sale) =>
          rows.some(row => row.candidate_id === sale+'-'+place)) && selected.candidate_id === '0-'+positions[0]);
        const plan = () => planOriginConfirmation(rows, '0', [{ candidate_id: selected.candidate_id, quantity: 1 }]);
        if (!feasible.length) {
          expect(plan).toThrow('stock_origin_changed');
          continue;
        }
        const deltas = new Map(plan().map(row => [row.candidate_id, row.delta]));
        const final = rows.map(row => ({ ...row, assigned: row.suggested_quantity + (deltas.get(row.candidate_id) ?? 0) }));
        expect(final.every(row => row.assigned === 0 || row.assigned === 1)).toBe(true);
        const taken = final.filter(row => row.assigned === 1).map(row => row.candidate_id);
        expect(feasible.some(positions => taken.length === 3 && positions.every((place,sale) => taken.includes(sale+'-'+place))))
          .toBe(true);
      }
    }
  });
});
