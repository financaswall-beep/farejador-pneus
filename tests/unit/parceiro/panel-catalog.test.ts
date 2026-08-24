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
      .mockResolvedValueOnce({ rows: [{ total: 42 }] })
      .mockResolvedValueOnce({ rows: [{ brand: 'Levorin' }, { brand: 'Pirelli' }] })
      .mockResolvedValueOnce({ rows: [{
        product_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        product_code: 'LEV-909018-MV',
        product_name: 'Pneu Levorin 90/90-18',
        product_type: 'tire', tire_condition: 'meia_vida', brand: 'Levorin',
        tire_size: '90/90-18', tire_position: 'rear', local_stock_rows: 1,
        local_quantity_on_hand: 10, local_quantity_reserved: 2,
        local_quantity_available: 8, local_sale_price_min: '89.00',
        local_sale_price_max: '89.00',
      }] });

    const result = await getPartnerPanelCatalog(context, {
      page: 2, limit: 20, q: '90/90', type: 'tire',
    });

    expect(mocks.withPartnerContext).toHaveBeenCalledWith(
      context.partnerUnitId, expect.any(Function),
    );
    expect(result).toEqual(expect.objectContaining({
      page: 2, limit: 20, total: 42, pages: 3, brands: ['Levorin', 'Pirelli'],
    }));
    expect(result.rows[0]).toEqual(expect.objectContaining({
      has_local_stock: true, local_quantity_on_hand: 10,
      local_quantity_reserved: 2, local_quantity_available: 8,
      local_sale_price_min: 89, local_sale_price_max: 89,
    }));
    expect(mocks.query.mock.calls[2]?.[1]).toEqual([
      'prod', '%90/90%', null, 'tire', context.unitId, 20, 20,
    ]);
    const sql = mocks.query.mock.calls.map((call) => String(call[0])).join('\n');
    expect(sql).toContain('psl.unit_id=$5');
    expect(sql).toContain('psl.environment=p.environment');
    expect(sql).not.toMatch(/average_cost|unit_cost|wholesale_stock|matriz_current_prices|gross_profit|internal_notes/i);
  });

  it('escapa curingas de busca e limita valores hostis do cliente', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ total: 0 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await getPartnerPanelCatalog(context, {
      page: -9, limit: 9_999, q: '100%_R17', type: 'all',
    });

    expect(result.page).toBe(1);
    expect(result.limit).toBe(100);
    expect(mocks.query.mock.calls[0]?.[1]).toEqual([
      'prod', '%100\\%\\_R17%', null, 'all',
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

  it('publica as duas rotas somente para dono até existir permissão canônica', () => {
    const route = readFileSync(resolve('src/parceiro/route-panel-catalog.ts'), 'utf8');
    expect(route).toContain('const ownerOnly = [requirePartnerAuth, requireOwner]');
    expect(route).toContain("'/parceiro/:slug/api/painel/catalogo'");
    expect(route).toContain("'/parceiro/:slug/api/painel/catalogo/:productId/compatibilidade'");
    expect(route.match(/preHandler: ownerOnly/g)).toHaveLength(2);
    expect(route).toContain("reply.header('Cache-Control', 'no-store')");
  });
});
