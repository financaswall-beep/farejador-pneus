import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function loadModule() {
  const integrity = {
    operation: vi.fn(() => ({ key: 'expense-remove-key' })),
    complete: vi.fn(),
    save: vi.fn(),
  };
  const sandbox = {
    window: {
      PAINEL_MODULES: {},
      PAINEL_INTEGRITY: integrity,
      lucide: { createIcons: vi.fn() },
    },
    console,
  };
  vm.runInNewContext(
    readFileSync('painel/public/app.financeiro.despesas.js', 'utf8'),
    sandbox,
  );
  return {
    module: sandbox.window.PAINEL_MODULES.financeiroDespesas(),
    integrity,
  };
}

describe('modal interno de remocao de despesa', () => {
  it('exige motivo e remove com trilha sem dialogo nativo do navegador', async () => {
    const { module, integrity } = loadModule();
    const apiPost = vi.fn().mockResolvedValue({ removed: true });
    const focus = vi.fn();
    const context = {
      ...module,
      despesaRemoveDialog: {
        open: false, row: null, reason: '', error: null, saving: false,
      },
      despesaCategorias: [{ id: 'outros', label: 'Outros' }],
      despesaMsg: null,
      apiPost,
      loadFinanceiro: vi.fn(),
      $refs: { despesaRemoveReason: { focus } },
      $nextTick: (callback: () => void) => callback(),
      formatCurrency: (value: number) => `R$ ${value.toFixed(2)}`,
    };
    const row = {
      id: 'expense-1',
      category: 'outros',
      description: 'Despesa duplicada',
      amount: '12.34',
    };

    module.despesaRemove.call(context, row);
    expect(context.despesaRemoveDialog).toMatchObject({ open: true, row });
    expect(focus).toHaveBeenCalledOnce();

    await module.despesaConfirmarRemocao.call(context);
    expect(apiPost).not.toHaveBeenCalled();
    expect(context.despesaRemoveDialog.error).toContain('pelo menos 2 caracteres');

    context.despesaRemoveDialog.reason = 'Lançamento duplicado';
    await module.despesaConfirmarRemocao.call(context);

    expect(apiPost).toHaveBeenCalledWith('/admin/api/matriz/despesas/remove', {
      id: 'expense-1',
      reason: 'Lançamento duplicado',
      idempotency_key: 'expense-remove-key',
    });
    expect(integrity.save).toHaveBeenCalledOnce();
    expect(integrity.complete).toHaveBeenCalledWith('matriz-expense-remove', 'expense-1');
    expect(context.loadFinanceiro).toHaveBeenCalledOnce();
    expect(context.despesaRemoveDialog.open).toBe(false);
    expect(context.despesaMsg).toMatchObject({ ok: true });
  });
});
