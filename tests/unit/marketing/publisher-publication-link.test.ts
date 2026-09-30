import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../../src/shared/config/env.js', () => ({ env: {} }));
import { parsePublicationLink } from '../../../src/marketing/publisher/publication-link.js';
import { PublisherGraph, type Delivery } from '../../../src/marketing/publisher/graph.js';
import { META_BUSINESS_ACCOUNTS as accounts } from '../../../src/shared/meta-business-accounts.js';

const config = { enabled: true, publish: true, pageId: accounts.facebook.id, instagramId: accounts.instagram.id,
  token: 'test-only-token', apiVersion: 'v26.0', scopeValid: true };
const fetcher = vi.fn<typeof fetch>();
const json = (body: unknown) => new Response(JSON.stringify(body));
const page = { id: accounts.facebook.id, instagram_business_account: { id: accounts.instagram.id } };
const ig: Delivery = { platform: 'instagram', format: 'reel', account_id: accounts.instagram.id,
  provider_id: null, container_id: '301', media_kind: 'video' };
const fb: Delivery = { ...ig, platform: 'facebook', account_id: accounts.facebook.id, media_kind: 'photo', format: 'feed' };
const graph = () => new PublisherGraph(config, fetcher);
const owned = (id = '302', owner = accounts.instagram.id) => ({ id, owner: { id: owner },
  timestamp: '2026-09-30T12:00:00+0000', permalink: 'https://www.instagram.com/p/ABC_123-/' });
beforeEach(() => fetcher.mockReset());

