import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Pool } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getEntregadorRota } from '../../../src/admin/entregador/queries.js';
import { getCaixaDeliveries } from '../../../src/admin/caixa/deliveries.js';
import { validateCaixaSession, type CaixaAuth } from '../../../src/admin/caixa/queries.js';

vi.mock('../../../src/admin/entregador/queries.js', () => ({
  getEntregadorRota: vi.fn(),
}));
vi.mock('../../../src/shared/config/env.js', () => ({
  env: {
    FAREJADOR_ENV: 'test',
    DATABASE_URL: 'postgres://test:test@localhost/test',
    DATABASE_SSL: false,
  },
}));

function source(file: string): string {
  return readFileSync(resolve(file), 'utf8');
}

const courier: CaixaAuth = {
  personId: 'person-1',
  collaboratorId: 'courier-1',
  displayName: 'Marcos',
  username: 'marcos',
  job: 'entregador',
  modules: { vendas: false, estoque: false, entregas: true, retiradas: false, financeiro: false },
};

describe('logística da Matriz dentro da Operação da Loja', () => {
  beforeEach(() => vi.clearAllMocks());

  it('adapta fila e rota existente sem duplicar as regras logísticas', async () => {
    vi.mocked(getEntregadorRota).mockResolvedValue({
      rota_aberta: {
        trip_id: 'trip-1', trip_number: 'ROTA-1048', km_start: '45210',
        started_at: '2026-08-11T12:00:00.000Z',
        entregas: [{
          order_id: 'order-route', customer_name: 'Carlos', customer_phone: '5521999999999',
          delivery_address: 'Rua A, 10', cobrar: '399.80', payment_method: 'pix', delivery_status: 'dispatched',
          scheduled_date: '2026-08-11', scheduled_raw: '2026-08-11', photo_request_id: null,
          items: [{ quantity: 2, label: 'MAGGION 90/90-18' }],
        }],
      },
      fila: [{
        order_id: 'order-queue', customer_name: 'Ana', customer_phone: null,
        delivery_address: 'Rua B, 20', cobrar: '259.90', payment_method: null, delivery_status: 'pending',
        scheduled_date: '2026-08-11', scheduled_raw: '2026-08-11', photo_request_id: null,
        items: [{ quantity: 1, label: 'MAGGION 100/80-18' }],
      }],
    });

    const payload = await getCaixaDeliveries(courier);

    expect(getEntregadorRota).toHaveBeenCalledWith(
      expect.objectContaining({ collaboratorId: 'courier-1', displayName: 'Marcos' }),
      expect.any(String),
    );
    expect(payload.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ order_id: 'order-route', in_route: true, total_amount: 399.8 }),
      expect.objectContaining({ order_id: 'order-queue', in_route: false, total_amount: 259.9 }),
    ]));
    expect(payload.summary).toEqual({ preparing: 1, dispatched: 1, delivered: 0 });
    expect(payload.matrix_route).toMatchObject({ trip_number: 'ROTA-1048', unresolved: 1 });
  });

  it('a sessão cs_ reconhece entregador e não libera os módulos de venda', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{
      person_id: 'person-1', collaborator_id: 'courier-1', display_name: 'Marcos',
      username: 'marcos', job: 'entregador',
    }] });
    const dbPool = { query } as unknown as Pool;

    const auth = await validateCaixaSession('test', `cs_${'a'.repeat(64)}`, dbPool);

    expect(auth?.modules).toEqual({
      vendas: false, estoque: false, entregas: true, retiradas: false, financeiro: false,
    });
    expect(String(query.mock.calls[0]?.[0])).toContain("mc.job = 'entregador'");
  });

  it('reusa as ações do portal antigo atrás da permissão Entregas', () => {
    const route = source('src/admin/caixa/route-deliveries.ts');
    const adapter = source('src/admin/caixa/deliveries.ts');
    const caixaRoute = source('src/admin/caixa/route.ts');
    const ui = source('painel/public/caixa-deliveries-matrix.js');
    const html = source('painel/public/caixa.html');

    expect(adapter).toContain('getEntregadorRota');
    expect(route).toContain('openEntregadorTrip');
    expect(route).toContain('setEntregadorDeliveryStatus');
    expect(route).toContain('reportEntregadorFail');
    expect(route).toContain('closeEntregadorTrip');
    expect(route).toContain('addEntregadorReceipt');
    expect(caixaRoute).toContain("requireCaixaModule('entregas')");
    expect(caixaRoute).toContain("requireCaixaModule('vendas')");
    expect(ui).toContain("'/api/caixa/entregas/'");
    expect(html).toContain('id="matrix-route-summary"');
    expect(html).toContain('id="matrix-route-close"');
  });

  it('formata o valor a cobrar sem derrubar a renderização da fila', () => {
    const sharedUi = source('painel/public/caixa-deliveries.js');

    expect(sharedUi).toContain('Caixa.currency.format(Number(row.total_amount))');
    expect(sharedUi).not.toContain('Caixa.currency(row.total_amount)');
  });
});
