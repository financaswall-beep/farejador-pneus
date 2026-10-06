import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
const overview = vi.hoisted(() => vi.fn());
vi.mock('../../../src/admin/painel/queries-catalogo.js', () => ({ getCatalogOverview: overview }));
let api: typeof import('../../../src/admin/painel/queries-catalogo-wholesale.js');
beforeAll(async () => {
  Object.assign(process.env, { NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: 'postgres://test',
    CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'test-token' });
  api = await import('../../../src/admin/painel/queries-catalogo-wholesale.js');
});
const input = { productId: 'p1', priceAmount: 65 as number | null, reason: 'Tabela parceiros',
  actorLabel: 'Proprietário', environment: 'test' as const };
function database(previous: number | null = 60, productType = 'tire', failAudit = false) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('FROM commerce.products')) return { rows: productType ? [{ product_type: productType }] : [] };
    if (sql.includes('SELECT id,price_amount')) return { rows: previous === null ? [] : [{ id: 'old', price_amount: String(previous) }] };
    if (sql.includes('SELECT GREATEST')) return { rows: [{ at: '2026-10-06T12:00:00.123456Z' }] };
    if (sql.includes('INSERT INTO commerce.wholesale_product_prices')) return { rows: [{ id: 'new' }] };
    if (failAudit && sql.includes('INSERT INTO audit.events')) throw new Error('audit_failed');
    return { rows: [] };
  });
  const release = vi.fn(), connect = vi.fn(async () => ({ query, release }));
  return { pool: { connect } as unknown as Pool, query, release, connect };
}
describe('preço de atacado independente', () => {
  it('enriquece só a consulta da Matriz sem modificar preço, custo, lucro ou resultado original', async () => {
    const catalog = { summary: { without_price: 1 }, brands: ['Pirelli'], rows: [
      { product_id: 'p1', product_type: 'tire', price_amount: 95, gross_profit: 55, official_unit_cost: 40 },
      { product_id: 'p2', product_type: 'tire', price_amount: null },
      { product_id: 's1', product_type: 'service', price_amount: 20 },
      { product_id: null, product_type: 'tire', catalogued: false },
    ] };
    overview.mockResolvedValue(catalog);
    const query = vi.fn(async () => ({ rows: [{ product_id: 'p1', price_amount: '65.00' }] }));
    const result = await api.getMatrixCatalogWithWholesale('test', { query } as unknown as Pool);
    expect(result.rows[0]).toMatchObject({ wholesale_price_amount: 65, price_amount: 95, gross_profit: 55, official_unit_cost: 40 });
    expect(result.rows.slice(1).every(row => row.wholesale_price_amount === null)).toBe(true);
    expect(catalog.rows[0]).not.toHaveProperty('wholesale_price_amount');
    expect(result.summary).toEqual(catalog.summary);
    expect(query.mock.calls[0]).toEqual([expect.stringContaining('wholesale_current_prices'), ['test']]);
  });
  it('troca a vigência e audita o atacado sem gravar nas fontes de varejo', async () => {
    const db = database();
    expect(await api.setCatalogWholesalePrice(input, db.pool)).toEqual({ changed: true, price_id: 'new', price_amount: 65 });
    const sql = db.query.mock.calls.map(call => call[0]).join('\n');
    expect(sql).toContain('FOR UPDATE'); expect(sql).toContain('clock_timestamp()');
    expect(sql).not.toMatch(/matriz_product_prices|commerce\.product_prices|stock_levels/);
    const audit = db.query.mock.calls.find(call => call[0].includes('INSERT INTO audit.events')) as unknown[];
    expect(JSON.stringify(audit)).toContain('Tabela parceiros');
    expect(db.query).toHaveBeenCalledWith('COMMIT'); expect(db.release).toHaveBeenCalledOnce();
  });
  it('retira a oferta encerrando o histórico, sem inserir preço zero ou excluir linhas', async () => {
    const db = database();
    expect(await api.setCatalogWholesalePrice({ ...input, priceAmount: null }, db.pool))
      .toEqual({ changed: true, price_id: null, price_amount: null });
    expect(db.query.mock.calls.some(call => call[0].includes('INSERT INTO commerce.wholesale_product_prices'))).toBe(false);
    expect(db.query.mock.calls.some(call => call[0].includes('DELETE'))).toBe(false);
    expect(db.query.mock.calls.some(call => call[0].includes('audit.events'))).toBe(true);
  });
  it('não cria histórico quando não houve alteração', async () => {
    for (const price of [65, null]) {
      const db = database(price);
      expect((await api.setCatalogWholesalePrice({ ...input, priceAmount: price }, db.pool)).changed).toBe(false);
      expect(db.query.mock.calls.some(call => /UPDATE|INSERT/.test(call[0]) && !call[0].includes('FOR UPDATE'))).toBe(false);
    }
  });
  it('recusa produto ausente/serviço e desfaz tudo quando a auditoria falha', async () => {
    for (const [type, error] of [['', 'catalog_product_not_found'], ['service', 'catalog_wholesale_product_invalid']]) {
      const db = database(60, type);
      await expect(api.setCatalogWholesalePrice(input, db.pool)).rejects.toThrow(error);
      expect(db.query).toHaveBeenCalledWith('ROLLBACK'); expect(db.release).toHaveBeenCalledOnce();
    }
    const db = database(60, 'tire', true);
    await expect(api.setCatalogWholesalePrice(input, db.pool)).rejects.toThrow('audit_failed');
    expect(db.query).toHaveBeenCalledWith('ROLLBACK');
  });
  it('recusa valor inválido e motivo vazio antes da transação', async () => {
    for (const priceAmount of [0, -1, NaN, Infinity, 65.999, 10000000]) {
      const db = database();
      await expect(api.setCatalogWholesalePrice({ ...input, priceAmount }, db.pool)).rejects.toThrow('catalog_wholesale_price_invalid');
      expect(db.connect).not.toHaveBeenCalled();
    }
    await expect(api.setCatalogWholesalePrice({ ...input, reason: ' ' }, database().pool)).rejects.toThrow('reason_required');
  });
  it('lê histórico incluindo retirada da oferta, filtrando produto e ambiente', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    await api.getCatalogWholesaleHistory('p1', 'test', { query } as unknown as Pool);
    expect(query.mock.calls[0]).toEqual([expect.stringContaining('catalog_wholesale_price_changed'), ['test', 'p1']]);
  });
});
