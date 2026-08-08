import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import {
  consumeMatrizGalpaoReservation,
  releaseMatrizGalpaoReservation,
  reserveMatrizGalpaoStock,
} from '../../../src/atendente-v2/matriz-stock-reservation.js';
import {
  buildMatrizStockIndex, matrizStockForMeasure,
} from '../../../src/shared/matriz-stock-source.js';

const movement = {
  measure: '90/90-18', brand: 'Pirelli', tire_condition: 'novo', qty: 1,
};

describe('reserva do galpao da matriz', () => {
  it('calcula disponivel como fisico menos reservado', () => {
    const state = matrizStockForMeasure(buildMatrizStockIndex([{
      measure: '90/90-18', brand: 'Pirelli', tire_condition: 'novo',
      quantity_on_hand: 5, quantity_reserved: 1, unit_cost: 100,
    }]), '90/90-18', 'Pirelli', 'novo');
    expect(state).toMatchObject({
      quantity_on_hand: 5, quantity_reserved: 1, quantity_available: 4, sellable: true,
    });
  });

  it('reserva sem baixar o fisico e grava trilha', async () => {
    const calls: string[] = [];
    const query = vi.fn(async (sql: string) => {
      calls.push(sql);
      if (sql.includes('event_type=$3')) return { rows: [] };
      if (sql.includes('FROM commerce.tire_specs')) return { rows: [{
        product_id: 'p1', tire_size: '90/90-18', brand: 'Pirelli', tire_condition: 'novo',
      }] };
      if (sql.includes('FROM commerce.wholesale_stock') && sql.includes('FOR UPDATE')) {
        return { rows: [{ measure: '90/90-18', brand: 'Pirelli', tire_condition: 'novo',
          quantity_on_hand: 5, quantity_reserved: 0, unit_cost: 100 }] };
      }
      if (sql.includes('SET quantity_reserved=quantity_reserved+$5')) {
        return { rows: [{ quantity_reserved: 1 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    await reserveMatrizGalpaoStock(
      { query } as unknown as PoolClient, 'test', 'order-1',
      [{ productId: 'p1', quantity: 1 }], true,
    );
    expect(calls.some((sql) => sql.includes('quantity_on_hand-quantity_reserved >= $5'))).toBe(true);
    expect(calls.some((sql) => sql.includes("'matriz_galpao_reserved'"))).toBe(true);
    expect(calls.some((sql) => sql.includes('SET quantity_on_hand=quantity_on_hand-'))).toBe(false);
  });

  it('na realizacao converte reserva em baixa fisica', async () => {
    const calls: string[] = [];
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push(sql);
      if (sql.includes('event_type=$3')) return { rows: [] };
      if (sql.includes("event_type='matriz_galpao_reserved'")) {
        return { rows: [{ payload_after: { movements: [movement] } }] };
      }
      if (sql.includes('SET quantity_on_hand=quantity_on_hand-$5')) {
        expect(params?.[4]).toBe(1);
        return { rows: [{ quantity_on_hand: 4, quantity_reserved: 0 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    await consumeMatrizGalpaoReservation(
      { query } as unknown as PoolClient, 'test', 'order-1',
    );
    expect(calls.some((sql) => sql.includes('quantity_reserved=quantity_reserved-$5'))).toBe(true);
    expect(calls.some((sql) => sql.includes("'matriz_galpao_decrement'"))).toBe(true);
  });

  it('no cancelamento libera a reserva sem devolver fisico', async () => {
    const calls: string[] = [];
    const query = vi.fn(async (sql: string) => {
      calls.push(sql);
      if (sql.includes('event_type=$3')) return { rows: [] };
      if (sql.includes("event_type='matriz_galpao_reserved'")) {
        return { rows: [{ payload_after: { movements: [movement] } }] };
      }
      if (sql.includes('SET quantity_reserved=quantity_reserved-$5')) {
        return { rows: [{ quantity_reserved: 0 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    await releaseMatrizGalpaoReservation(
      { query } as unknown as PoolClient, 'test', 'order-1',
    );
    expect(calls.some((sql) => sql.includes("'matriz_galpao_reservation_released'"))).toBe(true);
    expect(calls.some((sql) => sql.includes('quantity_on_hand=quantity_on_hand+'))).toBe(false);
  });
});
