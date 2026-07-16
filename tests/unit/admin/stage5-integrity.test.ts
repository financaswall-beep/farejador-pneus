import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import {
  beginIntegrityOperation, integrityResult, moneyCents, operationFingerprint,
  resolveIntegrityOperation,
} from '../../../src/admin/painel/stage5-integrity.js';
import {
  createMatrizExpenseSchema, registerPurchaseSchema, registerWholesaleSaleSchema,
  resolveIntegrityOperationSchema,
} from '../../../src/admin/painel/route-schemas.js';

const operation = {
  environment: 'test' as const,
  domain: 'stage5.test',
  idempotencyKey: 'stage5-unit-key',
  fingerprint: operationFingerprint({ amount: 10 }),
};

describe('fundação de integridade da Etapa 5', () => {
  it('gera o mesmo fingerprint independentemente da ordem das chaves', () => {
    expect(operationFingerprint({ b: 2, a: { d: 4, c: 3 } }))
      .toBe(operationFingerprint({ a: { c: 3, d: 4 }, b: 2 }));
  });

  it('distingue a ordem dos itens, que é parte do payload', () => {
    expect(operationFingerprint([{ id: 1 }, { id: 2 }]))
      .not.toBe(operationFingerprint([{ id: 2 }, { id: 1 }]));
  });

  it('arredonda valores para centavos de forma estável', () => {
    expect(moneyCents(10.005)).toBe(1001);
    expect(moneyCents(0.1 + 0.2)).toBe(30);
  });

  it('normaliza Date no primeiro retorno para ficar idêntico ao replay JSON', () => {
    expect(integrityResult({ paid_at: new Date('2026-07-16T12:00:00Z') }))
      .toEqual({ paid_at: '2026-07-16T12:00:00.000Z' });
  });

  it('reserva uma operação nova sob advisory lock', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM audit.operation_idempotency')) return { rows: [] };
      return { rows: [] };
    });
    await expect(beginIntegrityOperation({ query } as unknown as PoolClient, operation))
      .resolves.toEqual({ replayed: false });
    expect(String(query.mock.calls[0][0])).toContain('pg_advisory_xact_lock');
    expect(query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO audit.operation_idempotency'))).toBe(true);
  });

  it('repete resultado concluído e recusa chave reaproveitada com payload diferente', async () => {
    const result = { id: 'original' };
    const replayQuery = vi.fn(async (sql: string) => sql.includes('FROM audit.operation_idempotency')
      ? { rows: [{ request_fingerprint: operation.fingerprint, result, completed_at: '2026-07-16' }] }
      : { rows: [] });
    await expect(beginIntegrityOperation<typeof result>(
      { query: replayQuery } as unknown as PoolClient, operation,
    )).resolves.toEqual({ replayed: true, result });

    const conflictQuery = vi.fn(async (sql: string) => sql.includes('FROM audit.operation_idempotency')
      ? { rows: [{ request_fingerprint: '0'.repeat(64), result, completed_at: '2026-07-16' }] }
      : { rows: [] });
    await expect(beginIntegrityOperation(
      { query: conflictQuery } as unknown as PoolClient, operation,
    )).rejects.toThrow('idempotency_conflict');
  });

  it('recupera resultado concluido e distingue chave ausente apos recarga', async () => {
    const completedQuery = vi.fn(async (sql: string) => sql.includes('FROM audit.operation_idempotency')
      ? { rows: [{ entity_table: 'commerce.wholesale_orders', entity_id: 'sale-id',
        result: { order_id: 'sale-id' }, completed_at: '2026-07-16' }] }
      : { rows: [] });
    await expect(resolveIntegrityOperation(
      { query: completedQuery } as unknown as PoolClient,
      { environment: 'test', domain: 'wholesale_sale.create', idempotencyKey: 'stage5-recovery-key' },
    )).resolves.toMatchObject({ status: 'completed', result: { order_id: 'sale-id' } });
    expect(String(completedQuery.mock.calls[0][0])).toContain('pg_advisory_xact_lock');

    const missingQuery = vi.fn(async () => ({ rows: [] }));
    await expect(resolveIntegrityOperation(
      { query: missingQuery } as unknown as PoolClient,
      { environment: 'test', domain: 'wholesale_sale.create', idempotencyKey: 'stage5-missing-key' },
    )).resolves.toEqual({ status: 'missing' });
  });

  it('a borda HTTP descarta ambiente injetado nas mutações da Matriz', () => {
    const sale = registerWholesaleSaleSchema.parse({ environment: 'prod',
      new_customer: { name: 'Cliente' }, idempotency_key: 'stage5-sale-key',
      items: [{ measure: '90/90-18', quantity: 1, unit_price: 10 }] });
    const purchase = registerPurchaseSchema.parse({ environment: 'prod',
      new_supplier: { name: 'Fornecedor' }, idempotency_key: 'stage5-purchase-key',
      items: [{ measure: '90/90-18', quantity: 1, unit_cost: 5 }] });
    const expense = createMatrizExpenseSchema.parse({ environment: 'prod',
      category: 'outros', amount: 1, idempotency_key: 'stage5-expense-key' });
    expect(sale).not.toHaveProperty('environment');
    expect(purchase).not.toHaveProperty('environment');
    expect(expense).not.toHaveProperty('environment');
    expect(resolveIntegrityOperationSchema.safeParse({
      domain: 'wholesale_sale.cancel', idempotency_key: 'stage5-invalid-domain',
    }).success).toBe(false);
  });
});
