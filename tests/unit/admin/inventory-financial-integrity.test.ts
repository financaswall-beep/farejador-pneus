import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  baixaWholesaleStockSchema, entryWholesaleStockSchema,
} from '../../../src/admin/painel/route-schemas.js';

const migration = readFileSync(
  resolve('db/migrations/0147_matriz_inventory_financial_adjustments.sql'), 'utf8',
);
const actions = readFileSync(
  resolve('src/admin/painel/queries-galpao-movimentos.ts'), 'utf8',
);
const returnSource = readFileSync(
  resolve('src/atendente-v2/wholesale-stock-read.ts'), 'utf8',
);
const frontend = readFileSync(resolve('painel/public/app.galpao.js'), 'utf8');
const html = readFileSync(resolve('painel/public/index.html'), 'utf8');

describe('Estoque — efeito financeiro dos caminhos manuais', () => {
  it('exige natureza, explicação e idempotência na entrada e na baixa', () => {
    expect(entryWholesaleStockSchema.safeParse({
      measure: '90/90-12', brand: 'Pirelli', quantity_in: 2, unit_cost: 50,
    }).success).toBe(false);
    expect(entryWholesaleStockSchema.safeParse({
      measure: '90/90-12', brand: 'Pirelli', quantity_in: 2, unit_cost: 50,
      entry_nature: 'inventory_found', reason: 'contagem física',
      idempotency_key: 'stock-entry-1',
    }).success).toBe(true);
    expect(baixaWholesaleStockSchema.safeParse({
      measure: '90/90-12', quantity: 1, reason: 'quebra',
    }).success).toBe(false);
    expect(baixaWholesaleStockSchema.safeParse({
      measure: '90/90-12', brand: 'Pirelli', quantity: 1, nature: 'breakage',
      reason: 'quebra na montagem', idempotency_key: 'stock-loss-1',
    }).success).toBe(true);
  });

  it('materializa ganho/perda uma vez e protege o fato financeiro', () => {
    expect(migration).toContain('finance.matriz_inventory_adjustments');
    expect(migration).toContain('UNIQUE (environment,stock_movement_id)');
    expect(migration).toContain('record_matriz_inventory_adjustment');
    expect(migration).toContain('inventory_adjustment_immutable');
    expect(migration).toContain('stock_entry_nature_required');
    expect(migration).toContain('REVOKE ALL ON finance.matriz_inventory_adjustments');
  });

  it('usa operação idempotente e falha se a devolução não atualizar o estoque', () => {
    expect(actions).toContain("domain: 'stock.entry'");
    expect(actions).toContain("domain: 'stock.manual_decrement'");
    expect(actions).toContain("set_config('app.galpao_nature'");
    expect(returnSource).toContain('if (updated.rowCount !== 1)');
    expect(returnSource).toContain('stock_measure_missing:');
  });

  it('expõe classificação na tela e envia a chave de repetição', () => {
    expect(html).toContain('Encontrado na contagem');
    expect(html).toContain('Explicação obrigatória');
    expect(html).toContain('perdas/baixas do estoque já descontadas do lucro');
    expect(frontend).toContain("operation('stock-entry', 'form')");
    expect(frontend).toContain("operation('stock-manual-decrement', 'form')");
  });
});
