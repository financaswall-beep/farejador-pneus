import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
vi.mock('../../../src/shared/config/env.js', () => ({ env: {} }));
import { reconcileDestination, reconciliationSchema, type Reconciliation } from '../../../src/marketing/publisher/reconciliation.js';
import type { PublishingGraph } from '../../../src/marketing/publisher/graph.js';
import { META_BUSINESS_ACCOUNTS as accounts } from '../../../src/shared/meta-business-accounts.js';
import { MetaCommentError } from '../../../src/social-comments/graph.js';

const snapshot = { status: 'uncertain', platform: 'instagram', account_id: accounts.instagram.id,
  container_id: '301', provider_id: null, media_kind: 'video', format: 'reel' };
const input = (extra: Partial<Reconciliation> = {}): Reconciliation => ({
  platform: 'instagram', version: 3, decision: 'published', confirmed: true,
  provider_id: '302', note: 'Conferido na conta da loja.', ...extra,
});
const graph = { reconcile: vi.fn() } as unknown as PublishingGraph;
let postVersion: number;
let currentStatus: string;
const client = { query: vi.fn(), release: vi.fn() };
const pool = { query: vi.fn(), connect: vi.fn() };
beforeEach(() => {
  vi.resetAllMocks(); postVersion = 3; currentStatus = 'uncertain';
  pool.query.mockResolvedValue({ rows: [snapshot] });
  pool.connect.mockResolvedValue(client);
  vi.mocked(graph.reconcile).mockResolvedValue({ outcome: 'published', provider_id: '302', url: null, evidence: 'owned' });
  client.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (sql.startsWith('SELECT * FROM ops.publisher_posts')) return { rows: [{ version: postVersion }] };
    if (sql.startsWith('SELECT * FROM ops.publisher_destinations')) return { rows: [{ ...snapshot, status: currentStatus }] };
    if (sql.startsWith('UPDATE ops.publisher_destinations')) currentStatus = String(params[3]);
    if (sql.startsWith('SELECT status FROM ops.publisher_destinations')) return { rows: [{ status: currentStatus }] };
    return { rows: [], rowCount: 1 };
  });
});

