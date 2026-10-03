import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const { source } = vi.hoisted(() => ({ source: vi.fn() }));
vi.mock('../../../src/admin/painel/queries-notificacoes.js', () => ({ getMatrizNotificacoes: source }));
vi.mock('../../../src/persistence/db.js', () => ({ pool: {} }));
vi.mock('../../../src/shared/config/env.js', () => ({ env: { FAREJADOR_ENV: 'test' } }));
import { getMatrizOperationNotifications } from '../../../src/admin/caixa/operation-notifications.js';

const script = readFileSync('painel/public/app.sino.js', 'utf8');
function bell(failures?: object) {
  const window: any = {};
  vm.runInNewContext(script, { window });
  const model = window.PAINEL_MODULES.sino();
  model.sino = { bot_reservation_expiry_failures: failures };
  model.sinoLidas = [];
  return model;
}

describe('avisos de liberação de reservas', () => {
  it('sino identifica os pedidos e lojas; resolvidos desaparecem', () => {
    const model = bell({ count: 2, orders: [
      { order_number: 'PED-001', unit_name: 'Matriz' },
      { order_number: 'PED-002', unit_name: 'Parceiro' },
    ] });
    const notice = model.notificacoes[0];
    expect(notice.title).toContain('2 reserva(s)');
    expect(notice.desc).toContain('PED-001 · Matriz');
    expect(notice.desc).toContain('PED-002 · Parceiro');
    expect(notice.page).toBe('bot');
    model.sino.bot_reservation_expiry_failures = { count: 0, orders: [] };
    expect(model.notificacoes).toHaveLength(0);
    expect(bell().notificacoes).toHaveLength(0);
  });

  it('app exige Retiradas e usa apenas a contagem da Matriz', async () => {
    source.mockResolvedValue({ entregas_falhadas: [], fiado_vencido: { count: 0 },
      a_pagar_vencido: { count: 0 }, galpao_repor: [],
      bot_reservation_expiry_failures: { count: 100, matrix_count: 2, orders: [] } });
    expect((await getMatrizOperationNotifications({ modules: {} } as never)).notifications).toHaveLength(0);
    const result = await getMatrizOperationNotifications({ modules: { retiradas: true } } as never);
    expect(result.notifications).toHaveLength(1);
    expect(result.notifications[0]?.description).toContain('2 reserva(s)');
    source.mockResolvedValue({ entregas_falhadas: [], fiado_vencido: { count: 0 },
      a_pagar_vencido: { count: 0 }, galpao_repor: [],
      bot_reservation_expiry_failures: { count: 100, matrix_count: 0, orders: [] } });
    expect((await getMatrizOperationNotifications({ modules: { retiradas: true } } as never)).notifications).toHaveLength(0);
  });
});
