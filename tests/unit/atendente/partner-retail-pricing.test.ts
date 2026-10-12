import { describe, expect, it, vi } from 'vitest';
import { loadPartnerRetailOffers, validatePartnerRetailQuote } from '../../../src/atendente-v2/partner-retail-pricing.js';
import type { PartnerOrderRouting } from '../../../src/atendente-v2/fulfillment.js';

const routing = { unitId: 'unit-a', ctx: { unitName: 'Loja A' }, items: [
  { product_id: 'product-a', partner_stock_id: 'stock-a', quantity: 2, unit_price: 179.9 },
] } as PartnerOrderRouting;
const current = { id: 'stock-a', product_id: 'product-a', sale_price: '179.90' };

describe('preço ao cliente da própria borracharia', () => {
  it('mantém preços diferentes para o mesmo produto em lojas diferentes', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [
      { id: 'stock-other', unit_id: 'unit-b', product_id: 'product-a', sale_price: '100', disponivel: '9' },
      { id: 'stock-a', unit_id: 'unit-a', product_id: 'product-a', sale_price: '179.90', disponivel: '3' },
    ] });
    const a = await loadPartnerRetailOffers({ query } as never, 'prod', new Map([['product-a', { unitId: 'unit-a', available: 5 }]]));
    expect(a.get('product-a')).toEqual({ stockId: 'stock-a', unitId: 'unit-a', unitPrice: 179.9, available: 3 });
    const b = await loadPartnerRetailOffers({ query } as never, 'prod', new Map([['product-a', { unitId: 'unit-b', available: 9 }]]));
    expect(b.get('product-a')?.unitPrice).toBe(100);
    expect(query.mock.calls[0]?.[1]).toEqual(['prod', ['unit-a'], ['product-a']]);
    expect(query.mock.calls[0]?.[0]).toContain('sale_price>0');
  });

  it('aceita o preço atual cotado e bloqueia edição simultânea durante o pedido', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [current] });
    expect(await validatePartnerRetailQuote({ query } as never, 'prod', routing,
      [{ product_id: 'product-a', preco_unitario: 179.9 }])).toEqual({ ok: true });
    expect(query.mock.calls[0]?.[0]).toContain('FOR UPDATE');
    expect(query.mock.calls[0]?.[1]).toEqual(['prod', 'unit-a', ['stock-a']]);
  });

  it('recusa o preço antigo sem reservar nem criar cliente/pedido', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ ...current, sale_price: '189.90' }] });
    expect(await validatePartnerRetailQuote({ query } as never, 'prod', routing,
      [{ product_id: 'product-a', preco_unitario: 179.9 }])).toMatchObject({ ok: false,
      response: { erro: 'preco_alterado', preco_alterado: true, nome_loja: 'Loja A',
        itens: [{ product_id: 'product-a', preco_informado: 179.9, preco_atual: 189.9 }] } });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).not.toMatch(/INSERT|UPDATE commerce/);
  });

  it('aceita nova confirmação com o valor atualizado da loja', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ ...current, sale_price: '189.90' }] });
    const next = { ...routing, items: [{ ...routing.items[0]!, unit_price: 189.9 }] };
    expect(await validatePartnerRetailQuote({ query } as never, 'prod', next,
      [{ product_id: 'product-a', preco_unitario: 189.9 }])).toEqual({ ok: true });
  });

  it('não permite ao modelo atualizar o preço e repetir o fechamento no mesmo turno', async () => {
    const requests = new Set<string>();
    const query = vi.fn(async (sql: string, values: unknown[]) => {
      if (sql.includes('FROM commerce.partner_stock_levels')) return { rows: [{ ...current, sale_price: '189.90' }] };
      if (sql.includes('SELECT id FROM audit.events')) return { rows: requests.has(String(values[2])) ? [{ id: 'audit' }] : [] };
      if (sql.includes('INSERT INTO audit.events')) { requests.add(JSON.parse(String(values[2])).request_message_id); return { rows: [] }; }
      throw new Error('Consulta inesperada');
    });
    const c = { query } as never, sameMessage = { conversationId: 'conversation-a', requestId: 'message-a' };
    const next = { ...routing, items: [{ ...routing.items[0]!, unit_price: 189.9 }] };
    expect(await validatePartnerRetailQuote(c, 'prod', next, [{ product_id: 'product-a', preco_unitario: 179.9 }], sameMessage)).toMatchObject({ ok: false });
    expect(await validatePartnerRetailQuote(c, 'prod', next, [{ product_id: 'product-a', preco_unitario: 189.9 }], sameMessage))
      .toMatchObject({ ok: false, response: { nova_confirmacao_obrigatoria: true } });
    expect(await validatePartnerRetailQuote(c, 'prod', next, [{ product_id: 'product-a', preco_unitario: 189.9 }],
      { ...sameMessage, requestId: 'new-customer-message' })).toEqual({ ok: true });
    expect(query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO audit.events'))).toHaveLength(1);
  });

  it.each([{ rows: [] }, { rows: [{ ...current, sale_price: null }] }, { rows: [{ ...current, sale_price: '0' }] }, { rows: [{ ...current, product_id: 'other' }] }])(
    'não usa preço central se a linha local sumiu ou não tem preço válido', async ({ rows }) => {
      const query = vi.fn().mockResolvedValue({ rows });
      expect(await validatePartnerRetailQuote({ query } as never, 'test', routing,
        [{ product_id: 'product-a', preco_unitario: 179.9 }])).toMatchObject({ ok: false,
        response: { erro: 'partner_sale_price_missing' } });
      expect(query).toHaveBeenCalledTimes(1);
    });
});
