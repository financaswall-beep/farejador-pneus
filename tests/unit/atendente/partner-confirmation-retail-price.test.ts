import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../../src/parceiro/queries.js', () => ({ upsertPartnerCustomerWithClient: vi.fn() }));
import { requestPublicItems, refreshStockRequestPrices, type StockRequest } from '../../../src/atendente-v2/stock-confirmation-store.js';
import { materializePartnerOrder, type PartnerOrderRouting } from '../../../src/atendente-v2/fulfillment.js';
import { stockPriceChangedText } from '../../../src/atendente-v2/stock-confirmation-worker.js';

const routing = { unitId: 'unit-a', items: [{ product_id: 'product-a', partner_stock_id: 'stock-a', quantity: 2, unit_price: 149.9 }] } as PartnerOrderRouting;
const request = (): StockRequest => ({ id: 'request-a', environment: 'prod', unit_id: 'unit-a',
  items: [{ tire_size: '90/90-18', tire_condition: 'meia_vida', quantity: 2, price: 149.9 }],
  routing: { items: [{ product_id: 'product-a', quantity: 2 }] } } as StockRequest);

describe('preço local na confirmação de estoque', () => {
  it('informa a medida e o novo preço ao cliente, sem anunciar pedido fechado', () => {
    const text=stockPriceChangedText(request(),{itens:[{product_id:'product-a',preco_atual:189.9}]});
    expect(text).toContain('90/90-18: R$'); expect(text).toContain('189,90');
    expect(text).toContain('Confirma os novos valores?'); expect(text).toContain('ainda não foi fechado');
  });
  it('o cartão do parceiro lê o preço de venda atual em vez de repetir a cotação anterior', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: 'stock-a', tire_size: '90/90-18',
      tire_condition: 'meia_vida', sale_price: '179.90' }] });
    expect(await requestPublicItems({ query } as never, 'prod', routing)).toEqual([
      { tire_size: '90/90-18', tire_condition: 'meia_vida', quantity: 2, price: 179.9 },
    ]);
    expect(query.mock.calls[0]?.[1]).toEqual(['prod', 'unit-a', ['stock-a']]);
  });

  it('atualiza o preço antes de avisar uma confirmação atrasada', async () => {
    const query = vi.fn(async (sql: string) => sql.includes('FROM commerce.partner_stock_levels')
      ? { rows: [{ id: 'stock-a', item_name: 'Pneu', sale_price: '189.90' }] } : { rows: [] });
    const value = request();
    expect(await refreshStockRequestPrices({ query } as never, value)).toBe(true);
    expect(value.items[0]?.price).toBe(189.9);
    expect(query.mock.calls[1]?.[0]).toContain('WHERE environment=$1 AND id=$3');
  });

  it('não anuncia preço inexistente nem substitui pelo preço central', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const value = request();
    expect(await refreshStockRequestPrices({ query } as never, value)).toBe(false);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('a materialização recusa valor antigo antes de criar cliente, pedido ou reserva', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: 'stock-a', sale_price: '179.90' }] });
    await expect(materializePartnerOrder({ query } as unknown as PoolClient, { environment: 'prod', unitId: 'unit-a' } as never,
      { items: [{ partner_stock_id: 'stock-a', quantity: 2, unit_price: 149.9 }],
        customer_name: 'Pessoa fictícia', customer_phone: null, fulfillment_mode: 'pickup',
        delivery_address: null, freight_amount: 0, idempotency_key: 'fixture' })).rejects.toThrow('partner_sale_price_changed');
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toContain('FOR UPDATE');
  });
});
