import fs from 'node:fs';
import vm from 'node:vm';
import { describe, it, expect, vi } from 'vitest';
import { transferPlanSchema, stockCostForCapital, stockCapital } from '../../../src/admin/painel/tire-transfer-plan.js';
import { requiredMatrixModules } from '../../../src/admin/panel-modules.js';
vi.mock('../../../src/persistence/db.js', () => ({ pool: {} }));
vi.mock('../../../src/shared/config/env.js', () => ({ env: { FAREJADOR_ENV: 'test' } }));

function fixture(storage = new Map<string, string>()) {
  const sandbox: any = { window: { PAINEL_MODULES: {} }, URLSearchParams,
    document: { activeElement: { focus: vi.fn() }, getElementById: () => null },
    sessionStorage: { getItem: (k: string) => storage.get(k) || null,
      setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
    crypto: { randomUUID: () => 'fixed-attempt-key' } };
  vm.runInNewContext(fs.readFileSync('painel/public/app.estoque.transferencias.js', 'utf8'), sandbox);
  const app: any = { ...sandbox.window.PAINEL_MODULES.estoqueTransferencias(), serverEnvironment: 'test',
    adminUser: { id: 'owner', role: 'owner' }, $nextTick: (f: () => void) => f(),
    apiPost: vi.fn(), apiGet: vi.fn().mockResolvedValue({ rows: [] }), tireLotSourcesLoad: vi.fn(),
    tireLotsLoad: vi.fn(), tireLotsLoadMovements: vi.fn(), loadAtacado: vi.fn() };
  return { app, storage };
}
describe('transferências de pneus', () => {
  it('não aceita ambiente ou custo enviados no formulário e restringe rotas ao estoque', () => {
    const body = { kind: 'loss', lot_id: 'e15ad170-e356-4ce9-8e59-dc192c875b0a', quantity: 2, reason: 'Inutilizáveis' };
    expect(transferPlanSchema.safeParse(body).success).toBe(true);
    for (const extra of [{ environment: 'prod' }, { cost: 0 }, { quantity: 0 }, { quantity: 2.5 }]) {
      expect(transferPlanSchema.safeParse({ ...body, ...extra }).success).toBe(false);
    }
    for (const route of ['stock-transfers','stock-transfers/preview','stock-transfers/reverse','stock-transfer-products']) {
      expect(requiredMatrixModules('/admin/api/wholesale/' + route)).toEqual(['estoque']);
    }
  });
  it('fecha custo em centavos para quantidades fracionárias de valor médio', () => {
    for (const quantity of [1, 2, 3, 200, 210, 9999]) for (const cents of [0, 1, 100, 385000]) {
      const unit_cost = stockCostForCapital(cents, quantity);
      expect(stockCapital({ quantity_on_hand: quantity, unit_cost })).toBe(cents);
    }
  });
  it('exige prévia e congela a tentativa em caso de resposta perdida', async () => {
    const { app, storage } = fixture();
    await app.stOpen('loss', { id: 'lot-a' }); app.st.reason = 'Pneus inutilizáveis';
    await app.stConfirm(); expect(app.apiPost).not.toHaveBeenCalled();
    app.st.preview = { input: app.stBody(), fingerprint: 'fingerprint' };
    app.apiPost.mockRejectedValueOnce(Error('network_error'));
    await app.stConfirm(); const first = app.apiPost.mock.calls[0]; expect(storage.size).toBe(1);
    app.st.reason = 'Outro motivo'; app.st.quantity = 99;
    app.apiPost.mockResolvedValueOnce({ id: 'transfer-id' }); await app.stConfirm();
    expect(app.apiPost.mock.calls[1]).toEqual(first); expect(storage.size).toBe(0);
    expect(app.tireLotsLoad).toHaveBeenCalledOnce();
  });
  it('recupera a referência da tentativa anterior ao abrir outro lote', async () => {
    const { app, storage } = fixture();
    storage.set(app.stKey(), JSON.stringify({ input: { kind: 'loss', lot_id: 'original', quantity: 2, reason: 'Motivo original' },
      fingerprint: 'original-fingerprint', idempotency_key: 'previous-key' }));
    await app.stOpen('loss', { id: 'another-lot' });
    expect(app.st.lot.id).toBe('original'); expect(app.st.quantity).toBe(2); expect(app.st.reason).toBe('Motivo original');
  });
  it('bloqueia reenvio quando a sessão não permite recuperar a tentativa', async () => {
    const { app, storage } = fixture(); storage.set(app.stKey(), 'invalid-json');
    await app.stOpen('loss', { id: 'lot' }); await app.stPreview(); await app.stConfirm();
    expect(app.st.recoveryBlocked).toBe(true); expect(app.apiPost).not.toHaveBeenCalled();
  });
  it('mantém produtos já escolhidos ao buscar outra medida e limpa prévia vencida', async () => {
    const { app } = fixture(); app.st.products = [{ id: 'selected', measure: '130/70-13' }];
    app.st.items = [{ product_id: 'selected', quantity: 1 }]; app.apiGet.mockResolvedValueOnce({ rows: [{ id: 'new', measure: '90/90-12' }] });
    await app.stProducts(); expect(app.st.products.map((p: any) => p.id)).toEqual(['selected','new']);
    app.st.preview = { input: { kind: 'loss', lot_id: 'id', quantity: 1, reason: 'Motivo' }, fingerprint: 'old' };
    app.apiPost.mockRejectedValueOnce(Error('transfer_preview_changed')); await app.stConfirm();
    expect(app.st.pending).toBe(null); expect(app.st.preview).toBe(null);
  });
});
