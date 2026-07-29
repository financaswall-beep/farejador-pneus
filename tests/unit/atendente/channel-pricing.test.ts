import { describe, expect, it, vi } from 'vitest';
import {
  applyMatrizPricesToProducts,
  applyPartnerPricesToProducts,
  repriceMatrizQuotedItems,
} from '../../../src/atendente-v2/channel-pricing.js';

function product() {
  return {
    product_id: '11111111-1111-4111-8111-111111111111',
    product_code: 'P-1',
    product_name: 'Pneu teste',
    product_type: 'tire',
    brand: 'Teste',
    short_description: null,
    tire_size: '90/90-18',
    tire_position: null,
    intended_use: null,
    price_amount: null,
    currency: null,
    price_type: null,
    total_stock_available: 5,
  };
}

describe('fronteira de preco Matriz x parceiros', () => {
  it('usa o Catalogo como verdade na oferta da Matriz', async () => {
    const item = product();
    const query = vi.fn().mockResolvedValue({
      rows: [{
        product_id: item.product_id,
        price_amount: '139.90',
        price_type: 'matriz',
        currency: 'BRL',
      }],
    });

    await applyMatrizPricesToProducts({ query } as never, 'prod', [item]);

    expect(item).toMatchObject({
      price_amount: '139.90',
      price_type: 'matriz',
      currency: 'BRL',
    });
    expect(String(query.mock.calls[0]?.[0])).toContain('commerce.matriz_current_prices');
  });

  it('mantem a oferta do parceiro no preco regular que ja existia', async () => {
    const item = product();
    const query = vi.fn().mockResolvedValue({
      rows: [{
        product_id: item.product_id,
        price_amount: '149.90',
        price_type: 'regular',
        currency: 'BRL',
      }],
    });

    const applied = await applyPartnerPricesToProducts(
      { query } as never,
      'prod',
      [item],
      new Map([[item.product_id, { available: 3 }]]),
    );

    expect(applied).toBe(true);
    expect(item).toMatchObject({
      total_stock_available: 3,
      price_amount: '149.90',
      price_type: 'regular',
    });
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain('commerce.product_prices');
    expect(sql).not.toContain('matriz_current_prices');
  });

  it('revalida o preco da Matriz antes de fechar e pede nova confirmacao se mudou', async () => {
    const item = product();
    const query = vi.fn().mockResolvedValue({
      rows: [{
        product_id: item.product_id,
        price_amount: '139.90',
        price_type: 'matriz',
        currency: 'BRL',
      }],
    });

    const result = await repriceMatrizQuotedItems(
      { query } as never,
      'prod',
      [{ product_id: item.product_id, quantidade: 1, preco_unitario: 129.9 }],
    );

    expect(result).toMatchObject({
      ok: false,
      response: { erro: 'preco_alterado', preco_alterado: true },
    });
  });
});
