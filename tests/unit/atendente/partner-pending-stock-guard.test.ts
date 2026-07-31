import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('estoque pendente do parceiro fora do roteamento', () => {
  it('filtra condição nula em todas as leituras de estoque usadas pelo bot', () => {
    const source = readFileSync(
      path.resolve(process.cwd(), 'src/atendente-v2/fulfillment.ts'),
      'utf8',
    );
    const partnerStockQueries = source
      .split('FROM commerce.partner_stock_levels')
      .slice(1)
      .map((fragment) => fragment.split('`,')[0] ?? '');

    expect(partnerStockQueries).toHaveLength(4);
    for (const query of partnerStockQueries) {
      expect(query).toContain('tire_condition IS NOT NULL');
    }
  });
});
