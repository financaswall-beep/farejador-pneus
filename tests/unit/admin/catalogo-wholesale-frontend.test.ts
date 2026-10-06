import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
function context() {
  const sandbox = { window: { PAINEL_MODULES: {} } };
  vm.runInNewContext(readFileSync('painel/public/app.catalogo.atacado.js', 'utf8'), sandbox);
  const row = { product_id: 'p1', product_type: 'tire', price_amount: 95, wholesale_price_amount: 65 };
  const ctx = { ...(sandbox.window.PAINEL_MODULES as any).catalogoAtacado(), adminUser: { role: 'owner' },
    catalogoSelecionado: row, catalogoRows: [row], catalogoPriceForm: { price: '105', reason: 'Varejo em edição' },
    apiGet: vi.fn().mockResolvedValue({ rows: [] }), apiPost: vi.fn() };
  ctx.catalogoAtacadoInit(row);
  return ctx;
}
describe('formulário de atacado sem interferir no varejo', () => {
  it('inicia com o preço separado e exige alteração e motivo', () => {
    const ctx = context();
    expect(ctx.catalogoAtacadoForm.price).toBe('65.00');
    expect(ctx.catalogoAtacadoCanSave()).toBe(false);
    ctx.catalogoAtacadoForm.reason = 'Tabela';
    expect(ctx.catalogoAtacadoCanSave()).toBe(false);
    ctx.catalogoAtacadoForm.price = '75,90';
    expect(ctx.catalogoAtacadoCanSave()).toBe(true);
    ctx.catalogoAtacadoForm.price = '75.999';
    expect(ctx.catalogoAtacadoCanSave()).toBe(false);
  });
  it('salva retirada da oferta sem recarregar nem apagar varejo em edição', async () => {
    const ctx = context();
    ctx.catalogoAtacadoForm = { price: '', reason: '  Retirar oferta  ' };
    ctx.apiPost.mockResolvedValue({ changed: true, price_amount: null });
    await ctx.catalogoAtacadoSave();
    expect(ctx.apiPost).toHaveBeenCalledWith('/admin/api/catalog/p1/wholesale-price', { price_amount: null, reason: 'Retirar oferta' });
    expect(ctx.catalogoSelecionado).toMatchObject({ price_amount: 95, wholesale_price_amount: null });
    expect(ctx.catalogoPriceForm).toEqual({ price: '105', reason: 'Varejo em edição' });
    expect(ctx.catalogoAtacadoMessage.ok).toBe(true);
  });
  it('mantém os valores digitados após falha e bloqueia salvamento concorrente', async () => {
    const ctx = context();
    ctx.catalogoAtacadoForm = { price: '75', reason: 'Nova tabela' };
    ctx.apiPost.mockRejectedValue(new Error('offline'));
    await ctx.catalogoAtacadoSave();
    expect(ctx.catalogoAtacadoForm).toEqual({ price: '75', reason: 'Nova tabela' });
    expect(ctx.catalogoAtacadoMessage.ok).toBe(false);
    ctx.catalogoSaving = true;
    expect(ctx.catalogoAtacadoCanSave()).toBe(false);
    ctx.catalogoSaving = false; ctx.adminUser.role = 'staff';
    expect(ctx.catalogoAtacadoCanSave()).toBe(false);
  });
  it('ignora histórico atrasado de outro produto', async () => {
    const ctx = context();
    ctx.catalogoSelecionado = { product_id: 'p2' };
    ctx.apiGet.mockResolvedValue({ rows: [{ id: 'p1-history' }] });
    await ctx.catalogoAtacadoLoadHistory('p1');
    expect(ctx.catalogoAtacadoHistory).toEqual([]);
  });
});
