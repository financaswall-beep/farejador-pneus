import { beforeEach, describe, it, expect, vi } from 'vitest';
vi.mock('../../../src/shared/config/env.js', () => ({ env: {} }));
import { PublisherGraph, type Delivery } from '../../../src/marketing/publisher/graph.js';
import { META_BUSINESS_ACCOUNTS as accounts } from '../../../src/shared/meta-business-accounts.js';
const config = { enabled: true, publish: true, pageId: accounts.facebook.id, instagramId: accounts.instagram.id,
  token: 'secret-page', appId: '77', appSecret: 'app-secret', apiVersion: 'v26.0', scopeValid: true };
const fetcher = vi.fn<typeof fetch>();
const json = (body: unknown) => new Response(JSON.stringify(body));
const task = (extra: Partial<Delivery> = {}): Delivery => ({
  platform: 'instagram', format: 'reel', caption: 'Pneus', account_id: accounts.instagram.id,
  container_id: '301', provider_id: '302', media_kind: 'video', ...extra,
});
const page = { id: accounts.facebook.id, instagram_business_account: { id: accounts.instagram.id } };
const scopes = ['pages_read_engagement', 'pages_manage_posts', 'instagram_basic', 'instagram_content_publish'];
function preflight(extra: Record<string, unknown> = {}) {
  fetcher.mockResolvedValueOnce(json(page))
    .mockResolvedValueOnce(json({ data: { is_valid: true, app_id: '77', expires_at: 0, scopes, ...extra } }));
}
beforeEach(() => fetcher.mockReset());

