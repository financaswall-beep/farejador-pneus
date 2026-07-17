import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

vi.mock('../../../src/persistence/db.js', () => ({ pool: {} }));
vi.mock('../../../src/shared/config/env.js', () => ({ env: { FAREJADOR_ENV: 'test' } }));

import { costReconciliationOwnershipOk } from '../../../src/admin/painel/queries-rede-custos.js';

const fakePool = (rows: unknown[]): Pool => ({
  query: async () => ({ rows, rowCount: rows.length }),
}) as unknown as Pool;

describe('Etapa 6 — marcador de ownership da reconciliação (guard 0137)', () => {
  it('responde true quando a conexão é a dona da tabela', async () => {
    expect(await costReconciliationOwnershipOk(fakePool([{ ok: true }]))).toBe(true);
  });

  it('responde false quando a conexão NÃO é a dona (blindagem trocou a role)', async () => {
    expect(await costReconciliationOwnershipOk(fakePool([{ ok: false }]))).toBe(false);
  });

  it('responde false (nunca lança) se o catálogo não devolver linha', async () => {
    expect(await costReconciliationOwnershipOk(fakePool([]))).toBe(false);
  });

  it('boot avisa sem travar e a rota traduz o erro do guard', () => {
    const server = readFileSync('src/app/server.ts', 'utf8');
    expect(server).toContain('costReconciliationOwnershipOk');
    expect(server).toContain('RECONCILIACAO DE CUSTO INOPERANTE');
    const route = readFileSync('src/admin/painel/route-atacado.ts', 'utf8');
    expect(route).toContain('reconciliation_connection_not_owner');
    expect(route).toContain('partner_order_item_cost_snapshot_immutable');
  });
});
