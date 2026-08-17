import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function varejoModule() {
  const sandbox = {
    window: {
      PAINEL_MODULES: {},
      prompt: vi.fn(() => 'Cancelamento de teste'),
      alert: vi.fn(),
    },
  };
  vm.runInNewContext(
    readFileSync('painel/public/app.varejo.js', 'utf8'),
    sandbox,
  );
  return sandbox.window.PAINEL_MODULES.varejo();
}

describe('atualizacao financeira do varejo', () => {
  it('recarrega o Financeiro depois de cancelar uma venda', async () => {
    const module = varejoModule();
    const context = {
      adminUser: { role: 'owner' },
      apiPost: vi.fn().mockResolvedValue({ cancelled: true }),
      loadRealData: vi.fn().mockResolvedValue(undefined),
      loadVendasData: vi.fn().mockResolvedValue(undefined),
      loadFinanceiro: vi.fn().mockResolvedValue(undefined),
    };

    await module.cancelarVarejo.call(context, {
      id: 'venda-1',
      status: 'Confirmado',
    });

    expect(context.apiPost).toHaveBeenCalledOnce();
    expect(context.loadRealData).toHaveBeenCalledOnce();
    expect(context.loadVendasData).toHaveBeenCalledOnce();
    expect(context.loadFinanceiro).toHaveBeenCalledOnce();
  });
});
