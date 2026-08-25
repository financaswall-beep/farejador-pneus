import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'db/migrations/0207_catalog_brand_identity_and_names.sql',
  'utf8',
);

describe('migration 0207 — identidade e nomes do catálogo', () => {
  it('normaliza CEAT, IRA e IRC e fixa Pneu + Marca + Medida', () => {
    expect(migration).toContain("WHEN 'ciat' THEN 'CEAT'");
    expect(migration).toContain("WHEN 'ira' THEN 'IRA'");
    expect(migration).toContain("WHEN 'irc' THEN 'IRC'");
    expect(migration).toContain("concat('Pneu ',t.new_brand,' ',t.tire_size)");
    expect(migration).toContain("'catalog_product_identity_normalized'");
  });

  it('declara e audita efeito exclusivamente cadastral', () => {
    expect(migration).toContain("'price',false");
    expect(migration).toContain("'stock',false");
    expect(migration).toContain("'purchase',false");
    expect(migration).toContain("'finance',false");
    expect(migration).toContain("'orders',false");
    expect(migration).not.toMatch(/UPDATE\s+(?:commerce\.wholesale|finance\.|commerce\.orders)/i);
  });
});
