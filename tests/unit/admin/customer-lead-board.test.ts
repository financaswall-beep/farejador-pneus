import type { Pool, PoolClient } from 'pg';
import { beforeAll, describe, expect, it, vi } from 'vitest';

let updateCustomerLeadBoard: typeof import('../../../src/admin/painel/customer-lead-board.js').updateCustomerLeadBoard;

function fakePool(stateVersion: number | null, archived = false) {
  const query = vi.fn(async (sqlValue: unknown, params?: unknown[]) => {
    const sql = String(sqlValue);
    if (sql.includes('FROM audit.operation_idempotency')) return { rows: [] };
    if (sql.includes('FROM core.conversations')) return { rows: [{ id:'conv' }] };
    if (sql.includes('FROM ops.customer_lead_board_state')) {
      return { rows: stateVersion == null ? [] : [{
        manual_lane:'novo',archived_at:archived?'2026-09-05':null,archived_by:null,archive_reason:null,version:stateVersion,
      }] };
    }
    if (sql.includes('INSERT INTO ops.customer_lead_board_state')) return { rows: [{
      manual_lane:params?.[2] ?? null,archived_at:null,archived_by:null,archive_reason:null,
      version:(stateVersion ?? 0)+1,
    }] };
    if (sql.includes('UPDATE audit.operation_idempotency')) return { rows: [{ idempotency_key:'key' }] };
    return { rows: [] };
  });
  const client = { query, release:vi.fn() } as unknown as PoolClient;
  const pool = { connect:vi.fn().mockResolvedValue(client) } as unknown as Pool;
  return { pool,query,client };
}

describe('serviço do quadro de leads', () => {
  beforeAll(async () => {
    Object.assign(process.env,{
      NODE_ENV:'test',FAREJADOR_ENV:'test',DATABASE_URL:'postgresql://test:test@example.test/test',
      CHATWOOT_HMAC_SECRET:'test-secret',ADMIN_AUTH_TOKEN:'test-admin-token',
    });
    ({ updateCustomerLeadBoard } = await import('../../../src/admin/painel/customer-lead-board.js'));
  });

  it('grava estado, auditoria, idempotência e notificação na mesma transação', async () => {
    const { pool,query,client } = fakePool(null);
    const result = await updateCustomerLeadBoard({
      environment:'test',conversationId:'00000000-0000-4000-8000-000000000001',
      action:'move',lane:'orcamento',expectedVersion:0,actor:'Dono',
      idempotencyKey:'00000000-0000-4000-8000-000000000099',
    },pool);
    expect(result).toMatchObject({ manual_lane:'orcamento',archived:false,version:1 });
    const sql = query.mock.calls.map((call) => String(call[0])).join('\n');
    expect(sql).toContain('INSERT INTO ops.customer_lead_board_state');
    expect(sql).toContain('INSERT INTO audit.events');
    expect(sql).toContain('UPDATE audit.operation_idempotency');
    expect(sql).toContain('SELECT pg_notify');
    expect(query).toHaveBeenLastCalledWith('COMMIT');
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('recusa edição concorrente e desfaz a operação', async () => {
    const { pool,query } = fakePool(2);
    await expect(updateCustomerLeadBoard({
      environment:'test',conversationId:'00000000-0000-4000-8000-000000000001',
      action:'move',lane:'perdido',expectedVersion:1,actor:'Dono',
      idempotencyKey:'00000000-0000-4000-8000-000000000098',
    },pool)).rejects.toThrow('lead_version_conflict');
    expect(query).toHaveBeenLastCalledWith('ROLLBACK');
  });

  it('retoma o automático removendo apenas a escolha manual e registra auditoria', async () => {
    const { pool,query } = fakePool(2);
    const result = await updateCustomerLeadBoard({
      environment:'test',conversationId:'00000000-0000-4000-8000-000000000001',
      action:'automatic',expectedVersion:2,actor:'Dono',idempotencyKey:'resume-automatic-1',
    }, pool);
    expect(result).toMatchObject({ manual_lane:null,archived:false,version:3 });
    const insert = query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO ops.customer_lead_board_state'));
    expect(insert?.[1]).toEqual(['test','00000000-0000-4000-8000-000000000001',null,'Dono']);
    const calls = JSON.stringify(query.mock.calls);
    expect(calls).toContain('customer_lead_automatic');
    expect(calls).not.toMatch(/UPDATE core\.|DELETE FROM/);
  });

  it('não altera a etapa de um card arquivado', async () => {
    const { pool,query } = fakePool(2, true);
    await expect(updateCustomerLeadBoard({
      environment:'test',conversationId:'00000000-0000-4000-8000-000000000001',
      action:'automatic',expectedVersion:2,actor:'Dono',idempotencyKey:'resume-archived-1',
    }, pool)).rejects.toThrow('lead_archived');
    expect(query).toHaveBeenLastCalledWith('ROLLBACK');
  });
});
