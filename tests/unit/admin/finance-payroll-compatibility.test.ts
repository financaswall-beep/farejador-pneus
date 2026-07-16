import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

let getMatrizExpenses: typeof import('../../../src/admin/painel/queries-fiado-despesas.js').getMatrizExpenses;

beforeAll(async () => {
  Object.assign(process.env, {
    NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: 'postgres://test',
    CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'emergency-token',
  });
  ({ getMatrizExpenses } = await import('../../../src/admin/painel/queries-fiado-despesas.js'));
});

describe('compatibilidade do Financeiro durante a migracao da folha', () => {
  it('continua listando despesas antes das tabelas de folha existirem', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ ready: false }] })
      .mockResolvedValueOnce({ rows: [{
        id: 'e1', category: 'outros', description: 'Despesa', amount: '10.00',
        occurred_at: '2026-07-15', payment_status: 'pending', due_date: null,
        paid_at: null, payroll_item_id: null, overdue: false,
      }] })
      .mockResolvedValueOnce({ rows: [{
        a_pagar_total: '10.00', a_pagar_count: 1, a_pagar_vencidos: 0, pago_mes_total: '0',
      }] });

    const result = await getMatrizExpenses('test', { query } as unknown as Pool);

    expect(result.entries[0]?.payroll_item_id).toBeNull();
    expect(result.a_pagar_total).toBe('10.00');
    expect(String(query.mock.calls[1]?.[0])).toContain('NULL::uuid AS payroll_item_id');
    expect(String(query.mock.calls[1]?.[0])).not.toContain('FROM finance.matriz_payroll_items');
  });
});
