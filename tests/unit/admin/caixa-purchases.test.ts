import Fastify, { type FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CaixaAuth } from '../../../src/admin/caixa/queries.js';
const mocks = vi.hoisted(() => ({ suppliers: vi.fn(), report: vi.fn(), prices: vi.fn(), finance: vi.fn(), create: vi.fn(), confirm: vi.fn(), credit: true }));
vi.mock('../../../src/shared/config/env.js', () => ({ env: { FAREJADOR_ENV: 'test', get WHOLESALE_FINANCE() { return mocks.credit; } } }));
vi.mock('../../../src/persistence/db.js', () => ({ pool: {} }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { error: vi.fn(), warn: vi.fn() } }));
vi.mock('../../../src/admin/painel/queries-fornecedores.js', () => ({ listWholesaleSuppliers: mocks.suppliers }));
vi.mock('../../../src/admin/painel/queries-compras-relatorios.js', () => ({ getWholesalePurchaseReport: mocks.report }));
vi.mock('../../../src/admin/painel/queries-compras-precos.js', () => ({ getWholesalePriceReport: mocks.prices }));
vi.mock('../../../src/admin/painel/queries-fiado-despesas.js', () => ({ getWholesaleFinance: mocks.finance }));
vi.mock('../../../src/admin/painel/queries-fornecedores-registro.js', () => ({ registerWholesalePurchase: mocks.create, confirmWholesalePurchase: mocks.confirm }));
import { registerCaixaPurchaseRoutes } from '../../../src/admin/caixa/route-purchases.js';
import { calculateReceivedPurchaseMoney, calculateWholesalePurchaseMoney } from '../../../src/admin/painel/purchase-money.js';

