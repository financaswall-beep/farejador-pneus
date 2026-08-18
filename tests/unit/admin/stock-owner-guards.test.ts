import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  removeWholesaleStockSchema,
  setWholesaleStockSchema,
} from '../../../src/admin/painel/route-schemas-stock.js';

describe('guarda de mutações do estoque da matriz', () => {
  const route = readFileSync('src/admin/painel/route-galpao.ts', 'utf8');
  const html = readFileSync('painel/public/index.html', 'utf8');

  it.each([
    '/admin/api/wholesale/stock/entry',
    '/admin/api/wholesale/stock',
    '/admin/api/wholesale/stock/remove',
    '/admin/api/wholesale/stock/baixa',
    '/admin/api/wholesale/stock/physical-count',
    '/admin/api/wholesale/stock/condition-transfer',
    '/admin/api/wholesale/stock/brand-correction',
  ])('mantém %s restrita ao proprietário', (path) => {
    const start = route.indexOf(`fastify.post('${path}'`);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(route.slice(start, start + 180)).toContain('requireAdminOwner');
  });

  it('não permite zerar custo por omissão e exige motivo na remoção', () => {
    expect(setWholesaleStockSchema.safeParse({
      measure: '90/90-18', brand: 'Pirelli', tire_condition: 'novo',
      quantity_on_hand: 5,
    }).success).toBe(false);
    expect(removeWholesaleStockSchema.safeParse({
      measure: '90/90-18', brand: 'Pirelli', tire_condition: 'novo',
    }).success).toBe(false);
    expect(removeWholesaleStockSchema.safeParse({
      measure: '90/90-18', brand: 'Pirelli', tire_condition: 'novo',
      reason: 'cadastro duplicado', idempotency_key: 'remove-12345678',
    }).success).toBe(true);
  });

  it('oculta ações destrutivas para administrador que não é owner', () => {
    expect(html).toContain('x-show="adminUser?.role === \'owner\'" @click="stockRemove(selectedRow)"');
    expect(html).toContain('x-show="stockOperacao && adminUser?.role === \'owner\'"');
    expect(html).toContain('x-show="stockBaixaForm.measure && adminUser?.role === \'owner\'"');
  });
});
