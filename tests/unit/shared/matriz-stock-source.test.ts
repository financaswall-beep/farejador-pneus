import { describe, expect, it } from 'vitest';
import {
  buildMatrizStockIndex,
  matrizStockForMeasure,
} from '../../../src/shared/matriz-stock-source.js';

describe('fonte oficial do estoque da Matriz', () => {
  it('libera somente medida única com saldo e custo positivo', () => {
    const index = buildMatrizStockIndex([
      { measure: '90/90-18', quantity_on_hand: 3, unit_cost: '20.50' },
    ]);

    expect(matrizStockForMeasure(index, '90/90R18')).toMatchObject({
      quantity_on_hand: 3,
      unit_cost: 20.5,
      rows_count: 1,
      sellable: true,
      block_reason: null,
    });
  });

  it.each([
    [[], 'walkin_measure_not_found'],
    [[{ measure: '90/90-18', quantity_on_hand: 0, unit_cost: 20 }], 'walkin_stock_insufficient'],
    [[{ measure: '90/90-18', quantity_on_hand: 2, unit_cost: 0 }], 'walkin_cost_missing'],
    [[
      { measure: '90/90-18', quantity_on_hand: 2, unit_cost: 20 },
      { measure: '90/90R18', quantity_on_hand: 3, unit_cost: 21 },
    ], 'walkin_stock_ambiguous'],
  ])('espelha a trava da Etapa 2: %s', (rows, reason) => {
    const index = buildMatrizStockIndex(rows);
    expect(matrizStockForMeasure(index, '90/90-18')).toMatchObject({
      sellable: false,
      block_reason: reason,
    });
  });

  it('não mistura prod/test porque o índice recebe somente as linhas do ambiente consultado', () => {
    const testIndex = buildMatrizStockIndex([
      { measure: '100/80-18', quantity_on_hand: 2, unit_cost: 15 },
    ]);
    const prodIndex = buildMatrizStockIndex([
      { measure: '100/80-18', quantity_on_hand: 99, unit_cost: 50 },
    ]);

    expect(matrizStockForMeasure(testIndex, '100/80-18').quantity_on_hand).toBe(2);
    expect(matrizStockForMeasure(prodIndex, '100/80-18').quantity_on_hand).toBe(99);
  });
});
