import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import {
  buscarCompatibilidadeMatriz,
  buscarProdutoMatriz,
  verificarEstoqueMatriz,
} from '../../../src/atendente-v2/matriz-product-search.js';

describe('tools do Bot usam a fonte oficial da Matriz', () => {
  it('filtra apenas_com_estoque depois de consultar o galpao', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [
        product('p-legado', 'SEM', '100/90-18'),
        product('p-oficial', 'COM', '100/80-18'),
      ] })
      .mockResolvedValueOnce({ rows: [
        { measure: '100/80-18', quantity_on_hand: 2, unit_cost: 15 },
      ] });
    const result = await buscarProdutoMatriz({ query } as unknown as PoolClient, {
      environment: 'prod', marca: 'Rinaldi', apenas_com_estoque: true, limit: 10,
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      product_id: 'p-oficial', total_stock_available: 2,
      stock_source: 'commerce.wholesale_stock', stock_block_reason: null,
    });
    expect(allSql(query)).not.toMatch(/product_full|stock_levels/i);
  });

  it('pode adiar o filtro para o roteamento consultar estoque de parceiro', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [
        product('p-parceiro', 'PAR', '100/90-18'),
        product('p-matriz', 'MAT', '100/80-18'),
      ] })
      .mockResolvedValueOnce({ rows: [
        { measure: '100/80-18', quantity_on_hand: 2, unit_cost: 15 },
      ] });
    const result = await buscarProdutoMatriz({ query } as unknown as PoolClient, {
      environment: 'prod', marca: 'Rinaldi', apenas_com_estoque: true, limit: 1,
    }, { deferAvailabilityFilter: true });
    expect(result.map((row) => row.product_id)).toEqual(['p-matriz', 'p-parceiro']);
  });

  it('verificar estoque responde pelo galpao e informa a origem', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [product('p1', 'P1', '90/90-18')] })
      .mockResolvedValueOnce({ rows: [{ measure: '90/90-18', quantity_on_hand: 3, unit_cost: 20 }] });
    const result = await verificarEstoqueMatriz({ query } as unknown as PoolClient, {
      environment: 'prod', product_code: 'P1',
    });
    expect(result).toMatchObject({
      product_id: 'p1', disponivel: true, quantidade_total: 3,
      stock_source: 'commerce.wholesale_stock',
    });
    expect(allSql(query)).not.toMatch(/stock_levels/i);
  });

  it('compatibilidade le fitments e aplica saldo oficial sem funcao legada', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{
        vehicle_model_id: 'v1', make: 'Honda', model: 'CG', variant: null,
        year_start: 2020, year_end: null, displacement_cc: 160,
      }] })
      .mockResolvedValueOnce({ rows: [{
        vehicle_model_id: 'v1', product_id: 'p1', product_name: 'Pneu', brand: 'Rinaldi',
        tire_size: '90/90-18', position: 'rear', is_oem: true, source: 'manufacturer',
        confidence_level: '1.00', current_price: '150.00',
      }] })
      .mockResolvedValueOnce({ rows: [{ measure: '90/90-18', quantity_on_hand: 4, unit_cost: 20 }] });
    const result = await buscarCompatibilidadeMatriz({ query } as unknown as PoolClient, {
      environment: 'prod', moto_modelo: 'CG', posicao_pneu: 'rear', limit: 10,
    });
    expect(result[0]?.produtos[0]).toMatchObject({
      product_id: 'p1', total_stock: 4, stock_source: 'commerce.wholesale_stock',
    });
    expect(allSql(query)).not.toMatch(/find_compatible_tires|stock_levels/i);
  });
});

function product(id: string, code: string, size: string) {
  return {
    product_id: id, product_code: code, product_name: code, product_type: 'tire', brand: 'Rinaldi',
    short_description: null, tire_size: size, tire_position: 'rear', intended_use: 'street',
    price_amount: '150.00', currency: 'BRL', price_type: 'regular',
  };
}

function allSql(query: ReturnType<typeof vi.fn>): string {
  return query.mock.calls.map(([sql]) => String(sql)).join('\n');
}
