import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

function app(role = 'owner') {
  const browser = { crypto: { randomUUID: () => 'test-attempt' } } as any;
  const ctx = vm.createContext({ window: browser });
  vm.runInContext(readFileSync('painel/public/app.logistica.conciliacao.js', 'utf8'), ctx);
  return Object.assign(browser.PAINEL_MODULES.logisticaConciliacao(), {
    adminUser: { role }, logistica: { receipt_approval: true, receipt_approval_finance: true, receipt_approval_max_amount: 10000 },
    $refs: { logConDialog: { showModal: vi.fn(), close: vi.fn() } },
    $nextTick: (fn: () => void) => fn(), loadLogistica: vi.fn(), loadSino: vi.fn(),
    logHistRevisar: vi.fn(), logHistVerDespesas: vi.fn(), apiPost: vi.fn(),
  });
}
const trip = { id: 'trip-5', trip_number: 'ROTA-0005', status: 'closed', fuel_spent: '22533.00', receipts: [] };
describe('Ação de resolver pendência na Logística', () => {
  it('abre a decisão mesmo sem comprovantes e permite consultar o motivo para funcionário', () => {
    const s = app('admin'); s.abrirConciliacaoRota(trip);
    expect(s.$refs.logConDialog.showModal).toHaveBeenCalledOnce();
    expect(s.logCon.trip.id).toBe('trip-5'); expect(s.logConPodeCorrigir()).toBe(false);
    const html = readFileSync('painel/public/index.html', 'utf8');
    expect(html).toContain('Resolver pendência');
    expect(html).toContain('logHistStatus(logisticaRotaSelecionada()) !== \'reconciled\'');
  });
  it('não abre com dados desatualizados nem deixa corrigir sem motivo e confirmação', () => {
    const s = app(); s.logHistErro = 'offline'; s.abrirConciliacaoRota(trip);
    expect(s.$refs.logConDialog.showModal).not.toHaveBeenCalled();
    s.logHistErro = ''; s.abrirConciliacaoRota(trip);
    expect(s.logConPodeCorrigir()).toBe(false);
    Object.assign(s.logCon, { amount: '0', confirmed: true, reason: 'Não houve gasto; erro de digitação' });
    expect(s.logConPodeCorrigir()).toBe(true);
    s.logCon.amount = '1,001'; expect(s.logConPodeCorrigir()).toBe(false);
  });
  it('mantém a mesma decisão e chave se perder a confirmação, sem sobrescrever com dados editados', async () => {
    const s = app(); s.abrirConciliacaoRota(trip);
    Object.assign(s.logCon, { amount: '0', confirmed: true, reason: 'Anotação feita por engano' });
    s.apiPost.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ financial_status: 'reconciled' });
    await s.logConSalvar(); expect(s.logCon.error).toContain('Verificar correção');
    s.logCon.amount = '99'; await s.logConSalvar();
    expect(s.apiPost.mock.calls[1][1]).toEqual(s.apiPost.mock.calls[0][1]);
    expect(s.apiPost.mock.calls[1][1]).toMatchObject({ amount: 0, expected_amount: 22533, idempotency_key: 'trip-fuel-test-attempt' });
    expect(s.loadLogistica).toHaveBeenCalledOnce(); expect(s.loadSino).toHaveBeenCalledOnce();
    expect(s.logisticaMsg.text).toContain('Nenhuma despesa');
  });
  it('mantém a pendência quando falta outra revisão e traduz o conflito de valor', async () => {
    const s = app(); s.abrirConciliacaoRota(trip);
    Object.assign(s.logCon, { amount: '0', confirmed: true, reason: 'Erro de digitação' });
    s.apiPost.mockRejectedValueOnce(new Error('trip_fuel_annotation_changed'));
    await s.logConSalvar(); expect(s.logCon.confirmed).toBe(false); expect(s.logCon.error).toContain('A anotação mudou');
    s.logCon.confirmed = true; s.apiPost.mockResolvedValue({ financial_status: 'pending' });
    await s.logConSalvar(); expect(s.logisticaMsg.text).toContain('ainda tem pendências');
  });
  it('encaminha para a revisão existente e mostra falha de upload dentro da janela', async () => {
    const s = app(); s.abrirConciliacaoRota(trip); s.logConRevisarComprovantes();
    expect(s.logHistRevisar).toHaveBeenCalledOnce();
    s.enviarComprovante = vi.fn().mockImplementation(() => { s.logisticaMsg = { ok: false, text: 'Foto inválida' }; });
    await s.logConAnexar({ target: { files: [{}] } }); expect(s.logCon.error).toBe('Foto inválida');
  });
  it('exige dono, gasto válido, pagamento escolhido e aprovação explícita para nota perdida', () => {
    const s = app(); s.abrirConciliacaoRota(trip); s.logConAbrirSemComprovante();
    expect(s.logConPodeSemComprovante()).toBe(false);
    Object.assign(s.logCon, { amount: '40,00', confirmed: true, reason: 'Nota perdida; gasto conferido',
      expense_date: '2026-10-03', payment_status: 'paid', payment_date: '2026-10-03' });
    expect(s.logConPodeSemComprovante()).toBe(true); expect(s.logConPodeCorrigir()).toBe(false);
    s.adminUser.role = 'admin'; expect(s.logConPodeSemComprovante()).toBe(false); s.adminUser.role = 'owner';
    s.logistica.receipt_approval_finance = false; expect(s.logConPodeSemComprovante()).toBe(false);
    s.logistica.receipt_approval_finance = true; s.logCon.payment_status = 'pending';
    expect(s.logConPodeSemComprovante()).toBe(false); s.logCon.due_date = '2026-10-10';
    expect(s.logConPodeSemComprovante()).toBe(true);
  });
  it('não muda a aprovação em dúvida e recupera a mesma chave depois de perder a resposta', async () => {
    const s = app(); s.abrirConciliacaoRota(trip); s.logConAbrirSemComprovante();
    Object.assign(s.logCon, { amount: '40', confirmed: true, reason: 'Nota perdida e valor conferido',
      expense_date: '2026-10-03', payment_status: 'paid', payment_date: '2026-10-03' });
    s.apiPost.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ financial_status: 'pending' });
    await s.logConSalvarSemComprovante(); expect(s.logCon.error).toContain('Verificar aprovação');
    s.logCon.amount = '99'; s.logCon.reason = 'Outro texto'; await s.logConSalvarSemComprovante();
    expect(s.apiPost.mock.calls[1][1]).toEqual(s.apiPost.mock.calls[0][1]);
    expect(s.apiPost.mock.calls[1][1]).toMatchObject({ amount: 40, idempotency_key: 'trip-lost-receipt-test-attempt' });
    expect(s.loadLogistica).toHaveBeenCalledOnce(); expect(s.logisticaMsg.text).toContain('outras pendências');
    expect(s.logisticaMsg.text).not.toContain('rota conciliada');
  });
  it('explica pendência de revisão e confirmações retroativas sem forçar nova tentativa', async () => {
    const s = app(); s.abrirConciliacaoRota(trip); s.logConAbrirSemComprovante();
    Object.assign(s.logCon, { amount: '40', confirmed: true, reason: 'Nota perdida e valor conferido',
      expense_date: '2026-01-03', payment_status: 'paid', payment_date: '2026-01-03' });
    s.apiPost.mockRejectedValueOnce(new Error('receipt_retroactive_confirmation_required'));
    await s.logConSalvarSemComprovante(); expect(s.logCon.error).toContain('mais de 3 meses');
    expect(s.logCon.attempt).toBeNull(); expect(s.logCon.confirmed).toBe(false);
  });
});
