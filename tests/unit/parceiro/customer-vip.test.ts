import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('cliente VIP do parceiro', () => {
  it('usa o mesmo fato realizado de Estoque e Financeiro', () => {
    const sql = readFileSync('src/parceiro/customer-queries.ts','utf8');
    const client = readFileSync('parceiro/public/app.pdv.clientes.js','utf8');
    const finance = readFileSync('parceiro/public/app.financeiro.kpis.js','utf8');
    const html = readFileSync('parceiro/public/index.html','utf8');

    expect(sql).toContain("po.status<>'cancelled'");
    expect(sql).toContain("po.delivery_status<>'delivered'");
    expect(sql).toContain('NOT po.awaiting_pickup');
    expect(sql).toContain('(COALESCE(sales.purchases,0)>=3) AS is_vip');
    expect(client).toContain('customerPurchaseCount(customer)');
    expect(finance).toContain("sale.fulfillment_mode === 'pickup' && sale.awaiting_pickup");
    expect(html).toContain('customerPurchaseCount(customer)');
  });
});
