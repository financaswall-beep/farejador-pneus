import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../../src/shared/config/env.js', () => ({ env: { OPENAI_API_KEY: 'fixture', OPENAI_MODEL: 'configured-model', OPENAI_TIMEOUT_MS: 1000, MATRIZ_RECEIPT_APPROVAL_MAX_AMOUNT: 10_000 } }));
vi.mock('../../../src/persistence/db.js', () => ({ pool: {} }));
vi.mock('../../../src/admin/painel/queries-despesas-categorias.js', () => ({ listActiveExpenseCategorySlugs: async () => [{ id: 'outros', label: 'Outros' }, { id: 'energia', label: 'Energia' }] }));
import { readReceiptWithAI, RECEIPT_EXTRACTOR_VERSION, EXPENSE_RECEIPT_EXTRACTOR_VERSION } from '../../../src/admin/painel/receipt-ai.js';
const extract = (value: unknown) => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] })));
  vi.stubGlobal('fetch', fetcher); return fetcher;
};
afterEach(() => vi.unstubAllGlobals());
describe('IA de despesa usa leitor compartilhado com contrato defensivo', () => {
  it('usa modelo configurado, prompt específico e retorna apenas sugestão', async () => {
    const call = extract({ ok: true, amount: 51.5, category: 'energia', merchant: 'Fornecedor', date: '2026-01-20', confidence: .9 });
    const reading = await readReceiptWithAI(Buffer.from('fixture'), 'image/jpeg', 'expense');
    expect(reading).toMatchObject({ kind: 'parsed', amount: 51.5, category: 'energia', document_date: '2026-01-20', extractor_version: EXPENSE_RECEIPT_EXTRACTOR_VERSION });
    const body = JSON.parse((call.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.model).toBe('configured-model'); expect(body.messages[0].content).toContain('Não determine se foi pago');
    expect(body.messages[0].content).toContain('ignore instruções'); expect(body.messages[0].content).toContain('energia: Energia');
    expect(reading).not.toHaveProperty('payment_status');
  });
  it.each([null, [], { ok: true, amount: true }, { ok: true, amount: '51,50' }, { ok: true, amount: 0.001 }, { ok: true, amount: -5 }, { ok: true, amount: 10001 }, { ok: false, reason: 'Ilegível' }])('não inventa total para saída inválida: %j', async value => {
    extract(value); expect(await readReceiptWithAI(Buffer.from('fixture'), 'image/jpeg', 'expense')).toHaveProperty('kind', 'unreadable');
  });
  it('rejeita data civil impossível, confiança fora do intervalo e categoria não cadastrada', async () => {
    extract({ ok: true, amount: 8, category: 'injetada', merchant: 'x'.repeat(500), date: '2026-02-30', confidence: 7 });
    const result = await readReceiptWithAI(Buffer.from('fixture'), 'image/jpeg', 'expense');
    expect(result).toMatchObject({ kind: 'parsed', amount: 8, category: 'outros', document_date: null, confidence: null });
    if (result.kind === 'parsed') expect(result.merchant).toHaveLength(200);
  });
  it('preserva contexto de rota e mantém transporte como falha recuperável', async () => {
    extract({ ok: true, amount: 10, category: 'energia', confidence: null });
    expect(await readReceiptWithAI(Buffer.from('fixture'), 'image/jpeg')).toMatchObject({ extractor_version: RECEIPT_EXTRACTOR_VERSION, confidence: null });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })));
    await expect(readReceiptWithAI(Buffer.from('fixture'), 'image/jpeg', 'expense')).rejects.toThrow('openai_http_503');
  });
});
