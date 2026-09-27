import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../../src/shared/config/env.js', () => ({ env: {} }));
import { clearOrganicInsightsCache, insightValue, InsightsGraph, organicInsights } from '../../../src/marketing/organic/insights.js';

const config = { enabled: false, publish: false, pageId: '100', instagramId: '200', token: 'private-token', apiVersion: 'v26.0' };
const me = { id: '100', instagram_business_account: { id: '200' } };
const ig = { id: '301', owner: { id: '200' }, media_type: 'IMAGE', timestamp: '2026-09-26T12:00:00Z' };
const fb = { id: '100_302', from: { id: '100' }, created_time: '2026-09-26T12:00:00Z' };
const denied = (code = 10) => Response.json({ error: { code, message: 'sensitive private-token detail' } }, { status: 400 });
function transport(read: (url: URL) => Response) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.pathname.endsWith('/me')) return Response.json(me);
    if (url.searchParams.get('fields')?.includes('owner')) return Response.json(ig);
    if (url.searchParams.get('fields')?.includes('from')) return Response.json(fb);
    return read(url);
  });
}
const row = (data: Awaited<ReturnType<InsightsGraph['read']>>, metric: string) => data.rows.find(r => r.metric === metric)!;

describe('Métricas de publicações nas duas redes', () => {
  beforeEach(() => clearOrganicInsightsCache());
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('mantém curtidas e comentários do Instagram quando Insights não é autorizado', async () => {
    const fetcher = transport(url => url.searchParams.get('fields') === 'like_count,comments_count'
      ? Response.json({ like_count: 2, comments_count: 17 }) : denied());
    const result = await new InsightsGraph(config, fetcher).read('instagram', '200', '301');
    expect(row(result, 'likes')).toMatchObject({ value: 2, reason: null, message: null });
    expect(row(result, 'comments').value).toBe(17);
    expect(row(result, 'views')).toMatchObject({ value: null, reason: 'meta_http_400_code_10',
      message: 'A Meta não autorizou a leitura desta métrica.' });
    expect(result.notice).toContain('autorização na Meta');
    expect(fetcher.mock.calls.some(([url]) => new URL(String(url)).searchParams.get('metric') === 'likes')).toBe(false);
    expect(JSON.stringify(result)).not.toContain('private-token');
  });

  it('preserva zero e consulta Insights apenas para o contador básico ausente', async () => {
    const fetcher = transport(url => {
      if (url.searchParams.get('fields')) return Response.json({ like_count: 0 });
      const metric = url.searchParams.get('metric');
      return Response.json({ data: [{ name: metric, values: [{ value: metric === 'comments' ? 5 : 0 }] }] });
    });
    const result = await new InsightsGraph(config, fetcher).read('instagram', '200', '301');
    expect(row(result, 'likes').value).toBe(0); expect(row(result, 'comments').value).toBe(5);
    expect(result.notice).toBeNull();
    const requested = fetcher.mock.calls.map(([url]) => new URL(String(url)).searchParams.get('metric'));
    expect(requested).not.toContain('likes'); expect(requested).toContain('comments');
  });

  it('recupera os contadores pelos Insights se os campos básicos falharem', async () => {
    const fetcher = transport(url => url.searchParams.get('fields') ? denied()
      : Response.json({ data: [{ name: url.searchParams.get('metric'), total_value: { value: 4 } }] }));
    const result = await new InsightsGraph(config, fetcher).read('instagram', '200', '301');
    expect(row(result, 'likes').value).toBe(4); expect(row(result, 'comments').value).toBe(4);
    expect(result.notice).toBeNull();
  });

  it('separa curtidas das demais reações no Facebook, sem somar os contadores', async () => {
    const fetcher = transport(url => {
      const fields = url.searchParams.get('fields');
      if (fields?.includes('type(LIKE)')) return Response.json({ reactions: { summary: { total_count: 1 } } });
      if (fields?.startsWith('reactions')) return Response.json({ reactions: { summary: { total_count: 3 } } });
      if (fields?.startsWith('comments')) return Response.json({ comments: { summary: { total_count: 7 } } });
      if (fields === 'shares') return Response.json({ shares: { count: 0 } });
      return denied(200);
    });
    const result = await new InsightsGraph(config, fetcher).read('facebook', '100', '100_302');
    expect(row(result, 'likes').value).toBe(1); expect(row(result, 'reactions').value).toBe(3);
    expect(row(result, 'comments').value).toBe(7); expect(row(result, 'shares').value).toBe(0);
    expect(row(result, 'post_media_view').value).toBeNull();
    for (const [url] of fetcher.mock.calls) {
      expect(new URL(String(url)).hostname).toBe('graph.facebook.com');
      expect(String(url)).not.toContain('private-token');
    }
  });

  it('não confunde dados ausentes, formato indisponível e falha temporária com zero', async () => {
    const fetcher = transport(url => {
      const field = url.searchParams.get('fields');
      if (field?.includes('type(LIKE)')) return denied(100);
      if (field?.startsWith('comments')) return Response.json({ comments: { summary: { total_count: '3' } } });
      if (field?.startsWith('reactions')) throw new Error('network secret');
      return Response.json({ data: [] });
    });
    const result = await new InsightsGraph(config, fetcher).read('facebook', '100', '100_302');
    expect(result.rows.every(r => r.value === null)).toBe(true);
    expect(row(result, 'likes').message).toContain('esta consulta');
    expect(row(result, 'reactions').message).toContain('Tente atualizar');
    expect(row(result, 'shares').reason).toBe('not_provided');
    expect(result.notice).toBeNull();
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('não expõe tokens nem mensagens brutas quando a credencial expira durante a consulta', async () => {
    const result = await new InsightsGraph(config, transport(() => denied(190))).read('instagram', '200', '301');
    expect(result.rows.every(r => r.message?.startsWith('Reconecte a conta'))).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private-token');
  });

  it('nega métricas de outro dono antes de consultar qualquer contador', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(me))
      .mockResolvedValueOnce(Response.json({ ...ig, owner: { id: '999' } }));
    await expect(new InsightsGraph(config, fetcher).read('instagram', '200', '301'))
      .rejects.toMatchObject({ code: 'meta_post_owner_mismatch' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    await expect(new InsightsGraph({ ...config, scopeValid: false }, fetcher).read('instagram', '200', '301'))
      .rejects.toMatchObject({ code: 'meta_account_not_allowed' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('atualização manual renova os dados e o cache nunca reaproveita autorização diferente', async () => {
    let likes = 1;
    const fetcher = transport(url => url.searchParams.get('fields') === 'like_count,comments_count'
      ? Response.json({ like_count: likes, comments_count: 0 }) : Response.json({ data: [] }));
    vi.stubGlobal('fetch', fetcher);
    const first = await organicInsights(config, 'instagram', '200', '301');
    likes = 2; fetcher.mockClear();
    expect(await organicInsights(config, 'instagram', '200', '301')).toBe(first);
    expect(fetcher).not.toHaveBeenCalled();
    expect(row(await organicInsights(config, 'instagram', '200', '301', true), 'likes').value).toBe(2);
    await expect(organicInsights({ ...config, scopeValid: false }, 'instagram', '200', '301'))
      .rejects.toMatchObject({ code: 'meta_account_not_allowed' });
    await expect(organicInsights({ ...config, pageId: '999' }, 'instagram', '200', '301'))
      .rejects.toMatchObject({ code: 'meta_token_page_mismatch' });
  });

  it('não soma séries temporais ou converte valores inválidos em métricas', () => {
    for (const value of [null, -1, '2', Infinity, NaN, {}]) {
      expect(insightValue({ data: [{ name: 'views', total_value: { value } }] }, 'views')).toBeNull();
    }
    expect(insightValue({ data: [{ name: 'views', values: [{ value: 1 }, { value: 2 }] }] }, 'views')).toBeNull();
    expect(insightValue({ data: [{ name: 'views', values: [{ value: 0 }] }] }, 'views')).toBe(0);
  });
});
