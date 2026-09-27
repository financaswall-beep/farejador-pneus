import Fastify from 'fastify';
import type { Pool } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ query: vi.fn(), list: vi.fn(), detail: vi.fn(), insights: vi.fn() }));
vi.mock('../../../src/marketing/organic/insights.js', () => ({ organicInsights: mocks.insights }));
vi.mock('../../../src/admin/auth.js', () => ({ requireAdminOwner: async (req: any, reply: any) => {
  if (req.headers['x-owner'] !== 'yes') return reply.code(403).send({ error: 'forbidden' });
} }));
vi.mock('../../../src/shared/config/env.js', () => ({ env: { FAREJADOR_ENV: 'test' } }));
vi.mock('../../../src/persistence/db.js', () => ({ pool: { query: mocks.query } }));
vi.mock('../../../src/social-comments/config.js', () => ({ commentsConfig: () => ({ pageId: '100', instagramId: '200', token: 'secret' }) }));
vi.mock('../../../src/social-comments/publications.js', () => ({ readPublications: mocks.list, PublicationsGraph: class { publication = mocks.detail; } }));
import { registerMarketingOrganic } from '../../../src/admin/painel/route-marketing-organic.js';
import { organicPublicationSummary } from '../../../src/admin/painel/queries-marketing-organic.js';
import { MetaCommentError } from '../../../src/social-comments/graph.js';
const base = '/admin/api/marketing/organic/publications';
describe('Conteúdo orgânico — autorização e resumo', () => {
  beforeEach(() => vi.resetAllMocks());
  async function app() { const a = Fastify(); await registerMarketingOrganic(a); return a; }
  it.each([base, base + '/instagram/301', base + '/facebook/100_301/insights?refresh=true'])('nega %s sem owner', async url => {
    const a = await app(); try {
      expect((await a.inject({ url })).statusCode).toBe(403);
      expect(mocks.list).not.toHaveBeenCalled(); expect(mocks.detail).not.toHaveBeenCalled(); expect(mocks.query).not.toHaveBeenCalled();
      expect(mocks.insights).not.toHaveBeenCalled();
    } finally { await a.close(); }
  });
  it('valida atualização de métricas e mantém a conta definida no servidor', async () => {
    const a = await app(); mocks.insights.mockResolvedValue({ rows: [] });
    try {
      for (const query of ['refresh=1', 'refresh=true&account=999']) {
        expect((await a.inject({ url: base + '/facebook/100_301/insights?' + query,
          headers: { 'x-owner': 'yes' } })).statusCode).toBe(400);
      }
      expect(mocks.insights).not.toHaveBeenCalled();
      const result = await a.inject({ url: base + '/facebook/100_301/insights?refresh=true', headers: { 'x-owner': 'yes' } });
      expect(result.statusCode).toBe(200); expect(result.headers['cache-control']).toBe('no-store');
      expect(mocks.insights).toHaveBeenLastCalledWith(expect.anything(), 'facebook', '100', '100_301', true);
      await a.inject({ url: base + '/instagram/301/insights', headers: { 'x-owner': 'yes' } });
      expect(mocks.insights).toHaveBeenLastCalledWith(expect.anything(), 'instagram', '200', '301', false);
    } finally { await a.close(); }
  });
  it('recusa período desconhecido, canal inválido e parâmetros extras', async () => {
    const a = await app(); try {
      for (const url of [base + '?period=all', base + '?account_id=999', base + '/tiktok/301', base + '/instagram/me', base + '/instagram/301?window=all', base + '/instagram/301?account_id=999']) {
        expect((await a.inject({ url, headers: { 'x-owner': 'yes' } })).statusCode).toBe(400);
      }
      expect(mocks.list).not.toHaveBeenCalled(); expect(mocks.detail).not.toHaveBeenCalled();
    } finally { await a.close(); }
  });
  it('uma falha de histórico mantém o post e não inventa zero vendas', async () => {
    mocks.detail.mockResolvedValue({ id: '301', platform: 'instagram', published_at:'2026-09-12T12:00:00Z' }); mocks.query.mockRejectedValue(Error('DB offline'));
    const a = await app(); try {
      const r = await a.inject({ url: base + '/instagram/301', headers: { 'x-owner': 'yes' } });
      expect(r.statusCode).toBe(200); expect(r.headers['cache-control']).toBe('no-store');
      expect(r.json()).toMatchObject({ publication: { id: '301' }, summary: { available: false, comments: null },
        attribution: { status:'disabled', period:{id:'7d',since:'2026-09-12',until:'2026-09-18'}, sales: null, revenue: null, conversations: null, private_messages: null } });
      expect(mocks.detail).toHaveBeenCalledWith('instagram', '200', '301');
    } finally { await a.close(); }
  });
  it('verifica dono antes de ler comentários do banco', async () => {
    mocks.detail.mockRejectedValue(new MetaCommentError('meta_post_owner_mismatch'));
    const a = await app(); try {
      expect((await a.inject({ url: base + '/facebook/100_301', headers: { 'x-owner': 'yes' } })).statusCode).toBe(404);
      expect(mocks.query).not.toHaveBeenCalled();
    } finally { await a.close(); }
  });
  it('resume apenas ambiente, rede, conta e publicação exatos, usando a mesma chave no join', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ ready: true }] })
      .mockResolvedValueOnce({ rows: [{ received: 2, replied: 1, pending: 1, failed: 0 }] })
      .mockResolvedValueOnce({ rows: [{ date: '2026-09-27', received: 1 }, { date: '2026-09-26', received: 1 }] });
    const result = await organicPublicationSummary({ query } as unknown as Pool, 'test', 'instagram', '200', '301');
    expect(result.comments.received).toBe(2); expect(result.series[0].date).toBe('2026-09-26');
    for (const [sql, values] of query.mock.calls.slice(1)) {
      expect(values).toEqual(['test', 'instagram', '200', '301']);
      for (const clause of ['c.environment=$1', 'c.platform=$2', 'c.account_id=$3', 'c.post_id=$4']) expect(sql).toContain(clause);
    }
    expect(query.mock.calls[1]![0]).toContain('a.environment=c.environment AND a.comment_id=c.id');
  });
});
