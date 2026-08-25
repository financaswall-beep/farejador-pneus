import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

let createCatalogProductFromStock:
  typeof import('../../../src/admin/painel/queries-catalogo-create.js').createCatalogProductFromStock;
let createCatalogProduct:
  typeof import('../../../src/admin/painel/queries-catalogo-create.js').createCatalogProduct;

beforeAll(async () => {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    FAREJADOR_ENV: 'test',
    DATABASE_URL: 'postgres://test',
    CHATWOOT_HMAC_SECRET: 'test-secret',
    ADMIN_AUTH_TOKEN: 'emergency-token',
  });
  ({ createCatalogProductFromStock, createCatalogProduct }
    = await import('../../../src/admin/painel/queries-catalogo-create.js'));
});

describe('cadastro inicial antes da compra', () => {
  it('cria produto, ficha e preço sem inventar estoque nem financeiro', async () => {
    const query = vi.fn(async (sql: string) => {
      if (['BEGIN', 'COMMIT'].includes(sql)) return { rows: [] };
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (sql.includes('JOIN commerce.tire_specs')) return { rows: [] };
      if (sql.includes('SELECT id FROM commerce.products')) return { rows: [] };
      if (sql.includes('INSERT INTO commerce.products')) return { rows: [{ id: 'produto-novo' }] };
      if (sql.includes('INSERT INTO commerce.tire_specs')) return { rows: [{ id: 'spec-nova' }] };
      if (sql.includes('INSERT INTO commerce.vehicle_fitments')) return { rows: [], rowCount: 3 };
      if (sql.includes('INSERT INTO commerce.matriz_product_prices')) {
        return { rows: [{ id: 'preco-1' }] };
      }
      if (sql.includes('INSERT INTO audit.events')) return { rows: [] };
      throw new Error(`consulta inesperada: ${sql}`);
    });
    const { pool } = fakePool(query);

    await expect(createCatalogProduct({
      measure: '90 / 90 R18', brand: 'Levorin', tireCondition: 'meia_vida',
      productCode: 'lev-909018-mv', productName: 'Pneu Levorin',
      priceAmount: 45, priceReason: 'Preço inicial', actorLabel: 'Dono',
      environment: 'test',
    }, pool)).resolves.toEqual({
      product_id: 'produto-novo', product_code: 'LEV-909018-MV',
      product_name: 'Pneu Levorin 90/90-18', brand: 'Levorin',
      tire_condition: 'meia_vida', tire_size: '90/90-18', price_amount: 45,
    });

    const sql = query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).not.toContain('commerce.wholesale_stock');
    expect(sql).not.toContain('finance.');
    expect(sql).not.toContain('commerce.orders');
    expect(sql).toContain('commerce.matriz_product_prices');
    const productAudit = query.mock.calls.find(([statement]) =>
      String(statement).includes("'catalog_product_created'"));
    expect(String(productAudit?.[1]?.[3])).toContain('"stock":false');
  });

  it('recusa preço fracionado além de centavos antes de abrir transação', async () => {
    const { pool } = fakePool(vi.fn());
    await expect(createCatalogProduct({
      measure: '90/90-18', brand: 'Levorin', tireCondition: 'meia_vida',
      productCode: 'LEV-1', productName: 'Levorin', priceAmount: 45.001,
      actorLabel: 'Dono', environment: 'test',
    }, pool)).rejects.toThrow('catalog_price_invalid');
    expect(pool.connect).not.toHaveBeenCalled();
  });
});

function fakePool(query: ReturnType<typeof vi.fn>): {
  pool: Pool;
  release: ReturnType<typeof vi.fn>;
} {
  const release = vi.fn();
  return {
    pool: { connect: vi.fn().mockResolvedValue({ query, release }) } as unknown as Pool,
    release,
  };
}

