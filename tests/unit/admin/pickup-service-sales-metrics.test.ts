import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('painel/public/app.varejo.js', 'utf8');

describe('serviços de retirada nos indicadores de Vendas', () => {
  it('não conta montagem como pneu vendido ou medida comercial', () => {
    expect(source).toContain('varejoIsTireItem(item)');
    expect(source).toContain("startsWith('PICKUP-SERVICE-')");
    expect(source).toContain('pneusCount: items.filter');
    expect(source).toContain('sum + p.pneusCount');
    expect(source).toContain('.filter((item) => this.varejoIsTireItem(item))');
  });
});
