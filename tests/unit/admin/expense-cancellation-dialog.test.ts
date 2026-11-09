import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function fixture() {
  const operation = { key: 'cancel-unique-key', reason: '' };
  const integrity = { operation: vi.fn(() => operation), save: vi.fn(), complete: vi.fn() };
  const sandbox: any = { window: { PAINEL_MODULES: {}, PAINEL_INTEGRITY: integrity } };
  vm.runInNewContext(readFileSync('painel/public/app.financeiro.despesas.js', 'utf8'), sandbox);
  const context = { ...sandbox.window.PAINEL_MODULES.financeiroDespesas(),
    apiPost: vi.fn().mockResolvedValue({ cancelled: true }), loadFinanceiro: vi.fn(), loadFinExtrato: vi.fn(),
    $nextTick: (f: () => void) => f(), $refs: {}, despesaRemoveDialog: {}, despesaMsg: null };
  return { context, integrity };
}
describe('cancelamento de duplicidade acessível no extrato', () => {
  it('usa o ID da despesa, exige motivo e recarrega saldo, gráfico e extrato', async () => {
    const { context, integrity } = fixture();
    context.despesaCancelarErro({ id: 'ledger-id', source_id: 'expense-id', amount: '3900.00',
      cash_on: '2026-11-08', description: 'Pneus' }, true);
    await context.despesaConfirmarRemocao(); expect(context.apiPost).not.toHaveBeenCalled();
    context.despesaRemoveDialog.reason = 'Duplicidade';
    await context.despesaConfirmarRemocao();
    expect(context.apiPost).toHaveBeenCalledWith('/admin/api/matriz/despesas/cancel-error', {
      id: 'expense-id', reason: 'Duplicidade', idempotency_key: 'cancel-unique-key' });
    expect(integrity.complete).toHaveBeenCalledWith('matriz-expense-cancel-error', 'expense-id');
    expect(context.loadFinanceiro).toHaveBeenCalledOnce(); expect(context.loadFinExtrato).toHaveBeenCalledOnce();
  });
  it('reenvia a mesma tentativa após resposta perdida, mesmo se o motivo for editado', async () => {
    const { context } = fixture();
    context.despesaCancelarErro({ id: 'expense-id', amount: '3900.00' });
    context.despesaRemoveDialog.reason = 'Duplicidade';
    context.apiPost.mockRejectedValueOnce(Error('network_error'));
    await context.despesaConfirmarRemocao();
    expect(context.despesaRemoveDialog.open).toBe(true);
    context.despesaRemoveDialog.reason = 'Texto editado';
    await context.despesaConfirmarRemocao();
    expect(context.apiPost.mock.calls[1]).toEqual(context.apiPost.mock.calls[0]);
  });
  it('mostra bloqueio de devolução recebida sem fechar o diálogo nem recarregar dados', async () => {
    const { context } = fixture();
    context.despesaCancelarErro({ id: 'expense-id', amount: '3900.00' });
    context.despesaRemoveDialog.reason = 'Duplicidade';
    context.apiPost.mockRejectedValueOnce(Error('expense_refund_has_payments'));
    await context.despesaConfirmarRemocao();
    expect(context.despesaRemoveDialog.error).toContain('já teve uma baixa');
    expect(context.despesaRemoveDialog.open).toBe(true); expect(context.loadFinanceiro).not.toHaveBeenCalled();
  });
});
