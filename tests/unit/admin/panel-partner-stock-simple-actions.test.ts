import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

function actionModule() {
  const sandbox: Record<string, any> = {
    window: {}, lucide: { createIcons() {} }, encodeURIComponent,
  };
  runInNewContext(source('painel/public/app.partner-estoque.actions.js'), sandbox);
  return sandbox.window.PAINEL_MODULES.partnerEstoqueActions();
}

function app() {
  const result: any = {
    panelWorkplace: { role: 'funcionario' }, panelModules: ['estoque', 'compras'],
    partnerEstoque: { rows: [], notice: '', selected: null },
    partnerApiWrite: vi.fn(), loadPartnerEstoque: vi.fn(),
    partnerEstoqueClose: vi.fn(), formatCurrency: (value: number) => `R$ ${value.toFixed(2)}`,
    isPartnerPanel: () => true,
    hasPanelModule(module: string) { return this.panelModules.includes(module); },
    $nextTick: (callback: () => void) => callback(),
  };
  Object.defineProperties(result, Object.getOwnPropertyDescriptors(actionModule()));
  return result;
}

describe('ações simples do estoque do parceiro', () => {
  it('cadastra pneu com medida, condição, saldo e preço, sem custo', async () => {
    const target = app();
    target.partnerApiWrite.mockResolvedValue({ stock_id: 'stock-1' });
    target.partnerEstoqueOpenNew();
    Object.assign(target.partnerEstoqueNew, {
      tire_size: '110/70-17', brand: 'Pirelli', tire_condition: 'novo',
      quantity_on_hand: 5, minimum_quantity: 2, sale_price: 149.9,
    });

    await target.partnerEstoqueSubmitNew();

    expect(target.partnerApiWrite).toHaveBeenCalledWith('operacao/estoque/itens', 'POST', {
      tire_size: '110/70-17', brand: 'Pirelli', tire_condition: 'novo',
      quantity_on_hand: 5, minimum_quantity: 2, sale_price: 149.9,
    });
    expect(target.partnerApiWrite.mock.calls[0]?.[2]).not.toHaveProperty('average_cost');
    expect(target.partnerEstoque.notice).toContain('cadastrado');
    expect(target.loadPartnerEstoque).toHaveBeenCalledOnce();
  });

  it('corrige o saldo oficial e mostra a trava de pneus reservados', async () => {
    const target = app();
    const row = {
      stock_id: '11111111-1111-4111-8111-111111111111', item_type: 'pneu',
      item_name: '110/70-17', quantity_on_hand: 5, quantity_reserved: 2,
    };
    target.partnerEstoque.rows = [row];
    target.partnerApiWrite.mockRejectedValueOnce({ code: 'stock_balance_below_reserved' });
    target.partnerEstoqueOpenBalance(row);
    target.partnerEstoqueBalance.quantity_on_hand = 1;

    await target.partnerEstoqueSubmitBalance();
    expect(target.partnerEstoqueBalance.error).toContain('2 reservado');

    target.partnerApiWrite.mockResolvedValueOnce({ changed: true });
    target.partnerEstoqueBalance.quantity_on_hand = 4;
    await target.partnerEstoqueSubmitBalance();
    expect(target.partnerApiWrite).toHaveBeenLastCalledWith(
      `operacao/estoque/${row.stock_id}/saldo`, 'POST', { quantity_on_hand: 4 },
    );
    expect(target.partnerEstoque.notice).toContain('Saldo corrigido');
  });

  it('altera o preço local para operador com permissão de Estoque', async () => {
    const target = app();
    const row = {
      stock_id: '11111111-1111-4111-8111-111111111111', item_type: 'pneu',
      item_name: '110/70-17', sale_price: 130,
    };
    target.partnerEstoque.rows = [row];
    target.partnerApiWrite.mockResolvedValue({ changed: true });
    target.partnerEstoqueOpenPrice(row);
    target.partnerEstoquePrice.sale_price = 139.9;
    await target.partnerEstoqueSubmitPrice();

    expect(target.partnerApiWrite).toHaveBeenCalledWith(
      `operacao/estoque/${row.stock_id}/preco`, 'POST', {
        sale_price: 139.9, reason: 'Alterado na tela simples de estoque',
      },
    );
    expect(target.partnerEstoqueCanManage()).toBe(true);
    expect(target.partnerEstoqueOwner()).toBe(true);
    target.panelModules = ['vendas'];
    expect(target.partnerEstoqueCanManage()).toBe(false);
  });

  it('não usa API administrativa nem expõe custo no navegador', () => {
    const moduleSource = source('painel/public/app.partner-estoque.actions.js');
    expect(moduleSource).not.toContain('/admin/api');
    expect(moduleSource).not.toContain('average_cost');
    expect(moduleSource).not.toContain('unit_cost');
  });
});