describe('cadastro de produto a partir do estoque', () => {
  it('cria produto e ficha tecnica sem alterar o estoque', async () => {
    const query = vi.fn(async (sql: string) => {
      if (['BEGIN', 'COMMIT'].includes(sql)) return { rows: [] };
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (sql.includes('FROM commerce.wholesale_stock')) return {
        rows: [{
          measure: '90/90-18',
          brand: 'Metzeler',
          tire_width_mm: 90,
          tire_aspect_ratio: 90,
          tire_rim_diameter: 18,
        }],
      };
      if (sql.includes('JOIN commerce.tire_specs')) return { rows: [] };
      if (sql.includes('SELECT id FROM commerce.products')) return { rows: [] };
      if (sql.includes('INSERT INTO commerce.products')) return { rows: [{ id: 'produto-1' }] };
      if (sql.includes('INSERT INTO commerce.tire_specs')) {
        return { rows: [{ id: 'spec-1' }] };
      }
      if (sql.includes('INSERT INTO commerce.vehicle_fitments')) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('INSERT INTO audit.events')) return { rows: [] };
      throw new Error(`consulta inesperada: ${sql}`);
    });
    const { pool, release } = fakePool(query);

    await expect(createCatalogProductFromStock({
      measure: '90/90-18',
      brand: 'Metzeler',
      productCode: 'met-909018',
      productName: '  Pneu   Metzeler 90/90-18 ',
      actorLabel: 'Admin',
      environment: 'test',
    }, pool)).resolves.toEqual({
      product_id: 'produto-1',
      product_code: 'MET-909018',
      product_name: 'Pneu Metzeler 90/90-18',
      brand: 'Metzeler',
      tire_condition: 'meia_vida',
      tire_size: '90/90-18',
    });

    const stockSql = query.mock.calls
      .map(([sql]) => String(sql))
      .find((sql) => sql.includes('commerce.wholesale_stock'));
    expect(stockSql?.trimStart()).toMatch(/^SELECT /);
    expect(query).toHaveBeenCalledWith('COMMIT');
    expect(query).not.toHaveBeenCalledWith('ROLLBACK');
    expect(release).toHaveBeenCalledOnce();
  });

  it('recusa duplicar uma medida e marca que ja possui produto', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (sql.includes('FROM commerce.wholesale_stock')) return {
        rows: [{
          measure: '90/90-18', brand: 'Metzeler',
          tire_width_mm: 90, tire_aspect_ratio: 90, tire_rim_diameter: 18,
        }],
      };
      if (sql.includes('JOIN commerce.tire_specs')) return {
        rows: [{ id: 'produto-existente', product_code: 'MET-1', deleted_at: null }],
      };
      throw new Error(`consulta inesperada: ${sql}`);
    });
    const { pool, release } = fakePool(query);

    await expect(createCatalogProductFromStock({
      measure: '90/90-18',
      brand: 'Metzeler',
      productCode: 'MET-2',
      productName: 'Outro Metzeler',
      actorLabel: 'Admin',
      environment: 'test',
    }, pool)).rejects.toThrow('catalog_variant_already_exists');

    expect(query).toHaveBeenCalledWith('ROLLBACK');
    expect(query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO commerce.products'))).toBe(false);
    expect(release).toHaveBeenCalledOnce();
  });

  it('permite novo cadastro quando a variante anterior está arquivada', async () => {
    const query = vi.fn(async (sql: string) => {
      if (['BEGIN', 'COMMIT'].includes(sql)) return { rows: [] };
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (sql.includes('FROM commerce.wholesale_stock')) return {
        rows: [{
          measure: '90/90-18', brand: 'Technic', tire_condition: 'meia_vida',
          tire_width_mm: 90, tire_aspect_ratio: 90, tire_rim_diameter: 18,
        }],
      };
      if (sql.includes('JOIN commerce.tire_specs')) return {
        rows: [{
          id: 'produto-legado', product_code: 'TECH-LEGADO',
          deleted_at: '2026-07-31T00:00:00.000Z',
        }],
      };
      if (sql.includes('SELECT id FROM commerce.products')) return { rows: [] };
      if (sql.includes('INSERT INTO commerce.products')) return { rows: [{ id: 'produto-novo' }] };
      if (sql.includes('INSERT INTO commerce.tire_specs')) return { rows: [{ id: 'spec-nova' }] };
      if (sql.includes('INSERT INTO commerce.vehicle_fitments')) return { rows: [], rowCount: 2 };
      if (sql.includes('INSERT INTO audit.events')) return { rows: [] };
      throw new Error(`consulta inesperada: ${sql}`);
    });
    const { pool } = fakePool(query);

    await expect(createCatalogProductFromStock({
      measure: '90/90-18',
      brand: 'Technic',
      tireCondition: 'meia_vida',
      productCode: 'TEC-909018-MV',
      productName: 'Pneu Technic 90/90-18',
      actorLabel: 'Admin',
      environment: 'test',
    }, pool)).resolves.toEqual(expect.objectContaining({
      product_id: 'produto-novo',
      tire_condition: 'meia_vida',
    }));

    const auditCall = query.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO audit.events'));
    expect(String(auditCall?.[1]?.[3])).toContain('produto-legado');
  });

  it('recusa codigo repetido e estoque ambiguo', async () => {
    const duplicateCodeQuery = vi.fn(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (sql.includes('FROM commerce.wholesale_stock')) return {
        rows: [{
          measure: '90/90-18', brand: 'Metzeler',
          tire_width_mm: 90, tire_aspect_ratio: 90, tire_rim_diameter: 18,
        }],
      };
      if (sql.includes('JOIN commerce.tire_specs')) return { rows: [] };
      if (sql.includes('SELECT id FROM commerce.products')) return { rows: [{ id: 'outro' }] };
      throw new Error(`consulta inesperada: ${sql}`);
    });
    const duplicateCode = fakePool(duplicateCodeQuery);
    await expect(createCatalogProductFromStock({
      measure: '90/90-18',
      brand: 'Metzeler',
      productCode: 'CODIGO-USADO',
      productName: 'Metzeler',
      actorLabel: 'Admin',
      environment: 'test',
    }, duplicateCode.pool)).rejects.toThrow('catalog_product_code_duplicate');

    const ambiguousQuery = vi.fn(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (sql.includes('FROM commerce.wholesale_stock')) return {
        rows: [
          {
            measure: '90/90-18', brand: 'Metzeler',
            tire_width_mm: 90, tire_aspect_ratio: 90, tire_rim_diameter: 18,
          },
          {
            measure: '90/90-18', brand: 'METZELER',
            tire_width_mm: 90, tire_aspect_ratio: 90, tire_rim_diameter: 18,
          },
        ],
      };
      throw new Error(`consulta inesperada: ${sql}`);
    });
    const ambiguous = fakePool(ambiguousQuery);
    await expect(createCatalogProductFromStock({
      measure: '90/90-18',
      brand: 'Metzeler',
      productCode: 'MET-909018',
      productName: 'Metzeler',
      actorLabel: 'Admin',
      environment: 'test',
    }, ambiguous.pool)).rejects.toThrow('catalog_stock_variant_ambiguous');
  });
});
