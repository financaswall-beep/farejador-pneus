import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

function moduleFrom(file: string, name: string) {
  const sandbox: Record<string, any> = {
    window: {}, lucide: { createIcons() {} },
    crypto: { randomUUID: () => '11111111-1111-4111-8111-111111111111' },
    URL: { createObjectURL: () => 'blob:photo' }, encodeURIComponent,
  };
  runInNewContext(source(file), sandbox);
  return sandbox.window.PAINEL_MODULES[name]();
}

function appWith(module: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  const app: any = {
    isPartnerPanel: () => true,
    hasPanelModule: (name: string) =>
      ['financeiro', 'resumo', 'logistica', 'entregas'].includes(name),
    panelWorkplace: { role: 'owner' }, partnerApiGet: vi.fn(),
    partnerApiWrite: vi.fn(), partnerApiBlob: vi.fn(),
    partnerPanelErrorCode: (error: any) => error?.message || 'api_error',
    $nextTick: (callback: () => void) => callback(), ...overrides,
  };
  Object.defineProperties(app, Object.getOwnPropertyDescriptors(module));
  return app;
}

describe('contratos Financeiro e Logística do parceiro', () => {
  it('usa somente partnerApi, preserva PATCH escopado e respeita teto de tamanho', () => {
    const finance = source('painel/public/app.partner-financeiro.js');
    const logistics = source('painel/public/app.partner-logistica.js');
    const api = source('painel/public/app.partner-api.js');
    for (const code of [finance, logistics]) {
      expect(code).not.toContain('/admin/api');
      expect(code).not.toMatch(/\bthis\.api(?:Get|Post|Put|Delete)\s*\(/);
      expect(code.split(/\r?\n/).length).toBeLessThanOrEqual(300);
    }
    expect(api).toContain("['GET', 'POST', 'PUT', 'PATCH', 'DELETE']");
    expect(api).toContain("['POST', 'PUT', 'PATCH', 'DELETE']");
    expect(api).toContain("resource.includes('..')");
    expect(logistics).not.toContain('prompt(');
  });

  it('mantém a logística em duas colunas e não cria entrega solta', () => {
    const html = source('painel/public/index.html');
    expect(html).toContain('data-partner-logistics-kpis');
    expect(html).toContain('data-partner-logistics-workspace');
    expect(html).toContain('Detalhes da entrega');
    expect(html).toContain('Quem vai entregar?');
    expect(html).toContain('Confirmar retorno físico');
    expect(html).toContain("partnerResumoGo('vendas','partnerVendasNew')");
    expect(html).not.toContain('> Nova entrega</button>');
  });

  it('preserva zeros e nunca recompõe lucro ou caixa no navegador', async () => {
    const apiGet = vi.fn(async (resource: string) => {
      if (resource === 'resumo') return { rows: [{
        confirmed_result_month: 0, pending_cost_items_month: 0, sales_month: 0,
        known_cogs_month: 0, expenses_month: 0, cash_net_month: 0,
        open_receivables_total: 0, open_payables_total: 0,
      }] };
      if (resource === 'fluxo-caixa') return { rows: [{ today_in: 0, today_out: 0 }] };
      if (resource.startsWith('financeiro-simples')) return {
        cash_net: 0, cash_in: 0, cash_out: 0, receivable_total: 99,
      };
      if (resource.startsWith('financeiro-')) return { total: 0, rows: [] };
      return { rows: [] };
    });
    const app = appWith(moduleFrom(
      'painel/public/app.partner-financeiro.js', 'partnerFinanceiro',
    ), { partnerApiGet: apiGet });
    await app.loadPartnerFinanceiro();
    expect(app.partnerFinanceiroTruth()).toEqual({
      competence_month: 0, pending_cost_items_month: 0, sales_month: 0,
      known_cogs_month: 0, expenses_month: 0, cash_month: 0,
      cash_range: 0, cash_in_range: 0, cash_out_range: 0,
      open_receivables: 0, open_payables: 0,
    });
    const code = source('painel/public/app.partner-financeiro.js');
    expect(code).not.toMatch(/confirmed_result_month\s*[+\-*/]/);
    expect(code).not.toMatch(/cash_net_month\s*[+\-*/]/);
    expect(code).not.toMatch(/open_receivables_total\s*[+\-*/]/);
  });

  it('funcionário autorizado não consulta endpoints exclusivos do owner', async () => {
    const apiGet = vi.fn().mockResolvedValue({ rows: [] });
    const app = appWith(moduleFrom(
      'painel/public/app.partner-financeiro.js', 'partnerFinanceiro',
    ), {
      panelWorkplace: { role: 'funcionario' }, partnerApiGet: apiGet,
      hasPanelModule: (name: string) => name === 'financeiro',
    });
    await app.loadPartnerFinanceiro();
    expect(apiGet.mock.calls.map(([resource]) => resource)).toEqual([
      'fluxo-caixa', 'despesas', 'compras', 'contas-a-pagar', 'contas-a-receber',
    ]);
  });

  it('não envia valor nulo na edição e usa PATCH somente para título autônomo', async () => {
    const apiWrite = vi.fn().mockResolvedValue({ updated: true });
    const app = appWith(moduleFrom(
      'painel/public/app.partner-financeiro.js', 'partnerFinanceiro',
    ), { partnerApiWrite: apiWrite });
    app.loadPartnerFinanceiro = vi.fn().mockResolvedValue(undefined);
    const row = {
      id: '22222222-2222-4222-8222-222222222222', description: 'Aluguel',
      amount: '500.00', due_date: '2026-08-30', category: 'rent',
      managed_by_matrix: false,
    };
    expect(app.partnerFinanceiroEdit('payable', row, { amount: null })).toBe(false);
    expect(apiWrite).not.toHaveBeenCalled();
    await app.partnerFinanceiroEdit('payable', row, { description: 'Aluguel da loja' });
    expect(apiWrite).toHaveBeenCalledWith(`contas-a-pagar/${row.id}`, 'PATCH', {
      counterparty_name: null, description: 'Aluguel da loja', category: 'rent',
      amount: 500, due_date: '2026-08-30', notes: null,
    });
  });

  it('recuperação exige owner, valor e forma de recebimento', async () => {
    const apiWrite = vi.fn().mockResolvedValue({ recovered: true });
    const app = appWith(moduleFrom(
      'painel/public/app.partner-financeiro.js', 'partnerFinanceiro',
    ), { partnerApiWrite: apiWrite });
    app.loadPartnerFinanceiro = vi.fn().mockResolvedValue(undefined);
    const row = { id: '33333333-3333-4333-8333-333333333333' };
    expect(app.partnerFinanceiroCredit('recuperar', row, {
      reason: 'cliente pagou', amount: 30,
    })).toBe(false);
    expect(apiWrite).not.toHaveBeenCalled();
    await app.partnerFinanceiroCredit('recuperar', row, {
      reason: 'cliente pagou', amount: 30, payment_method: 'Pix',
    });
    expect(apiWrite).toHaveBeenCalledWith(
      `contas-a-receber/${row.id}/recuperar`, 'POST',
      expect.objectContaining({ amount: 30, payment_method: 'Pix' }),
    );
  });

  it('adota paginação autoritativa e preserva total zero no histórico', async () => {
    const apiGet = vi.fn().mockResolvedValue({
      rows: [], summary: { preparing: 0, dispatched: 0, delivered: 0, returns: 0 },
      pagination: { view: 'history', page: 2, limit: 15, total: 0, has_more: false },
    });
    const app = appWith(moduleFrom(
      'painel/public/app.partner-logistica.js', 'partnerLogistica',
    ), { partnerApiGet: apiGet });
    await app.loadPartnerLogistica({ view: 'active', page: 9 });
    expect(apiGet).toHaveBeenCalledWith('operacao/entregas?view=active&page=9&limit=30');
    expect(app.partnerLogistica).toMatchObject({
      view: 'history', page: 2, limit: 15, total: 0, hasMore: false,
      summary: { preparing: 0, dispatched: 0, delivered: 0, returns: 0 },
    });
  });

  it('fecha máquina de estados e confirma retorno por ação explícita', async () => {
    const apiWrite = vi.fn().mockResolvedValue({ ok: true });
    const app = appWith(moduleFrom(
      'painel/public/app.partner-logistica.js', 'partnerLogistica',
    ), { partnerApiWrite: apiWrite });
    app.loadPartnerLogistica = vi.fn().mockResolvedValue(undefined);
    const dispatched = {
      order_id: '44444444-4444-4444-8444-444444444444',
      order_status: 'pending', delivery_status: 'dispatched', delivery_courier: null,
    };
    expect(app.partnerLogisticaTransitions(dispatched)).toEqual([
      'pending', 'delivered', 'failed',
    ]);
    expect(await app.partnerLogisticaMove(dispatched, 'delivered', {})).toBe(false);
    await app.partnerLogisticaMove(dispatched, 'delivered', { payment_method: 'Pix' });
    expect(apiWrite).toHaveBeenCalledWith(`entregas/${dispatched.order_id}`, 'POST', {
      delivery_status: 'delivered', delivery_courier: null,
      payment_method: 'Pix', reason: null,
    });
    apiWrite.mockClear();
    const failed = { ...dispatched, delivery_status: 'failed' };
    await app.partnerLogisticaConfirmReturn(failed, 'pneus voltaram');
    expect(apiWrite).toHaveBeenCalledWith(
      `entregas/${failed.order_id}/confirmar-retorno`, 'POST',
      { reason: 'pneus voltaram' },
    );
    expect(app.partnerLogistica.notice).toContain('sem entrada no caixa');
  });

  it('exige entregador ao sair e mantém a ordem simples no aparelho', async () => {
    const apiWrite = vi.fn().mockResolvedValue({ ok: true });
    const app = appWith(moduleFrom(
      'painel/public/app.partner-logistica.js', 'partnerLogistica',
    ), { partnerApiWrite: apiWrite, operatorLabel: '' });
    app.loadPartnerLogistica = vi.fn().mockResolvedValue(undefined);
    const pending = {
      order_id: '55555555-5555-4555-8555-555555555555',
      order_status: 'pending', delivery_status: 'pending', delivery_courier: null,
    };
    expect(await app.partnerLogisticaMove(pending, 'dispatched', {})).toBe(false);
    expect(app.partnerLogistica.actionError).toContain('quem vai fazer a entrega');
    await app.partnerLogisticaMove(pending, 'dispatched', { delivery_courier: 'João' });
    expect(apiWrite).toHaveBeenCalledWith(`entregas/${pending.order_id}`, 'POST', {
      delivery_status: 'dispatched', delivery_courier: 'João',
      payment_method: null, reason: null,
    });

    app.partnerLogistica.rows = [pending, { ...pending, order_id: 'outro' }];
    app.partnerLogistica.routeOrder = [pending.order_id, 'outro'];
    app.partnerLogisticaMoveOrder(pending, 1);
    expect(app.partnerLogistica.routeOrder).toEqual(['outro', pending.order_id]);
  });
});