describe('Publicação Meta nas contas fixadas', () => {
  it('cria container IG sem publicar e utiliza token da Página após validar permissões', async () => {
    preflight(); fetcher.mockResolvedValueOnce(json({ id: '301' }));
    const graph = new PublisherGraph(config, fetcher);
    expect(await graph.prepare(task(), 'https://project.supabase.co/signed')).toBe('301');
    const call = fetcher.mock.calls[2]!;
    expect(String(call[0])).toContain('/' + accounts.instagram.id + '/media');
    const body = new URLSearchParams(String(call[1]?.body));
    expect(body.get('media_type')).toBe('REELS');
    expect(body.get('video_url')).toContain('/signed');
    expect(call[1]?.headers).toMatchObject({ Authorization: 'Bearer secret-page' });
  });
  it('não envia legenda de Story como sobreposição nem aceita conta diferente', async () => {
    const graph = new PublisherGraph(config, fetcher);
    await expect(graph.prepare(task({ account_id: '999' }), 'https://source.test')).rejects.toThrow('meta_account_not_allowed');
    expect(fetcher).not.toHaveBeenCalled();
    preflight(); fetcher.mockResolvedValueOnce(json({ id: '301' }));
    await graph.prepare(task({ format: 'story', media_kind: 'photo' }), 'https://project.supabase.co/signed');
    const body = new URLSearchParams(String(fetcher.mock.calls[2]?.[1]?.body));
    expect(body.get('media_type')).toBe('STORIES');
    expect(body.has('caption')).toBe(false);
    expect(body.has('image_url')).toBe(true);
  });
  it('espera FINISHED e classifica timeout público como incerto', async () => {
    const graph = new PublisherGraph(config, fetcher);
    fetcher.mockResolvedValueOnce(json({ status_code: 'IN_PROGRESS' })).mockResolvedValueOnce(json({ status_code: 'FINISHED' }));
    expect(await graph.ready(task())).toBe(false);
    expect(await graph.ready(task())).toBe(true);
    fetcher.mockRejectedValueOnce(Error('secret-page must not leak'));
    await expect(graph.publish(task())).rejects.toMatchObject({ code: 'meta_connection_unknown', uncertain: true });
  });
  it('confirma publicação por leitura antes de considerar o envio concluído', async () => {
    fetcher.mockResolvedValue(json({ id: '302', timestamp: '2026-09-30T09:00:00+0000', permalink: 'https://www.instagram.com/p/test/' }));
    expect(await new PublisherGraph(config, fetcher).verify(task())).toEqual({
      confirmed: true, url: 'https://www.instagram.com/p/test/',
    });
  });
  it('usa endpoint de upload fixo e só conclui Reel FB quando publishing_phase termina', async () => {
    const graph = new PublisherGraph(config, fetcher);
    const d = task({ platform: 'facebook', account_id: accounts.facebook.id });
    preflight();
    fetcher.mockResolvedValueOnce(json({ video_id: '301', upload_url: 'https://evil.test' }))
      .mockResolvedValueOnce(json({ success: true }));
    await graph.prepare(d, 'https://project.supabase.co/signed');
    expect(String(fetcher.mock.calls[3]?.[0])).toBe('https://rupload.facebook.com/video-upload/v26.0/301');
    fetcher.mockResolvedValueOnce(json({ success: true }));
    expect(await graph.publish(d)).toBe('301');
    fetcher.mockResolvedValueOnce(json({ status: { publishing_phase: { status: 'not_started' } } }))
      .mockResolvedValueOnce(json({ status: { publishing_phase: { status: 'complete' } }, permalink_url: 'https://www.facebook.com/reel/301' }));
    expect((await graph.verify(d)).confirmed).toBe(false);
    expect((await graph.verify(d)).confirmed).toBe(true);
  });
  it('publica foto Facebook Feed em duas etapas e confirma is_published', async () => {
    const graph = new PublisherGraph(config, fetcher);
    const d = task({ platform: 'facebook', account_id: accounts.facebook.id, media_kind: 'photo', format: 'feed' });
    preflight(); fetcher.mockResolvedValueOnce(json({ id: '301' }));
    expect(await graph.prepare(d, 'https://project.supabase.co/photo')).toBe('301');
    expect(new URLSearchParams(String(fetcher.mock.calls[2]?.[1]?.body)).get('published')).toBe('false');
    fetcher.mockResolvedValueOnce(json({ id: '302' }));
    expect(await graph.publish(d)).toBe('302');
    const call = fetcher.mock.calls[3]!;
    expect(String(call[0])).toContain('/' + accounts.facebook.id + '/feed');
    const body = new URLSearchParams(String(call[1]?.body));
    expect(JSON.parse(body.get('attached_media')!)).toEqual([{ media_fbid: '301' }]);
    expect(body.get('message')).toBe('Pneus');
    fetcher.mockResolvedValueOnce(json({ id: '302', is_published: true }));
    expect((await graph.verify(d)).confirmed).toBe(true);
  });
  it('publica foto Facebook Story e confere a listagem da Página', async () => {
    const graph = new PublisherGraph(config, fetcher);
    const d = task({ platform: 'facebook', account_id: accounts.facebook.id, media_kind: 'photo', format: 'story' });
    preflight(); fetcher.mockResolvedValueOnce(json({ id: '301' }));
    await graph.prepare(d, 'https://project.supabase.co/photo');
    fetcher.mockResolvedValueOnce(json({ success: true, post_id: '302' }));
    expect(await graph.publish(d)).toBe('302');
    const call = fetcher.mock.calls[3]!;
    expect(String(call[0])).toContain('/photo_stories');
    expect(new URLSearchParams(String(call[1]?.body)).get('photo_id')).toBe('301');
    fetcher.mockResolvedValueOnce(json({ data: [{ id: '302', media_id: '301', status: 'PUBLISHED' }] }));
    expect((await graph.verify(d)).confirmed).toBe(true);
  });
  it('publica vídeo Facebook Story e não trata confirmação vazia como sucesso', async () => {
    const graph = new PublisherGraph(config, fetcher);
    const d = task({ platform: 'facebook', account_id: accounts.facebook.id, format: 'story' });
    preflight();
    fetcher.mockResolvedValueOnce(json({ video_id: '301' })).mockResolvedValueOnce(json({ success: true }));
    await graph.prepare(d, 'https://project.supabase.co/video');
    fetcher.mockResolvedValueOnce(json({ success: true }));
    expect(await graph.publish(d)).toBe('301');
    const call = fetcher.mock.calls[4]!;
    expect(String(call[0])).toContain('/video_stories');
    expect(new URLSearchParams(String(call[1]?.body)).get('video_state')).toBe('PUBLISHED');
    fetcher.mockResolvedValueOnce(json({ data: [] }));
    expect((await graph.verify(d)).confirmed).toBe(false);
  });
});

