import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

function factory(file: string, name: string) {
  const sandbox: Record<string, any> = { window: {}, Intl, Date, encodeURIComponent,
    crypto: { randomUUID: () => '11111111-1111-4111-8111-111111111111' },
    lucide: { createIcons() {} } };
  runInNewContext(readFileSync(resolve(process.cwd(), file), 'utf8'), sandbox, { filename: file });
  return sandbox.window.PAINEL_MODULES[name]();
}

function makeApp() {
  const app: any = {
    isPartnerPanel: () => true, hasPanelModule: () => true,
    $nextTick: (callback: () => void) => callback(), formatCurrency: (value: number) => String(value),
  };
  for (const [file, name] of [
    ['painel/public/app.partner-vendas.js', 'partnerVendas'],
    ['painel/public/app.partner-vendas.dashboard.js', 'partnerVendasDashboard'],
  ]) Object.defineProperties(app, Object.getOwnPropertyDescriptors(factory(file, name)));
  return app;
}

describe('dashboard de vendas da unidade', () => {
  it('não realiza retirada ou entrega pendente e separa recebido de a receber', () => {
    const app = makeApp();
    const createdAt = new Date().toISOString();
    app.partnerVendas.rows = [
      { order_id: '1', created_at: createdAt, status: 'confirmed', total_amount: 100,
        received_amount: 100, fulfillment_mode: 'pickup', awaiting_pickup: false,
        items: [{ quantity: 2 }] },
      { order_id: '2', created_at: createdAt, status: 'confirmed', total_amount: 200,
        received_amount: 0, fulfillment_mode: 'pickup', awaiting_pickup: false,
        items: [{ quantity: 1 }] },
      { order_id: '3', created_at: createdAt, status: 'confirmed', total_amount: 50,
        received_amount: 0, fulfillment_mode: 'pickup', awaiting_pickup: true, items: [] },
      { order_id: '4', created_at: createdAt, status: 'confirmed', total_amount: 60,
        received_amount: 0, fulfillment_mode: 'delivery', delivery_status: 'pending', items: [] },
      { order_id: '5', created_at: createdAt, status: 'cancelled', total_amount: 70,
        received_amount: 70, fulfillment_mode: 'pickup', awaiting_pickup: false, items: [] },
    ];

    expect(app.partnerVendasMetrics).toEqual({
      revenue: 300, received: 100, orders: 2, tires: 3, average: 150, receivable: 200,
    });
    expect(app.partnerVendasStatusSummary).toEqual({
      confirmed: 2, pickup: 1, delivery: 1, cancelled: 1,
    });
  });

  it('mantém período e filtros aplicados à mesma lista operacional', () => {
    const app = makeApp();
    const now = new Date().toISOString();
    app.partnerVendas.rows = [
      { order_id: 'confirmed', created_at: now, status: 'confirmed',
        fulfillment_mode: 'pickup', awaiting_pickup: false, items: [] },
      { order_id: 'pending', created_at: now, status: 'confirmed',
        fulfillment_mode: 'delivery', delivery_status: 'pending', items: [] },
    ];
    app.partnerVendasSetPeriod('today');
    app.partnerVendasSetFilter('pendentes');
    expect(app.partnerVendasFiltered().map((row: any) => row.order_id)).toEqual(['pending']);
    app.partnerVendasSetFilter('confirmadas');
    expect(app.partnerVendasFiltered().map((row: any) => row.order_id)).toEqual(['confirmed']);
  });
});
