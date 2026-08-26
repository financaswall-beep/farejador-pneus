import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn(), withPartnerContext: vi.fn() }));

vi.mock('../../../src/parceiro/db.js', () => ({
  withPartnerContext: mocks.withPartnerContext,
}));

import type { PartnerContext } from '../../../src/parceiro/auth.js';
import {
  getPartnerPanelCatalog,
  getPartnerPanelCatalogCompatibility,
  PartnerPanelCatalogNotFoundError,
} from '../../../src/parceiro/panel-catalog.js';

const context: PartnerContext = {
  environment: 'prod',
  partnerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  partnerUnitId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  unitId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  slug: 'unidade-teste',
  partnerName: 'Parceiro',
  unitName: 'Unidade teste',
  role: 'owner',
  tokenId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
};

describe('catálogo seguro do painel parceiro', () => {
  beforeEach(() => {
    mocks.query.mockReset();
    mocks.withPartnerContext.mockReset();
    mocks.withPartnerContext.mockImplementation(async (_id: string, work: Function) => (
      work({ query: mocks.query })
    ));
  });

  it('pagina o catálogo e expõe apenas preço e saldo da própria unidade', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{
        products: 50, brands: 2, with_local_stock: 4,
        without_local_price: 1, local_units_available: 18,
      }] })
      .mockResolvedValueOnce({ rows: [{ total: 42 }] })
      .mockResolvedValueOnce({ rows: [
        { brand: 'Levorin', product_count: 20 },
        { brand: 'Pirelli', product_count: 30 },
      ] })
      .mockResolvedValueOnce({ rows: [{
        product_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        product_code: 'LEV-909018-MV',
        product_name: 'Pneu Levorin 90/90-18',
        product_type: 'tire', tire_condition: 'meia_vida', brand: 'Levorin',
        tire_size: '90/90-18', tire_position: 'rear', local_stock_rows: 1,
        local_quantity_on_hand: 10, local_quantity_reserved: 2,
        local_quantity_available: 8, local_sale_price_min: '89.00',
        local_sale_price_max: '89.00', compatibility_count: 3,
        local_stock_entries: [{
          stock_id: '99999999-9999-4999-8999-999999999999',
          local_sku: 'LEV-01', item_name: 'Pneu Levorin 90/90-18',
          supplier_name: 'Fornecedor A', tire_condition: 'meia_vida',
          shelf_location: 'A-01', quantity_on_hand: '10', quantity_reserved: '2',
          quantity_available: '8', sale_price: '89.00',
          average_cost: '42.00',
        }],
      }] });

    const result = await getPartnerPanelCatalog(context, {
      page: 2, limit: 20, q: '90/90', type: 'tire',
    });

    expect(mocks.withPartnerContext).toHaveBeenCalledWith(
      context.partnerUnitId, expect.any(Function),
    );
    expect(result).toEqual(expect.objectContaining({
      page: 2, limit: 20, total: 42, pages: 3, brands: ['Levorin', 'Pirelli'],
      brand_counts: { Levorin: 20, Pirelli: 30 },
      summary: {
        products: 50, brands: 2, with_local_stock: 4,
        without_local_price: 1, local_units_available: 18,
      },
    }));
    expect(result.rows[0]).toEqual(expect.objectContaining({
      has_local_stock: true, local_quantity_on_hand: 10,
      local_quantity_reserved: 2, local_quantity_available: 8,
      local_sale_price_min: 89, local_sale_price_max: 89,
      compatibility_count: 3,
      local_stock_entries: [{
        stock_id: '99999999-9999-4999-8999-999999999999',
        local_sku: 'LEV-01', item_name: 'Pneu Levorin 90/90-18',
        tire_condition: 'meia_vida',
        shelf_location: 'A-01', quantity_on_hand: 10, quantity_reserved: 2,
        quantity_available: 8, sale_price: 89,
      }],
    }));
    expect(mocks.query.mock.calls[3]?.[1]).toEqual([
      'prod', '%90/90%', null, 'tire', 'all', context.unitId, 20, 20,
    ]);
    const sql = mocks.query.mock.calls.map((call) => String(call[0])).join('\n');
    expect(sql).toContain('psl.unit_id=$6');
    expect(sql).toContain('psl.environment=p.environment');
    expect(sql).toContain('psl.product_id IS NULL');
    expect(sql).toContain('psl.tire_condition IS NOT DISTINCT FROM p.tire_condition');
    expect(sql).not.toMatch(/supplier_name|average_cost|unit_cost|wholesale_stock|matriz_current_prices|gross_profit|internal_notes/i);
  });

  it('não entrega linhas comerciais detalhadas ao funcionário de estoque', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{
        products: 1, brands: 1, with_local_stock: 1,
        without_local_price: 0, local_units_available: 8,
      }] })
      .mockResolvedValueOnce({ rows: [{ total: 1 }] })
      .mockResolvedValueOnce({ rows: [{ brand: 'Levorin', product_count: 1 }] })
      .mockResolvedValueOnce({ rows: [{
        product_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        product_code: 'LEV-909018-MV', product_name: 'Pneu Levorin',
        product_type: 'tire', tire_condition: 'meia_vida', brand: 'Levorin',
        tire_size: '90/90-18', tire_position: 'rear', local_stock_rows: 1,
        local_quantity_on_hand: 10, local_quantity_reserved: 2,
        local_quantity_available: 8, local_sale_price_min: '89.00',
        local_sale_price_max: '89.00', compatibility_count: 3,
        local_stock_entries: [{ stock_id: 'stock-a', item_name: 'Lote A', sale_price: '89' }],
      }] });

    const result = await getPartnerPanelCatalog({ ...context, role: 'funcionario' });
    expect(result.rows[0]).toMatchObject({
      local_quantity_available: 8,
      local_sale_price_min: 89,
      local_stock_entries: [],
    });
  });

  it('escapa curingas de busca e limita valores hostis do cliente', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{
        products: 0, brands: 0, with_local_stock: 0,
        without_local_price: 0, local_units_available: 0,
      }] })
      .mockResolvedValueOnce({ rows: [{ total: 0 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await getPartnerPanelCatalog(context, {
      page: -9, limit: 9_999, q: '100%_R17', type: 'all',
    });

    expect(result.page).toBe(1);
    expect(result.limit).toBe(100);
    expect(mocks.query.mock.calls[1]?.[1]).toEqual([
      'prod', '%100\\%\\_R17%', null, 'all', 'all', context.unitId,
    ]);
  });

  it('retorna compatibilidade sem proveniência interna ou dados financeiros', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{
        product_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        product_code: 'LEV-909018-MV', product_name: 'Pneu Levorin',
        brand: 'Levorin', tire_condition: 'meia_vida', tire_size: '90/90-18',
      }] })
      .mockResolvedValueOnce({ rows: [{
        vehicle_model_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        make: 'Honda', model: 'CG 150 Titan', variant: null,
        year_start: 2009, year_end: 2015, position: 'rear', is_oem: true,
      }] });

    const result = await getPartnerPanelCatalogCompatibility(
      context, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    );

    expect(result.summary).toEqual({ models: 1, fitments: 1 });
    expect(result.rows[0]).toEqual({
      vehicle_model_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      make: 'Honda', model: 'CG 150 Titan', variant: null,
      year_start: 2009, year_end: 2015, position: 'rear', is_oem: true,
    });
    const sql = String(mocks.query.mock.calls[1]?.[0]);
    expect(sql).toContain('commerce.vehicle_fitments');
    expect(sql).toContain('commerce.vehicle_models');
    expect(sql).not.toMatch(/confidence_level|vf\.source|evidence|notes|cost|price/i);
  });

  it('falha fechado quando o produto não existe no ambiente', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });
    await expect(getPartnerPanelCatalogCompatibility(
      context, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    )).rejects.toBeInstanceOf(PartnerPanelCatalogNotFoundError);
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });

  it('publica as duas rotas para quem possui a permissão explícita de catálogo', () => {
    const route = readFileSync(resolve('src/parceiro/route-panel-catalog.ts'), 'utf8');
    expect(route).toContain("const catalogScreen = [requirePartnerAuth, requireScreen('catalogo')]");
    expect(route).toContain("'/parceiro/:slug/api/painel/catalogo'");
    expect(route).toContain("'/parceiro/:slug/api/painel/catalogo/:productId/compatibilidade'");
    expect(route.match(/preHandler: catalogScreen/g)).toHaveLength(2);
    expect(route).toContain("reply.header('Cache-Control', 'no-store')");
  });
});
