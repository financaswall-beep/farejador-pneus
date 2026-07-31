import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

let createCatalogProductFromStock:
  typeof import('../../../src/admin/painel/queries-catalogo-create.js').createCatalogProductFromStock;

beforeAll(async () => {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    FAREJADOR_ENV: 'test',
    DATABASE_URL: 'postgres://test',
    CHATWOOT_HMAC_SECRET: 'test-secret',
    ADMIN_AUTH_TOKEN: 'emergency-token',
  });
  ({ createCatalogProductFromStock }
    = await import('../../../src/admin/painel/queries-catalogo-create.js'));
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
