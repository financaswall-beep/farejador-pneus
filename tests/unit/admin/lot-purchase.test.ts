import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import { calculateLotPurchaseMoney } from '../../../src/admin/painel/lot-purchase-money.js';
import { registerLotPurchaseSchema } from '../../../src/admin/painel/route-schemas-lot-purchases.js';

describe('compra de lote pelo valor total', () => {
  it('preserva centavos quando a divisão por pneu é inexata e considera frete/desconto', () => {
    const result = calculateLotPurchaseMoney({ description: 'Borracharia', quantity: 3, total_cost: 100 }, 12.34, 2.34);
    expect(result.productsCents).toBe(10000); expect(result.totalCents).toBe(11000);
    expect(result.allocatedItemCents).toEqual([11000]);
  });
  it.each([0, -1, 1.5, 100001, NaN])('rejeita quantidade inválida %s', quantity => {
    expect(() => calculateLotPurchaseMoney({ description: 'Lote', quantity, total_cost: 10 })).toThrow();
  });
  it.each([0, -1, 10.001, Infinity, NaN])('rejeita valor inválido %s', total_cost => {
    expect(() => calculateLotPurchaseMoney({ description: 'Lote', quantity: 10, total_cost })).toThrow();
  });
  const body = { new_supplier: { name: 'Fornecedor' }, lot: { description: 'Lote', quantity: 3, total_cost: 100 },
    purchased_at: '2026-01-01T15:00:00Z', received_at: '2026-01-02T15:00:00Z',
    paid_at: '2026-01-03T15:00:00Z', payment_status: 'paid', payment_method: 'Pix',
    receipt_status: 'received', idempotency_key: 'purchase-test-001' };
  it('permite lote sem marca/medida e impede misturar itens do catálogo', () => {
    expect(registerLotPurchaseSchema.safeParse(body).success).toBe(true);
    expect(registerLotPurchaseSchema.safeParse({ ...body, items: [] }).success).toBe(false);
    expect(registerLotPurchaseSchema.safeParse({ ...body, supplier_id: '8bbf311d-6cda-499d-a503-2f58198f6ddc' }).success).toBe(false);
  });
  it('cobra vencimento a prazo e data de recebimento coerente', () => {
    expect(registerLotPurchaseSchema.safeParse({ ...body, payment_status: 'pending' }).success).toBe(false);
    expect(registerLotPurchaseSchema.safeParse({ ...body, received_at: '2025-12-30T15:00:00Z' }).success).toBe(false);
    expect(registerLotPurchaseSchema.safeParse({ ...body, paid_at: undefined }).success).toBe(false);
  });
});

function app() {
  const storage = new Map();
  const window: any = { PAINEL_MODULES: {}, PAINEL_INTEGRITY: { operation: () => ({ key: 'fixed-request-key' }), complete: vi.fn() } };
  const sessionStorage = { getItem: (k: string) => storage.get(k), setItem: (k: string,v: string) => storage.set(k,v), removeItem: (k: string) => storage.delete(k) };
  vm.runInNewContext(fs.readFileSync('painel/public/app.compras.lotes.js','utf8'), { window, sessionStorage, Intl });
  vm.runInNewContext(fs.readFileSync('painel/public/app.compras.fornecedor.js','utf8'), {window});
  const state: any = { ...window.PAINEL_MODULES.comprasLotes(), ...window.PAINEL_MODULES.fornecedorFinanceiro(), adminUser: { role: 'owner', id: 'test' },
    serverEnvironment: 'test', atacadoFinance: true, finHoje: () => '2026-09-15',
    businessFactInstant: (d: string) => d+'T15:00:00Z', compraErrText: (s: string) => s,
    loadCompras: vi.fn(), loadFinanceiro: vi.fn(), loadSino: vi.fn(), $nextTick: vi.fn(),
    apiPost: vi.fn(), lotPurchaseSaving: false, lotPurchasePendingBody: null, lotPurchaseForm: null };
  state.lotPurchaseForm = { ...state.lotPurchaseFreshForm(), supplierKey: 'new', newName: 'Fornecedor',
    description: 'Lote para borracharia', quantity: '80', total_cost: '480' };
  return state;
}
describe('envio de compra no navegador', () => {
  it('envia crédito e o custo integral do lote e só pede pagamento se restar diferença',()=>{
    const a=app();
    a.fornecedores=[{id:'thiago',supplier_credit_available:'1000.00'}];
    Object.assign(a.lotPurchaseForm,{supplierKey:'thiago',total_cost:800,creditAmount:800,paid_at:'',payment_method:''});
    const covered=a.lotPurchaseBuildBody();
    expect(covered).toMatchObject({supplier_credit_amount:800,payment_status:'paid',lot:{total_cost:800}});
    expect(covered).not.toHaveProperty('payment_method');
    Object.assign(a.lotPurchaseForm,{total_cost:1200,creditAmount:1000,payment_status:'pending',due_date:'2026-10-01'});
    expect(a.lotPurchaseBuildBody()).toMatchObject({supplier_credit_amount:1000,due_date:'2026-10-01',lot:{total_cost:1200}});
    a.lotPurchaseForm.creditAmount=1100;expect(a.lotPurchaseBuildBody()).toBeNull();
  });
  it('salvar rascunho não registra compra ou movimenta estoque', () => {
    const a=app(); a.lotPurchaseSaveDraft(); expect(a.apiPost).not.toHaveBeenCalled();
    a.lotPurchaseForm=null; a.lotPurchaseOpen(); expect(a.lotPurchaseForm.quantity).toBe('80');
  });
  it('reenvia exatamente o mesmo conteúdo após resposta perdida, sem segunda compra', async () => {
    const a=app(); a.apiPost.mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce({lot_code:'LT-000001',order_code:'CP-001',stock_applied:true});
    await a.lotPurchaseSubmit(); const first=a.apiPost.mock.calls[0][1];
    expect(first.lot).toEqual({description:'Lote para borracharia',quantity:80,total_cost:480,vehicle_type:null});
    expect(first.items).toBeUndefined();
    a.lotPurchaseForm.quantity='99'; await a.lotPurchaseSubmit();
    expect(a.apiPost.mock.calls[1][1]).toBe(first);
    expect(a.lotPurchasePendingBody).toBeNull(); expect(a.lotPurchaseMsg.ok).toBe(true);
  });
  it('libera correção de rejeição definitiva e impede clique duplo', async () => {
    const a=app(); a.apiPost.mockRejectedValueOnce(Object.assign(new Error('invalid_body'),{status:400}));
    await a.lotPurchaseSubmit(); expect(a.lotPurchasePendingBody).toBeNull();
    a.lotPurchaseSaving=true; await a.lotPurchaseSubmit(); expect(a.apiPost).toHaveBeenCalledTimes(1);
  });
});
