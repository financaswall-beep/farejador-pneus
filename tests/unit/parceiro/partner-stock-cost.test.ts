import { describe, expect, it } from 'vitest';
import {
  addPurchaseStockCost,
  reversePurchaseStockCost,
} from '../../../src/parceiro/partner-stock-cost.js';

describe('matemática do custo médio do estoque parceiro', () => {
  it('calcula a média ponderada com seis casas sem ponto flutuante', () => {
    expect(addPurchaseStockCost({
      current_quantity: 10,
      current_average_cost: '100.000000',
      received_quantity: 10,
      purchase_unit_cost: '200.00',
    })).toEqual({ next_quantity: 20, next_average_cost: '150.000000' });

    expect(addPurchaseStockCost({
      current_quantity: 3,
      current_average_cost: '100.000000',
      received_quantity: 2,
      purchase_unit_cost: '100.01',
    })).toEqual({ next_quantity: 5, next_average_cost: '100.004000' });
  });

  it('recusa misturar entrada conhecida com saldo antigo sem custo', () => {
    expect(() => addPurchaseStockCost({
      current_quantity: 4,
      current_average_cost: null,
      received_quantity: 2,
      purchase_unit_cost: '120.00',
    })).toThrow('purchase_receipt_existing_cost_missing');
  });

  it('retira quantidade e valor da compra cancelada', () => {
    expect(reversePurchaseStockCost({
      current_quantity: 20,
      current_average_cost: '150.000000',
      reversed_quantity: 10,
      purchase_unit_cost: '200.00',
    })).toMatchObject({
      next_quantity: 10,
      next_average_cost: '100.000000',
      current_value: '3000.000000',
      reversed_value: '2000.000000',
      next_value_after_average_rounding: '1000.000000',
      rounding_residual: '0.000000',
    });
  });

  it('preserva a equação após venda intermediária', () => {
    const result = reversePurchaseStockCost({
      current_quantity: 15,
      current_average_cost: '150.000000',
      reversed_quantity: 10,
      purchase_unit_cost: '200.00',
    });
    expect(result).toMatchObject({
      next_quantity: 5,
      next_average_cost: '50.000000',
      current_value: '2250.000000',
      reversed_value: '2000.000000',
      next_value_after_average_rounding: '250.000000',
    });
  });

  it('bloqueia estorno que exigiria estoque com valor negativo', () => {
    expect(() => reversePurchaseStockCost({
      current_quantity: 12,
      current_average_cost: '150.000000',
      reversed_quantity: 10,
      purchase_unit_cost: '200.00',
    })).toThrow('purchase_stock_value_insufficient');
  });

  it('zera o valor ao cancelar todo o saldo e mantém o último custo informativo', () => {
    expect(reversePurchaseStockCost({
      current_quantity: 10,
      current_average_cost: '200.000000',
      reversed_quantity: 10,
      purchase_unit_cost: '200.00',
    })).toMatchObject({
      next_quantity: 0,
      next_average_cost: '200.000000',
      next_value_after_average_rounding: '0.000000',
    });
  });
});
