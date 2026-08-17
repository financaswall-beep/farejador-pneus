import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  registerManualOrderSchema, registerWalkinOrderSchema,
} from '../../../src/admin/painel/route-schemas-orders.js';
import { registerWholesaleSaleSchema } from '../../../src/admin/painel/route-schemas.js';

function browserModule(file: string, name: string) {
  const sandbox = { window: { PAINEL_MODULES: {}, location: { hostname: 'localhost', search: '' } } };
  vm.runInNewContext(readFileSync(resolve('painel/public', file), 'utf8'), sandbox);
  return {
    module: (sandbox.window.PAINEL_MODULES as Record<string, () => Record<string, unknown>>)[name](),
    window: sandbox.window as Record<string, unknown>,
  };
}

describe('integridade intermodular da aba Vendas', () => {
  const productId = '22222222-2222-4222-8222-222222222222';
  const conversationId = '11111111-1111-4111-8111-111111111111';

  it('não aceita desconto maior que o valor da linha e descarta ambiente enviado pelo navegador', () => {
    const base = {
      environment: 'prod', conversation_id: conversationId,
      items: [{ product_id: productId, quantity: 2, unit_price: 50, discount_amount: 100 }],
      payment_method: 'pix', fulfillment_mode: 'pickup', idempotency_key: 'sales-schema-key',
    };
    const parsed = registerManualOrderSchema.parse(base);
    expect(parsed).not.toHaveProperty('environment');
    expect(registerManualOrderSchema.safeParse({
      ...base, items: [{ ...base.items[0], discount_amount: 100.01 }],
    }).success).toBe(false);

    const walkin = registerWalkinOrderSchema.parse({
      ...base, conversation_id: undefined, source_tag: 'walkin_balcao',
    });
    expect(walkin).not.toHaveProperty('environment');
  });

  it('exige exatamente um comprador e datas causais no atacado', () => {
    const base = {
      customer_id: '33333333-3333-4333-8333-333333333333',
      items: [{ measure: '90/90-18', brand: 'Pirelli', tire_condition: 'meia_vida',
        quantity: 1, unit_price: 100 }],
      idempotency_key: 'wholesale-schema-key', sold_at: '2026-08-17T12:00:00-03:00',
    };
    expect(registerWholesaleSaleSchema.safeParse({
      ...base, new_customer: { name: 'Outro comprador' },
    }).success).toBe(false);
    expect(registerWholesaleSaleSchema.safeParse({
      ...base, paid_at: '2026-08-17T11:59:59-03:00',
    }).success).toBe(false);
    expect(registerWholesaleSaleSchema.safeParse({
      ...base, payment_status: 'pending', due_date: '2026-08-16',
    }).success).toBe(false);
    expect(registerWholesaleSaleSchema.safeParse({
      ...base, payment_status: 'pending', due_date: '2026-08-17',
    }).success).toBe(true);
    const future = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
    expect(registerWholesaleSaleSchema.safeParse({
      ...base, sold_at: future,
    }).error?.issues[0]?.message).toBe('sold_at_future');
    expect(registerWholesaleSaleSchema.safeParse({
      ...base, paid_at: future,
    }).error?.issues[0]?.message).toBe('paid_at_future');
  });

  it('deixa mutações comerciais da Matriz somente para o proprietário', () => {
    const pedidos = readFileSync(resolve('src/admin/painel/route-pedidos.ts'), 'utf8');
    const atacado = readFileSync(resolve('src/admin/painel/route-atacado.ts'), 'utf8');
    const fiado = readFileSync(resolve('src/admin/painel/route-fiado.ts'), 'utf8');
    for (const path of [
      '/admin/api/orders/register-manual', '/admin/api/orders/register-walkin',
      '/admin/api/orders/:order_id/cancel', '/admin/api/orders/:order_id/retrieve',
    ]) {
      expect(pedidos).toContain(`post('${path}', { preHandler: requireAdminOwner }`);
    }
    expect(atacado).toContain(
      "post('/admin/api/wholesale/sales', { preHandler: requireAdminOwner }",
    );
    expect(fiado).toContain(
      "post('/admin/api/wholesale/sales/cancel', { preHandler: requireAdminOwner }",
    );
    expect(fiado).toContain(
      "post('/admin/api/wholesale/finance/settle', { preHandler: requireAdminOwner }",
    );
  });

  it('protege CSV contra fórmula e formata vencimento sem Invalid Date', () => {
    const history = browserModule('app.vendas.historico.js', 'vendasHistorico').module;
    const csvCell = history.vendasHistoricoCsvCell as (value: unknown) => string;
    expect(csvCell('=HYPERLINK("https://malicioso")')).toBe(
      '"\'=HYPERLINK(""https://malicioso"")"',
    );
    expect(csvCell('Cliente normal')).toBe('"Cliente normal"');

    const format = browserModule('app.format.js', 'format').module;
    const dateOnly = format.atacadoDateOnly as (value: unknown) => string;
    expect(dateOnly('2026-08-17')).toBe('17/08/2026');
    expect(dateOnly(null)).toBe('data inválida');
  });

  it('não permite que ?mock=1 substitua estoque fora do computador local', () => {
    const { window } = browserModule('app.atacado.js', 'atacado');
    const preview = window.PAINEL_STOCK_PREVIEW as { enabled: () => boolean };
    (window.location as { hostname: string; search: string }).search = '?mock=1';
    (window.location as { hostname: string; search: string }).hostname = 'painel.2wpneus.com.br';
    expect(preview.enabled()).toBe(false);
    (window.location as { hostname: string; search: string }).hostname = 'localhost';
    expect(preview.enabled()).toBe(true);
  });

  it('histórico completo não herda os limites das listas recentes e refresh é atômico', () => {
    const retail = readFileSync(resolve('src/admin/painel/queries-pedidos.ts'), 'utf8');
    const wholesale = readFileSync(resolve('src/admin/painel/queries-atacado-cancelar.ts'), 'utf8');
    const frontend = readFileSync(resolve('painel/public/app.vendas.marcas.js'), 'utf8');
    const retailHistory = retail.slice(retail.indexOf('export async function getPainelPedidosSalesHistory'),
      retail.indexOf('export async function getPainelProdutos'));
    const wholesaleHistory = wholesale.slice(wholesale.indexOf('export async function listWholesaleSalesHistory'),
      wholesale.indexOf('export interface CancelWholesaleSaleInput'));
    expect(retailHistory).not.toMatch(/\bLIMIT\b/i);
    expect(wholesaleHistory).not.toMatch(/\bLIMIT\b/i);
    expect(frontend).toContain("Object.entries(snapshot).forEach");
    expect(frontend).toContain("return failures.length === 0");
  });
});