describe('Conciliação explícita e auditável por destino', () => {
  it('exige confirmação explícita, versão e observação; rejeita campos arbitrários', () => {
    for (const change of [{ confirmed: false }, { version: 0 }, { note: 'curta' }, { unknown: true }]) {
      expect(reconciliationSchema.safeParse({ ...input(), ...change }).success).toBe(false);
    }
    expect(reconciliationSchema.parse(input({ note: '  Conferido na conta da loja.  ' })).note).toBe('Conferido na conta da loja.');
  });
  it('confirma só com prova do provedor e registra ator, evidência e ambiente', async () => {
    const result = await reconcileDestination(pool as unknown as Pool, 'test', 'post', input(), 'owner', graph);
    expect(result).toMatchObject({ status: 'published', version: 4 });
    expect(graph.reconcile).toHaveBeenCalledWith(expect.objectContaining({ provider_id: '302', account_id: accounts.instagram.id }));
    expect(pool.query.mock.calls[0]?.[1]).toEqual(['test', 'post', 'instagram']);
    const audit = client.query.mock.calls.find(([sql]) => sql.startsWith('INSERT INTO ops.publisher_events'))!;
    expect(audit[1].slice(0, 4)).toEqual(['test', 'post', 'delivery_reconciled', 'owner']);
    expect(JSON.parse(audit[1][4])).toMatchObject({ evidence: 'owned', decision: 'published', provider_id: '302' });
  });
  it('não permite assumir publicação sem ID verificável', async () => {
    await expect(reconcileDestination(pool as unknown as Pool, 'test', 'post', input({ provider_id: undefined }), 'owner', graph))
      .rejects.toThrow('publisher_provider_required');
    expect(graph.reconcile).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
  });
  it('aceita link ou ID, mas rejeita duas referências ou link numa decisão de ausência', () => {
    const linked = input({ provider_id: undefined, post_url: 'https://instagram.com/reel/ABC/?igsh=tracking' });
    expect(reconciliationSchema.safeParse(linked).success).toBe(true);
    for (const change of [{ provider_id: '302' }, { decision: 'not_published' },
      { decision: 'abandon' }, { post_url: 'não é uma URL' }]) {
      expect(reconciliationSchema.safeParse({ ...linked, ...change }).success).toBe(false);
    }
  });
  it('confirma link somente com ID e URL verificados pelo provedor, sem salvar o link colado', async () => {
    const postUrl = 'https://instagram.com/reel/ABC/?igsh=tracking';
    const verifiedUrl = 'https://www.instagram.com/p/ABC/';
    vi.mocked(graph.reconcile).mockResolvedValue({ outcome: 'published', provider_id: '302', url: verifiedUrl, evidence: 'owned' });
    await reconcileDestination(pool as unknown as Pool, 'test', 'post', input({ provider_id: undefined, post_url: postUrl }), 'owner', graph);
    expect(graph.reconcile).toHaveBeenCalledWith(expect.objectContaining({ account_id: accounts.instagram.id, provider_id: null }), postUrl);
    const update = client.query.mock.calls.find(([sql]) => sql.startsWith('UPDATE ops.publisher_destinations'))!;
    expect(update[1].slice(0, 6)).toEqual(['test', 'post', 'instagram', 'published', '302', verifiedUrl]);
  });
  it('link ausente na lista da Meta mantém a conferência pendente sem abrir transação', async () => {
    vi.mocked(graph.reconcile).mockResolvedValue({ outcome: 'unknown', evidence: 'publication_link_not_found' });
    await expect(reconcileDestination(pool as unknown as Pool, 'test', 'post', input({ provider_id: undefined,
      post_url: 'https://instagram.com/p/missing/' }), 'owner', graph)).rejects.toThrow('publisher_post_url_not_found');
    expect(pool.connect).not.toHaveBeenCalled();
  });
  it('link inválido recebe erro 400 sem vazar detalhes do provedor ou alterar o destino', async () => {
    vi.mocked(graph.reconcile).mockRejectedValue(new MetaCommentError('publisher_post_url_invalid'));
    await expect(reconcileDestination(pool as unknown as Pool, 'test', 'post', input({ provider_id: undefined,
      post_url: 'https://other.test/p/302' }), 'owner', graph)).rejects.toMatchObject({ code: 'publisher_post_url_invalid', status: 400 });
    expect(pool.connect).not.toHaveBeenCalled();
  });
  it('resultado ambíguo não vira falha reenviável', async () => {
    vi.mocked(graph.reconcile).mockResolvedValue({ outcome: 'unknown', evidence: 'ambiguous' });
    await expect(reconcileDestination(pool as unknown as Pool, 'test', 'post', input({ decision: 'not_published' }), 'owner', graph))
      .rejects.toThrow('publisher_reconciliation_ambiguous');
    expect(pool.connect).not.toHaveBeenCalled();
  });
  it('prova de publicação contradiz declaração de não publicado', async () => {
    await expect(reconcileDestination(pool as unknown as Pool, 'test', 'post', input({ decision: 'not_published' }), 'owner', graph))
      .rejects.toThrow('publisher_already_published');
    expect(pool.connect).not.toHaveBeenCalled();
  });
  it('prova negativa terminal libera só retry explícito, nunca enfileira automaticamente', async () => {
    vi.mocked(graph.reconcile).mockResolvedValue({ outcome: 'not_published', evidence: 'terminal_failure' });
    const result = await reconcileDestination(pool as unknown as Pool, 'test', 'post', input({ decision: 'not_published' }), 'owner', graph);
    expect(result.status).toBe('failed');
    expect(client.query.mock.calls.some(([sql]) => /status='queued'/.test(sql))).toBe(false);
    const update = client.query.mock.calls.find(([sql]) => sql.startsWith('UPDATE ops.publisher_destinations'))!;
    expect(update[1][6]).toBe('publisher_verified_not_published');
  });
  it('abandono encerra sem reenvio, preserva mídia e não depende de disponibilidade da Meta', async () => {
    const result = await reconcileDestination(pool as unknown as Pool, 'test', 'post', input({ decision: 'abandon' }), 'owner', graph);
    expect(result.status).toBe('cancelled');
    expect(graph.reconcile).not.toHaveBeenCalled();
    const postUpdate = client.query.mock.calls.find(([sql]) => sql.startsWith('UPDATE ops.publisher_posts'))!;
    expect(postUpdate[0]).toContain('delete_after_publish=CASE WHEN $4 THEN false');
    expect(postUpdate[1][3]).toBe(true);
    expect(client.query.mock.calls.some(([sql]) => /status='queued'/.test(sql))).toBe(false);
  });
  it('versão antiga não sobrescreve outro operador e faz rollback', async () => {
    postVersion = 4;
    await expect(reconcileDestination(pool as unknown as Pool, 'test', 'post', input(), 'owner', graph))
      .rejects.toThrow('publisher_version_conflict');
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.query.mock.calls.some(([sql]) => sql.startsWith('UPDATE '))).toBe(false);
  });
  it('mudança de estado durante a consulta externa também impede conciliação', async () => {
    currentStatus = 'published';
    await expect(reconcileDestination(pool as unknown as Pool, 'test', 'post', input(), 'owner', graph))
      .rejects.toThrow('publisher_reconciliation_not_allowed');
    expect(client.query.mock.calls.some(([sql]) => sql.startsWith('UPDATE '))).toBe(false);
  });
});