describe('Permissões e conciliação', () => {
  it('bloqueia falta de scope antes de qualquer escrita', async () => {
    preflight({ scopes: ['pages_read_engagement', 'instagram_basic'] });
    await expect(new PublisherGraph(config, fetcher).prepare(task(), 'https://project.test/signed'))
      .rejects.toThrow('publisher_permissions_missing');
    expect(fetcher.mock.calls.every(call => call[1]?.method === 'GET')).toBe(true);
  });
  it('bloqueia token expirado, app diferente e alvo de autorização diferente', async () => {
    for (const fields of [{ expires_at: 1 }, { app_id: 'other' }, {
      granular_scopes: [{ scope: 'instagram_content_publish', target_ids: ['other'] }],
    }]) {
      fetcher.mockReset(); preflight(fields);
      await expect(new PublisherGraph(config, fetcher).assertPermissions(task())).rejects.toThrow();
      expect(fetcher).toHaveBeenCalledTimes(2);
    }
  });
  it('conta reconhecida sem debug_token não é indicada como autorizada a publicar', async () => {
    fetcher.mockImplementation(async () => json(page));
    const result = await new PublisherGraph({ ...config, appSecret: undefined }, fetcher).connections();
    expect(result.every(row => row.verified && !row.publish_allowed && !row.permissions_checked)).toBe(true);
  });
  it('exige propriedade da conta para conciliar um ID informado', async () => {
    fetcher.mockResolvedValueOnce(json(page))
      .mockResolvedValueOnce(json({ id: '302', timestamp: '2026-09-30', owner: { id: 'another' } }));
    await expect(new PublisherGraph(config, fetcher).reconcile(task())).rejects.toThrow('meta_post_owner_mismatch');
  });
  it('aceita publicação confirmada e pertencente à conta', async () => {
    fetcher.mockResolvedValueOnce(json(page)).mockResolvedValueOnce(json({
      id: '302', timestamp: '2026-09-30', owner: { id: accounts.instagram.id }, permalink: 'https://www.instagram.com/p/test/',
    }));
    expect(await new PublisherGraph(config, fetcher).reconcile(task())).toMatchObject({
      outcome: 'published', provider_id: '302', evidence: 'provider_published_owned',
    });
  });
  it('não usa ausência de Story nem estado pronto como prova de não publicação', async () => {
    fetcher.mockResolvedValueOnce(json(page)).mockResolvedValueOnce(json({ data: [] }))
      .mockResolvedValueOnce(json({ status: { publishing_phase: { status: 'not_started' } } }));
    const fb = task({ platform: 'facebook', account_id: accounts.facebook.id, format: 'story' });
    expect((await new PublisherGraph(config, fetcher).reconcile(fb)).outcome).toBe('unknown');
    fetcher.mockResolvedValueOnce(json(page)).mockResolvedValueOnce(json({ status_code: 'FINISHED' }));
    expect((await new PublisherGraph(config, fetcher).reconcile(task({ provider_id: null }))).outcome).toBe('unknown');
  });
  it('aceita prova negativa somente nos estados terminais sem publicação confirmada', async () => {
    fetcher.mockResolvedValueOnce(json(page)).mockResolvedValueOnce(json({ status_code: 'EXPIRED' }));
    expect((await new PublisherGraph(config, fetcher).reconcile(task({ provider_id: null }))).outcome).toBe('not_published');
    fetcher.mockResolvedValueOnce(json(page)).mockResolvedValueOnce(json({ status: { publishing_phase: { status: 'error' } } }));
    const fb = task({ platform: 'facebook', account_id: accounts.facebook.id, provider_id: null });
    expect((await new PublisherGraph(config, fetcher).reconcile(fb)).outcome).toBe('not_published');
  });
});