describe('Links permanentes na conferência', () => {
  it('compara o mesmo código Instagram em p/reel/reels sem rastreamento', () => {
    const links = ['https://instagram.com/p/ABC_123-/', 'https://www.instagram.com/reel/ABC_123-/?igsh=abc',
      'https://www.instagram.com/reels/ABC_123-/#tracking'];
    expect(links.map(link => parsePublicationLink(link, 'instagram').key))
      .toEqual(Array(3).fill('instagram:media:ABC_123-'));
  });
  it.each(['http://instagram.com/p/a/', 'https://instagram.com.evil.test/p/a/',
    'https://instagram.com@evil.test/p/a/', 'https://user:secret@instagram.com/p/a/',
    'https://instagram.com:8443/p/a/', 'https://127.0.0.1/p/a/', 'javascript:alert(1)'])
  ('rejeita link inseguro antes de acessar a Meta: %s', async link => {
    await expect(graph().reconcile(ig, link)).rejects.toThrow('publisher_post_url_invalid');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejeita rede diferente, perfil e link curto sem interpretar como ID', async () => {
    await expect(graph().reconcile(ig, 'https://facebook.com/reel/302')).rejects.toThrow('publisher_post_url_platform');
    await expect(graph().reconcile(ig, 'https://instagram.com/2wp.pneus/')).rejects.toThrow('publisher_post_url_unsupported');
    await expect(graph().reconcile(fb, 'https://facebook.com/share/r/abcdef/')).rejects.toThrow('publisher_post_url_unsupported');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('resolve Reel na conta Instagram e confirma proprietário por nova leitura', async () => {
    fetcher.mockResolvedValueOnce(json(page))
      .mockResolvedValueOnce(json({ data: [{ id: '302', permalink: owned().permalink }] }))
      .mockResolvedValueOnce(json(owned()));
    expect(await graph().reconcile({ ...ig, provider_id: 'old' }, 'https://instagram.com/reel/ABC_123-/?igsh=abc'))
      .toMatchObject({ outcome: 'published', provider_id: '302', url: owned().permalink });
    expect(new URL(String(fetcher.mock.calls[1]![0])).pathname).toBe('/v26.0/' + accounts.instagram.id + '/media');
    expect(new URL(String(fetcher.mock.calls[2]![0])).pathname).toBe('/v26.0/302');
    expect(fetcher.mock.calls.every(([url, options]) => new URL(String(url)).hostname === 'graph.facebook.com'
      && options?.method === 'GET')).toBe(true);
  });
  it('um link encontrado na lista não dispensa a verificação de propriedade', async () => {
    fetcher.mockResolvedValueOnce(json(page))
      .mockResolvedValueOnce(json({ data: [{ id: '302', permalink: owned().permalink }] }))
      .mockResolvedValueOnce(json(owned('302', '999')));
    await expect(graph().reconcile(ig, owned().permalink)).rejects.toThrow('meta_post_owner_mismatch');
  });
  it('página vazia não comprova falha e não reutiliza ID antigo nem container expirado', async () => {
    fetcher.mockResolvedValueOnce(json(page)).mockResolvedValueOnce(json({ data: [] }));
    expect(await graph().reconcile({ ...ig, provider_id: '302' }, owned().permalink))
      .toEqual({ outcome: 'unknown', evidence: 'publication_link_not_found' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('pagina pelo cursor no host fixo, nunca acessando paging.next com credenciais', async () => {
    fetcher.mockResolvedValueOnce(json(page)).mockResolvedValueOnce(json({ data: [],
      paging: { next: 'https://evil.test/?access_token=secret', cursors: { after: 'next-cursor' } } }))
      .mockResolvedValueOnce(json({ data: [{ id: '302', permalink: owned().permalink }] }))
      .mockResolvedValueOnce(json(owned()));
    expect((await graph().reconcile(ig, owned().permalink)).outcome).toBe('published');
    const url = new URL(String(fetcher.mock.calls[2]![0]));
    expect(url.hostname).toBe('graph.facebook.com');
    expect(url.searchParams.get('after')).toBe('next-cursor');
    expect(url.searchParams.has('access_token')).toBe(false);
  });
  it('limita a três páginas e interrompe cursores repetidos', async () => {
    for (const repeated of [false, true]) {
      fetcher.mockReset(); fetcher.mockResolvedValueOnce(json(page));
      let count = 0;
      fetcher.mockImplementation(async () => json({ data: [],
        paging: { next: 'https://graph.facebook.com/ignored', cursors: { after: repeated ? 'same' : String(++count) } } }));
      expect((await graph().reconcile(ig, owned().permalink)).outcome).toBe('unknown');
      expect(fetcher).toHaveBeenCalledTimes(repeated ? 3 : 4);
    }
  });
  it('falha da Meta preserva a incerteza, sem consultar o container para declarar ausência', async () => {
    fetcher.mockResolvedValueOnce(json(page)).mockRejectedValueOnce(Error('test-only-token'));
    await expect(graph().reconcile(ig, owned().permalink)).rejects.toThrow('meta_connection_unknown');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each(['https://www.facebook.com/2wpneus/posts/302/',
    'https://m.facebook.com/permalink.php?story_fbid=302&id=' + accounts.facebook.id,
    'https://www.facebook.com/story.php?story_fbid=302&id=' + accounts.facebook.id])
  ('confirma post Facebook por link numérico com propriedade verificada: %s', async link => {
    const id = accounts.facebook.id + '_302';
    fetcher.mockResolvedValueOnce(json(page)).mockResolvedValueOnce(json({ id, is_published: true,
      from: { id: accounts.facebook.id }, permalink_url: 'https://www.facebook.com/2wpneus/posts/302/' }));
    expect(await graph().reconcile(fb, link)).toMatchObject({ outcome: 'published', provider_id: id });
    expect(new URL(String(fetcher.mock.calls[1]![0])).pathname).toBe('/v26.0/' + id);
  });
  it('resolve link pfbid pela lista fixa da Página e mantém a checagem de propriedade', async () => {
    const url = 'https://www.facebook.com/2wpneus/posts/pfbidABC123/';
    const id = accounts.facebook.id + '_302';
    fetcher.mockResolvedValueOnce(json(page))
      .mockResolvedValueOnce(json({ data: [{ id, permalink_url: url }] }))
      .mockResolvedValueOnce(json({ id, is_published: true, from: { id: accounts.facebook.id }, permalink_url: url }));
    expect((await graph().reconcile(fb, url)).outcome).toBe('published');
    expect(new URL(String(fetcher.mock.calls[1]![0])).pathname).toBe('/v26.0/' + accounts.facebook.id + '/published_posts');
  });
  it.each(['https://www.facebook.com/reel/302/', 'https://facebook.com/watch/?v=302',
    'https://facebook.com/2wpneus/videos/302/'])('confirma Reel Facebook por link de vídeo: %s', async link => {
    fetcher.mockResolvedValueOnce(json(page)).mockResolvedValueOnce(json({ id: '302', from: { id: accounts.facebook.id },
      status: { publishing_phase: { status: 'complete' } }, permalink_url: 'https://www.facebook.com/reel/302/' }));
    expect((await graph().reconcile({ ...fb, format: 'reel', media_kind: 'video' }, link)).outcome).toBe('published');
  });
  it('não aceita vídeo de outra Página nem objeto ainda sem confirmação', async () => {
    fetcher.mockResolvedValueOnce(json(page)).mockResolvedValueOnce(json({ id: '302', from: { id: '999' },
      status: { publishing_phase: { status: 'complete' } } }));
    await expect(graph().reconcile({ ...fb, media_kind: 'video', format: 'reel' }, 'https://facebook.com/reel/302/'))
      .rejects.toThrow('meta_post_owner_mismatch');
    fetcher.mockResolvedValueOnce(json(page)).mockResolvedValueOnce(json({ id: '302', owner: { id: accounts.instagram.id } }))
      .mockResolvedValueOnce(json({ status_code: 'FINISHED' }));
    // O ID numérico continua exigindo a confirmação positiva original.
    expect((await graph().reconcile({ ...ig, provider_id: '302' })).outcome).toBe('unknown');
  });
  it('confirma Story Facebook na lista da Página, mas não usa link de post como Story', async () => {
    fetcher.mockResolvedValueOnce(json(page)).mockResolvedValueOnce(json({ data: [{ id: '302', status: 'PUBLISHED' }] }));
    expect((await graph().reconcile({ ...fb, format: 'story' }, 'https://facebook.com/stories/' + accounts.facebook.id + '/302/')).outcome)
      .toBe('published');
    fetcher.mockResolvedValueOnce(json(page));
    await expect(graph().reconcile({ ...fb, format: 'story' }, 'https://facebook.com/2wpneus/posts/302/'))
      .rejects.toThrow('publisher_post_url_format');
    await expect(graph().reconcile({ ...ig, format: 'story' }, 'https://instagram.com/stories/2wp.pneus/302/'))
      .rejects.toThrow('publisher_post_url_unsupported');
  });
});