describe('Compras do app usa o motor central', () => {
  let app: ReturnType<typeof Fastify>;
  const base = '/api/caixa/operacao/compras', id = '11111111-1111-4111-8111-111111111111';
  const headers = { authorization: 'owner', 'x-stock': 'yes' };
  const item = { measure: '90/90-18', brand: 'Technic', tire_condition: 'novo', vehicle_type: 'motorcycle', quantity: 6, unit_cost: 80 };
  const payload = { supplier_id: id, items: [item], purchased_at: '2026-01-01T12:00:00-03:00',
    payment_status: 'paid', payment_method: 'pix', paid_at: '2026-01-01T12:00:00-03:00',
    receipt_status: 'pending', idempotency_key: 'purchase-fixture-1', freight_amount: 20, discount_amount: 10 };
  beforeEach(async () => {
    vi.resetAllMocks(); mocks.credit = true; app = Fastify();
    registerCaixaPurchaseRoutes(app, async () => {}, async (req, reply) => {
      if (!req.headers.authorization) { await reply.code(401).send({ error: 'unauthorized' }); return; }
      (req as FastifyRequest & { caixa: Partial<CaixaAuth> }).caixa = {
        panelRole: req.headers.authorization === 'owner' ? 'owner' : 'admin', displayName: 'Maria', username: 'maria',
      };
    }, async (req, reply) => { if (req.headers['x-stock'] !== 'yes') await reply.code(403).send({ error: 'forbidden' }); });
    await app.ready();
  });
  afterEach(async () => app.close());
  const post = (suffix: string, body: object) => app.inject({ method: 'POST', url: base + suffix, headers, payload: body });
  it('restringe leituras e escritas ao proprietário autenticado com estoque', async () => {
    for (const suffix of ['', '/contexto', '/resumo', '/precos']) {
      expect((await app.inject({ url: base + suffix })).statusCode).toBe(401);
      expect((await app.inject({ url: base + suffix, headers: { authorization: 'owner' } })).statusCode).toBe(403);
      expect((await app.inject({ url: base + suffix, headers: { ...headers, authorization: 'admin' } })).statusCode).toBe(403);
    }
    for (const suffix of ['', '/lotes', '/revisao', '/lotes/revisao', '/confirmar']) {
      expect((await app.inject({ method: 'POST', url: base + suffix, headers: { ...headers, authorization: 'admin' }, payload })).statusCode).toBe(403);
    }
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.report).not.toHaveBeenCalled();
  });
  it('revisão calcula total no servidor sem gravar e ignora total, ambiente e autor enviados', async () => {
    const response = await post('/revisao', { ...payload, total_amount: 1, environment: 'prod', created_by: 'forged' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ productsCents: 48000, totalCents: 49000 });
    expect(response.headers['cache-control']).toBe('no-store'); expect(mocks.create).not.toHaveBeenCalled();
    mocks.create.mockResolvedValue({ purchase_id: id, stock_applied: false });
    expect((await post('', { ...payload, environment: 'prod', created_by: 'forged' })).statusCode).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith({ ...payload, environment: 'test', created_by: 'Caixa: Maria (maria)' });
  });
  it('consulta preços com o mesmo motor do web, período validado e ambiente do servidor', async () => {
    mocks.prices.mockResolvedValue([{ measure: '90/90-18', avg_cost: 80 }]);
    const result = await app.inject({ url: base + '/precos?from=2026-01-01&to=2026-02-01', headers });
    expect(result.statusCode).toBe(200); expect(result.json().rows).toHaveLength(1);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(mocks.prices).toHaveBeenCalledWith(expect.objectContaining({ from: '2026-01-01', to: '2026-02-01' }), 'test');
    for (const query of ['from=2026-02-30&to=2026-03-01', 'from=2026-03-01&to=2026-02-01',
      'from=2026-01-01', 'from=2026-01-01&to=2099-01-01', 'environment=prod', 'from=2020-01-01&to=2026-01-01']) {
      expect((await app.inject({ url: base + '/precos?' + query, headers })).statusCode).toBe(400);
    }
    expect(mocks.prices).toHaveBeenCalledTimes(1); expect(mocks.create).not.toHaveBeenCalled();
  });
  it('mantém a chave de repetição e entrega conflitos sem inventar uma nova compra', async () => {
    mocks.create.mockRejectedValue(new Error('idempotency_conflict'));
    const response = await post('', payload);
    expect(response.statusCode).toBe(409); expect(response.json().error).toBe('idempotency_conflict');
    expect(mocks.create.mock.calls[0]![0].idempotency_key).toBe(payload.idempotency_key);
  });
  it('valida frete, desconto, datas e parcelas pelas mesmas regras da compra web', async () => {
    for (const invalid of [{ discount_amount: 501 }, { items: [{ ...item, unit_cost: 80.001 }] },
      { purchased_at: '2099-01-01T12:00:00-03:00' }, { items: [{ ...item, quantity: 1.2 }] },
      { payment_status: 'pending', installments: [{ due_date: '2026-02-01', amount: 400 }] }]) {
      expect((await post('/revisao', { ...payload, ...invalid })).statusCode).toBe(400);
      expect((await post('', { ...payload, ...invalid })).statusCode).toBe(400);
    }
    expect(mocks.create).not.toHaveBeenCalled();
    const paidLater = { ...payload, payment_status: 'pending', installments: [{ due_date: '2026-02-01', amount: 245 }, { due_date: '2026-03-01', amount: 245 }] };
    expect((await post('/revisao', paidLater)).statusCode).toBe(200);
    mocks.credit = false;
    expect((await post('', paidLater)).json().error).toBe('wholesale_finance_disabled');
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('lote conserva o valor total e segue o serviço do web, inclusive recebimento', async () => {
    const lot = { new_supplier: { name: 'Distribuidora' }, lot: { description: 'Lote misto', quantity: 3, total_cost: 100 },
      purchased_at: payload.purchased_at, paid_at: payload.paid_at, payment_status: 'paid', payment_method: 'pix',
      receipt_status: 'received', received_at: payload.purchased_at, freight_amount: 12.34, discount_amount: 2.34,
      idempotency_key: 'lot-fixture-1' };
    expect((await post('/lotes/revisao', lot)).json().totalCents).toBe(11000);
    mocks.create.mockResolvedValue({ purchase_id: id });
    expect((await post('/lotes', lot)).statusCode).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith({ ...lot, items: [], environment: 'test', created_by: 'Caixa: Maria (maria)' });
    expect((await post('/lotes', { ...lot, items: [item] })).statusCode).toBe(400);
  });
  it('usa saldo a pagar do financeiro central e sinaliza indisponibilidade sem mostrar zero', async () => {
    mocks.report.mockResolvedValue({ summary: { pending_receipts: 3 } });
    mocks.finance.mockResolvedValue({ a_pagar_total: '2460.00', payables: [{ phone: 'private' }] });
    expect((await app.inject({ url: base + '/resumo', headers })).json()).toEqual({ pending_receipts: 3, payable_total: '2460.00' });
    expect(mocks.finance).toHaveBeenCalledWith('test');
    mocks.finance.mockRejectedValue(new Error('unavailable'));
    expect((await app.inject({ url: base + '/resumo', headers })).json()).toEqual({ pending_receipts: 3, payable_total: null });
  });
  it('transmite filtros e paginação para o relatório compartilhado', async () => {
    mocks.report.mockResolvedValue({ rows: [], pagination: { pages: 1 } });
    expect((await app.inject({ url: base + '?period=all&status=pending&payment=pending&page=2&page_size=10&search=OC-2026', headers })).statusCode).toBe(200);
    expect(mocks.report).toHaveBeenCalledWith(expect.objectContaining({ period: 'all', status: 'pending', payment: 'pending', page: 2, pageSize: 10, search: 'OC-2026' }), 'test');
    expect((await app.inject({ url: base + '?page=-1', headers })).statusCode).toBe(400);
  });
  it('confere quantidades pelo serviço compartilhado com autor e ambiente da sessão', async () => {
    mocks.confirm.mockResolvedValue({ purchase_id: id, stock_applied: true });
    const body = { purchase_id: id, idempotency_key: 'confirm-fixture', items: [{ item_id: id, accepted_quantity: 0 }] };
    expect((await post('/confirmar', { ...body, environment: 'prod', confirmed_by: 'forged' })).statusCode).toBe(200);
    expect(mocks.confirm).toHaveBeenCalledWith({ ...body, environment: 'test', confirmed_by: 'Caixa: Maria (maria)' });
    mocks.confirm.mockRejectedValue(new Error('purchase_already_confirmed'));
    expect((await post('/confirmar', body)).statusCode).toBe(409);
    expect((await post('/confirmar', { ...body, items: [{ item_id: id, accepted_quantity: -1 }] })).statusCode).toBe(400);
  });
});

describe('custo compartilhado da conferência com itens ausentes', () => {
  it('mantém zero para os ausentes e rateia todos os centavos somente entre os recebidos', () => {
    const result = calculateReceivedPurchaseMoney([
      { quantity: 0, unit_cost: 90 }, { quantity: 2, unit_cost: 50 }, { quantity: 0, unit_cost: 20 }, { quantity: 1, unit_cost: 100 },
    ], 10.01, 5);
    expect(result).toMatchObject({ productsCents: 20000, totalCents: 20501, allocatedItemCents: [0, 10251, 0, 10250] });
    expect(() => calculateWholesalePurchaseMoney([{ quantity: 0, unit_cost: 90 }])).toThrow('purchase_quantity_invalid');
  });
  it('recusa recebimento vazio, quantidades inválidas e desconto maior que o recebido', () => {
    expect(() => calculateReceivedPurchaseMoney([{ quantity: 0, unit_cost: 90 }])).toThrow('purchase_receipt_empty');
    expect(() => calculateReceivedPurchaseMoney([{ quantity: -1, unit_cost: 90 }])).toThrow('purchase_quantity_invalid');
    expect(() => calculateReceivedPurchaseMoney([{ quantity: 1.5, unit_cost: 90 }])).toThrow('purchase_quantity_invalid');
    expect(() => calculateReceivedPurchaseMoney([{ quantity: 0, unit_cost: 90 }, { quantity: 1, unit_cost: 10 }], 0, 11)).toThrow('discount_exceeds_purchase');
  });
});
