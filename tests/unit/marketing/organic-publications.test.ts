import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../../src/shared/config/env.js', () => ({ env: {} }));
import { clearPublicationsCache, parsePublication, PublicationsGraph, readPublications } from '../../../src/social-comments/publications.js';
const config = { enabled: false, publish: false, pageId: '100', instagramId: '200', token: 'private-token', apiVersion: 'v26.0' };
const ig = (extra = {}) => ({ id: '301', owner: { id: '200' }, caption: 'Pneu NMAX\n130/70-13', media_type: 'IMAGE',
  timestamp: '2026-09-26T12:00:00Z', media_url: 'https://scontent.cdninstagram.com/a.jpg', permalink: 'https://www.instagram.com/p/a/', ...extra });
const fb = { id: '100_302', from: { id: '100' }, message: 'Pneu carro', created_time: '2026-09-26T13:00:00Z',
  full_picture: 'https://scontent.fbcdn.net/b.jpg', attachments: { data: [{ media_type: 'photo' }] } };
const me = { id: '100', instagram_business_account: { id: '200' } };
describe('Publicações orgânicas — leitura limitada às contas autorizadas', () => {
  beforeEach(() => clearPublicationsCache());
  it('normaliza imagem, carrossel e reel sem usar vídeo como miniatura', () => {
    expect(parsePublication(ig(), 'instagram', '200')).toMatchObject({ format: 'image', title: 'Pneu NMAX', image_url: ig().media_url });
    expect(parsePublication(ig({ media_type: 'CAROUSEL_ALBUM' }), 'instagram', '200')?.format).toBe('carousel');
    expect(parsePublication(ig({ media_type: 'VIDEO', media_product_type: 'REELS' }), 'instagram', '200'))
      .toMatchObject({ format: 'reel', image_url: null });
    expect(parsePublication(fb, 'facebook', '100')?.format).toBe('image');
  });
  it('recusa conta diferente, anúncio não publicado, data inválida e mídia externa', () => {
    expect(parsePublication(ig(), 'instagram', '999')).toBeNull();
    expect(parsePublication(ig({ media_product_type: 'AD' }), 'instagram', '200')).toBeNull();
    expect(parsePublication(ig({ timestamp: 'bad' }), 'instagram', '200')).toBeNull();
    expect(parsePublication(ig({ media_url: 'https://evil.test/pixel', permalink: 'javascript:alert(1)' }), 'instagram', '200'))
      .toMatchObject({ image_url: null, url: null });
  });
  it('pagina somente no host fixo e para ao atingir o período', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(me))
      .mockResolvedValueOnce(Response.json({ data: [ig()], paging: { next: 'https://evil.test/?access_token=private-token', cursors: { after: 'cursor1' } } }))
      .mockResolvedValueOnce(Response.json({ data: [ig({ id: '302', timestamp: '2026-08-01T12:00:00Z' })], paging: { next: 'anything', cursors: { after: 'cursor2' } } }));
    const result = await new PublicationsGraph(config, fetcher).publications('instagram', '200', '2026-09-01');
    expect(result.rows).toHaveLength(1); expect(result.truncated).toBe(false);
    for (const [url, options] of fetcher.mock.calls) {
      expect(url.hostname).toBe('graph.facebook.com'); expect(url.href).not.toContain('private-token');
      expect(options.method).toBe('GET'); expect(options.redirect).toBe('error');
    }
    expect(fetcher.mock.calls[2]![0].searchParams.get('after')).toBe('cursor1');
  });
  it('explicita lista truncada ao alcançar o limite e deduplica IDs', async () => {
    let n = 0;
    const fetcher = vi.fn(async (url: URL) => Response.json(url.pathname.endsWith('/me') ? me : {
      data: [ig()], paging: { next: 'ignored', cursors: { after: String(++n) } },
    }));
    const result = await new PublicationsGraph(config, fetcher as any).publications('instagram', '200', '2026-09-01');
    expect(result).toMatchObject({ truncated: true }); expect(result.rows).toHaveLength(1); expect(n).toBe(3);
  });
  it('mantém a rede disponível quando a outra falha sem vazar a mensagem do provedor', async () => {
    const fetcher = vi.fn(async (url: URL) => url.pathname.endsWith('/me') ? Response.json(me)
      : url.pathname.endsWith('/media') ? Response.json({ error: { code: 10, message: 'private-token' } }, { status: 400 })
      : Response.json({ data: [fb] }));
    const result = await readPublications(config, 'test', '2026-09-01', fetcher as any);
    expect(result.rows).toHaveLength(1);
    expect(result.sources).toContainEqual({ platform: 'instagram', status: 'unavailable', error: 'meta_http_400_code_10', truncated: false });
    expect(JSON.stringify(result)).not.toContain('private-token');
  });
  it('cache não mistura ambientes ou credenciais e junta solicitações simultâneas', async () => {
    const fetcher = vi.fn(async (url: URL) => Response.json(url.pathname.endsWith('/me') ? me : { data: [] }));
    await Promise.all([1, 2].map(() => readPublications(config, 'test', '2026-09-01', fetcher as any)));
    expect(fetcher).toHaveBeenCalledTimes(4);
    await readPublications(config, 'prod', '2026-09-01', fetcher as any); expect(fetcher).toHaveBeenCalledTimes(8);
    await readPublications({ ...config, token: 'different' }, 'prod', '2026-09-01', fetcher as any); expect(fetcher).toHaveBeenCalledTimes(12);
  });
  it('não consulta a Meta com escopo inválido e nega detalhes de outro dono', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(me)).mockResolvedValueOnce(Response.json(ig({ owner: { id: '999' } })));
    const result = await readPublications({ ...config, scopeValid: false }, 'test', '2026-09-01', fetcher);
    expect(result.sources.every(s => s.status === 'unavailable')).toBe(true); expect(fetcher).not.toHaveBeenCalled();
    await expect(new PublicationsGraph(config, fetcher).publication('instagram', '200', '301'))
      .rejects.toMatchObject({ code: 'meta_post_owner_mismatch' });
    await expect(new PublicationsGraph(config, fetcher).publication('instagram', '200', '../me'))
      .rejects.toMatchObject({ code: 'meta_invalid_path' });
  });
});
